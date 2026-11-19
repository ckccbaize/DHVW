// dhvw-shell：设备端离线只读静态壳。
//
// 职责（docs/DEVICE-DESIGN.md §9）：
//   - 只监听回环地址，只读，无目录列表，拒绝路径逃逸
//   - ETag + 304；index.html / manifest.json / config.json 不缓存，/assets/ 与 /js/ 长缓存
//   - 无扩展名路径回退 index.html（SPA）
//   - 启动时按 manifest.json 校验资源包（缺失 / 尺寸不符），/__health 暴露结果
//
// 设备端不允许 Python / Node 运行时，因此用 Go 单文件交叉编译。
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

const version = "0.1.0"

// mimeTypes 只列资源包真正会出现的类型，避免依赖平台 mime 数据库。
var mimeTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".mjs":         "text/javascript; charset=utf-8",
	".css":         "text/css; charset=utf-8",
	".json":        "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".png":         "image/png",
	".webp":        "image/webp",
	".jpg":         "image/jpeg",
	".jpeg":        "image/jpeg",
	".svg":         "image/svg+xml",
	".ico":         "image/x-icon",
	".woff2":       "font/woff2",
	".txt":         "text/plain; charset=utf-8",
	".map":         "application/json; charset=utf-8",
}

type manifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Version string         `json:"version"`
	BuiltAt string         `json:"built_at"`
	Files   []manifestFile `json:"files"`
}

type packStatus struct {
	Checked bool     `json:"checked"`
	Files   int      `json:"files"`
	Missing []string `json:"missing"`
	SizeBad []string `json:"size_bad"`
	HashBad []string `json:"hash_bad"`
}

// hostConfig 由 PC 通过局域网配对写入，页面启动时读取并续连。
type hostConfig struct {
	WSURL     string `json:"wsUrl"`
	ProbeURL  string `json:"probeUrl,omitempty"`
	Name      string `json:"name,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

type server struct {
	root       string
	dataDir    string
	hostFile   string
	caFile     string
	defaultWS  string
	apikeyDir  string
	noCache    bool
	version    string
	started    time.Time
	pack       packStatus
	verifyHash bool
	hits       atomic.Int64
	httpClient *http.Client
	llmMu      sync.RWMutex
	llmClient  *http.Client
	qqMu       sync.Mutex
	qqCmd      *exec.Cmd
}

func (s *server) rebuildLLMClient() {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	hasExtra := false
	for _, p := range []string{s.caFile, strings.TrimSpace(os.Getenv("DHVW_GATEWAY_CA"))} {
		if p == "" {
			continue
		}
		if pemBytes, err := os.ReadFile(p); err == nil && len(pemBytes) > 0 {
			if pool.AppendCertsFromPEM(pemBytes) {
				hasExtra = true
			}
		}
	}
	client := &http.Client{Timeout: 120 * time.Second}
	if hasExtra {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:    pool,
				MinVersion: tls.VersionTLS12,
			},
		}
	}
	s.llmMu.Lock()
	s.llmClient = client
	s.llmMu.Unlock()
}

func (s *server) getLLMClient() *http.Client {
	s.llmMu.RLock()
	c := s.llmClient
	s.llmMu.RUnlock()
	if c != nil {
		return c
	}
	return s.httpClient
}

func newServer(root, ver string, verifyHash bool, apikeyDir string) (*server, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("root 不是目录: %s", abs)
	}
	dataDir := filepath.Join(filepath.Dir(abs), "data")
	s := &server{
		root:       abs,
		dataDir:    dataDir,
		hostFile:   filepath.Join(dataDir, "host.json"),
		caFile:     filepath.Join(dataDir, "ca.crt.pem"),
		apikeyDir:  apikeyDir,
		version:    ver,
		started:    time.Now(),
		verifyHash: verifyHash,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
	s.rebuildLLMClient()
	s.pack = s.checkPack()
	return s, nil
}

// checkPack 读 manifest.json 校验资源包。缺 manifest 不算致命：记 checked=false。
func (s *server) checkPack() packStatus {
	st := packStatus{Missing: []string{}, SizeBad: []string{}, HashBad: []string{}}
	raw, err := os.ReadFile(filepath.Join(s.root, "manifest.json"))
	if err != nil {
		return st
	}
	var m manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		st.Missing = append(st.Missing, "manifest.json: 解析失败")
		return st
	}
	st.Checked = true
	st.Files = len(m.Files)
	for _, f := range m.Files {
		p := filepath.Join(s.root, filepath.FromSlash(f.Path))
		fi, err := os.Stat(p)
		if err != nil || fi.IsDir() {
			st.Missing = append(st.Missing, f.Path)
			continue
		}
		if f.Size > 0 && fi.Size() != f.Size {
			st.SizeBad = append(st.SizeBad, f.Path)
			continue
		}
		if s.verifyHash && f.SHA256 != "" {
			if got, err := fileSHA256(p); err != nil || got != f.SHA256 {
				st.HashBad = append(st.HashBad, f.Path)
			}
		}
	}
	return st
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// resolve 把 URL 路径映射到 root 下的文件路径；越界返回错误。
func (s *server) resolve(urlPath string) (string, error) {
	p := path.Clean("/" + urlPath)
	if strings.Contains(p, "\x00") {
		return "", errors.New("非法路径")
	}
	fsPath := filepath.Join(s.root, filepath.FromSlash(p))
	rel, err := filepath.Rel(s.root, fsPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("路径逃逸")
	}
	return fsPath, nil
}

func cacheControl(p string) string {
	switch {
	case strings.HasPrefix(p, "/assets/"):
		return "public, max-age=31536000, immutable"
	case strings.HasPrefix(p, "/js/"), strings.HasPrefix(p, "/css/"):
		// 代码必须可升级：ETag 重验证，避免设备更新后仍跑旧模块。
		return "no-cache"
	default:
		return "no-cache"
	}
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// LLM 代理是 POST，必须在通用 GET/HEAD 限制之前路由
	if r.URL.Path == "/__llm/chat/completions" {
		s.serveLLMProxy(w, r)
		return
	}
	if r.URL.Path == "/__llm/config" {
		s.serveLlmConfig(w, r)
		return
	}
	if r.URL.Path == "/__digest" {
		s.serveDigest(w, r)
		return
	}
	if r.URL.Path == "/__state" {
		s.serveState(w, r)
		return
	}
	if r.URL.Path == "/__host" {
		s.serveHost(w, r)
		return
	}
	if r.URL.Path == "/__fetch" {
		s.serveFetch(w, r)
		return
	}
	if r.URL.Path == "/__search" {
		s.serveSearch(w, r)
		return
	}
	if r.URL.Path == "/__qq/health" || r.URL.Path == "/__qq/config" || r.URL.Path == "/__qq/rebind" || r.URL.Path == "/__qq/boost" || r.URL.Path == "/__qq/proactive/trigger" {
		s.serveQqProxy(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.hits.Add(1)

	if r.URL.Path == "/__health" {
		s.serveHealth(w, r)
		return
	}
	if r.URL.Path == "/__image/search" {
		s.serveImageSearch(w, r)
		return
	}
	if r.URL.Path == "/__image/fetch" {
		s.serveImageFetch(w, r)
		return
	}
	if r.URL.Path == "/__llm/chat/completions" {
		s.serveLLMProxy(w, r)
		return
	}

	urlPath := r.URL.Path
	fsPath, err := s.resolve(urlPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}

	fi, statErr := os.Stat(fsPath)
	if statErr == nil && fi.IsDir() {
		// 无目录列表：只有 index.html 可服务
		idx := filepath.Join(fsPath, "index.html")
		if st, err := os.Stat(idx); err == nil && !st.IsDir() {
			s.serveFile(w, r, "/index.html", idx, st)
			return
		}
		http.NotFound(w, r)
		return
	}
	if statErr != nil {
		// SPA 回退：无扩展名路径交给前端路由
		if path.Ext(urlPath) == "" {
			idx := filepath.Join(s.root, "index.html")
			if st, err := os.Stat(idx); err == nil {
				s.serveFile(w, r, "/index.html", idx, st)
				return
			}
		}
		http.NotFound(w, r)
		return
	}
	s.serveFile(w, r, urlPath, fsPath, fi)
}

func (s *server) serveFile(w http.ResponseWriter, r *http.Request, urlPath, fsPath string, fi os.FileInfo) {
	etag := fmt.Sprintf(`W/"%d-%d"`, fi.Size(), fi.ModTime().UnixNano())
	h := w.Header()
	h.Set("ETag", etag)
	cc := cacheControl(urlPath)
	if s.noCache {
		cc = "no-cache"
	}
	h.Set("Cache-Control", cc)
	h.Set("X-Content-Type-Options", "nosniff")
	if ct, ok := mimeTypes[strings.ToLower(filepath.Ext(fsPath))]; ok {
		h.Set("Content-Type", ct)
	}
	if inm := r.Header.Get("If-None-Match"); inm != "" && etagMatches(inm, etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	f, err := os.Open(fsPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	h.Set("Content-Length", strconv.FormatInt(fi.Size(), 10))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	// ServeContent 处理 Range / HEAD / 错误；已设 Content-Length 时它会复用。
	http.ServeContent(w, r, fi.Name(), fi.ModTime(), f)
}

// readHostConfig 读取 PC 配对写入的主机地址；不存在时返回 nil。
func (s *server) readHostConfig() *hostConfig {
	raw, err := os.ReadFile(s.hostFile)
	if err != nil {
		return nil
	}
	var cfg hostConfig
	if err := json.Unmarshal(raw, &cfg); err != nil || strings.TrimSpace(cfg.WSURL) == "" {
		return nil
	}
	return &cfg
}

func (s *server) writeHostConfig(cfg hostConfig) error {
	if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
		return err
	}
	cfg.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.hostFile + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.hostFile)
}

// serveHost 只服务本机回环，页面用它读取 PC 配对结果；本机模拟模式可通过 -default-ws 提供默认直连地址。
func (s *server) serveHost(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	cfg := s.readHostConfig()
	if cfg == nil {
		if strings.TrimSpace(s.defaultWS) != "" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok":    true,
				"wsUrl": s.defaultWS,
				"name":  "local-sim",
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":        true,
		"wsUrl":     cfg.WSURL,
		"probeUrl":  cfg.ProbeURL,
		"name":      cfg.Name,
		"updatedAt": cfg.UpdatedAt,
	})
}

func privateRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate()
}

func (s *server) pairJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// pairHandler 是局域网配对入口：只暴露 identity / pair / unpair，不服务静态资源。
func (s *server) pairHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			s.pairJSON(w, http.StatusNoContent, map[string]any{})
			return
		}
		if r.RemoteAddr != "" && !privateRemote(r.RemoteAddr) {
			s.pairJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "只允许局域网配对"})
			return
		}
		switch r.URL.Path {
		case "/__identity":
			host, _ := os.Hostname()
			cfg := s.readHostConfig()
			s.pairJSON(w, http.StatusOK, map[string]any{
				"ok":      true,
				"app":     "dhvw-arm",
				"version": s.version,
				"name":    host,
				"paired":  cfg != nil,
			})
		case "/__pair":
			if r.Method != http.MethodPost {
				s.pairJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST only"})
				return
			}
			r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
			var req struct {
				WSURL    string `json:"wsUrl"`
				ProbeURL string `json:"probeUrl"`
				Token    string `json:"token"`
				Name     string `json:"name"`
				CAPEM    string `json:"caPem"`
			}
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				s.pairJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json"})
				return
			}
			wsURL := strings.TrimSpace(req.WSURL)
			if len(wsURL) == 0 || len(wsURL) > 2048 {
				s.pairJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad wsUrl"})
				return
			}
			u, err := url.Parse(wsURL)
			if err != nil || (u.Scheme != "ws" && u.Scheme != "wss") || u.Host == "" {
				s.pairJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "wsUrl 必须是 ws/wss 地址"})
				return
			}
			// 兼容只传 token 的调用：拼到 orchestrator WS 地址上。
			if req.Token != "" && u.Query().Get("token") == "" {
				q := u.Query()
				q.Set("token", req.Token)
				u.RawQuery = q.Encode()
				wsURL = u.String()
			}
			cfg := hostConfig{WSURL: wsURL, ProbeURL: strings.TrimSpace(req.ProbeURL), Name: strings.TrimSpace(req.Name)}
			if err := s.writeHostConfig(cfg); err != nil {
				s.pairJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			caPem := strings.TrimSpace(req.CAPEM)
			if strings.Contains(caPem, "BEGIN CERTIFICATE") {
				_ = os.MkdirAll(s.dataDir, 0o755)
				_ = os.WriteFile(s.caFile, []byte(caPem+"\n"), 0o644)
				s.rebuildLLMClient()
			}
			s.pairJSON(w, http.StatusOK, map[string]any{"ok": true})
		case "/__unpair":
			if r.Method != http.MethodPost {
				s.pairJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "POST only"})
				return
			}
			_ = os.Remove(s.hostFile)
			_ = os.Remove(s.caFile)
			s.rebuildLLMClient()
			s.pairJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			s.pairJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not found"})
		}
	})
}

func isLoopbackHost(host string) bool {
	switch host {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

func etagMatches(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimSpace(part)
		if p == "*" || p == etag {
			return true
		}
		// 弱比较：忽略 W/ 前缀
		if strings.TrimPrefix(p, "W/") == strings.TrimPrefix(etag, "W/") {
			return true
		}
	}
	return false
}

// llmProxyReq 是页面发来的转发请求；key 只在内存中，不落日志。
type llmProxyReq struct {
	BaseURL string          `json:"baseUrl"`
	APIKey  string          `json:"apiKey"`
	Body    json.RawMessage `json:"body"`
}

// serveLLMProxy 解决浏览器跨域：页面请求本地壳，由壳转发到服务商。
// 只监听回环（main 已限制），不记录 body/key。
// serveLlmConfig 读取本机 apikey 目录里的第一个 txt，解析 baseUrl/apiKey/model。
// 仅本机回环壳使用，不写盘、不缓存。
func (s *server) serveLlmConfig(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	writeErr := func(code int, msg string) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": false, "error": msg})
	}
	if s.apikeyDir == "" {
		writeErr(http.StatusNotFound, "未配置 apikey 目录")
		return
	}
	entries, err := os.ReadDir(s.apikeyDir)
	if err != nil {
		writeErr(http.StatusNotFound, "读取 apikey 目录失败: "+err.Error())
		return
	}
	var pick string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".txt") {
			continue
		}
		name := strings.ToLower(e.Name())
		if pick == "" || strings.Contains(name, "codex") || strings.Contains(name, "llm") {
			pick = e.Name()
			if strings.Contains(name, "codex") || strings.Contains(name, "llm") {
				break
			}
		}
	}
	if pick == "" {
		writeErr(http.StatusNotFound, "apikey 目录里没有 txt")
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.apikeyDir, pick))
	if err != nil {
		writeErr(http.StatusInternalServerError, "读取失败: "+err.Error())
		return
	}
	out := map[string]any{"ok": true, "source": pick}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "baseurl="):
			out["baseUrl"] = strings.TrimSpace(line[len("baseurl="):])
		case strings.HasPrefix(lower, "apikey="):
			out["apiKey"] = strings.TrimSpace(line[len("apikey="):])
		case strings.HasPrefix(lower, "model="):
			out["model"] = strings.TrimSpace(line[len("model="):])
		case strings.HasPrefix(line, "http://") || strings.HasPrefix(line, "https://"):
			if _, ok := out["baseUrl"]; !ok {
				out["baseUrl"] = line
			}
		case strings.HasPrefix(line, "sk-"):
			if _, ok := out["apiKey"]; !ok {
				out["apiKey"] = line
			}
		default:
			if _, ok := out["model"]; !ok {
				out["model"] = line
			}
		}
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (s *server) serveLLMProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<20)
	var req llmProxyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad json", http.StatusBadRequest)
		return
	}
	u, err := url.Parse(strings.TrimSpace(req.BaseURL))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		http.Error(w, "bad baseUrl", http.StatusBadRequest)
		return
	}
	if u.Hostname() == "169.254.169.254" || strings.EqualFold(u.Hostname(), "metadata.google.internal") {
		http.Error(w, "blocked host", http.StatusForbidden)
		return
	}
	if len(req.Body) == 0 {
		http.Error(w, "missing body", http.StatusBadRequest)
		return
	}

	target := strings.TrimRight(req.BaseURL, "/") + "/chat/completions"
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(req.Body))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36")
	if req.APIKey != "" {
		hr.Header.Set("Authorization", "Bearer "+req.APIKey)
	}

	resp, err := s.getLLMClient().Do(hr)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "upstream_unreachable"})
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 4<<20))
}

func (s *server) findQqServerScript() string {
	candidates := []string{
		os.Getenv("DHVW_QQ_SERVER"),
		filepath.Join(filepath.Dir(s.root), "qq-openclaw", "dist", "dhvw-server.js"),
		"/opt/dhvw/qq-openclaw/dist/dhvw-server.js",
	}
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}

func (s *server) qqAlive() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 350*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://127.0.0.1:8088/__qq/health", nil)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return false
	}
	_ = resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (s *server) ensureQqStarted() {
	if s.qqAlive() {
		return
	}
	s.qqMu.Lock()
	defer s.qqMu.Unlock()
	if s.qqAlive() {
		return
	}
	if s.qqCmd != nil && s.qqCmd.Process != nil && s.qqCmd.ProcessState == nil {
		return
	}
	script := s.findQqServerScript()
	if script == "" {
		return
	}
	stateDir := filepath.Join(s.dataDir, "qq-openclaw")
	_ = os.MkdirAll(stateDir, 0o755)
	cmd := exec.Command("node", script, "-followBoost", "-stateDir", stateDir)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[qq] 启动 qq-openclaw 失败: %v", err)
		return
	}
	s.qqCmd = cmd
	go func(c *exec.Cmd) {
		_ = c.Wait()
		s.qqMu.Lock()
		if s.qqCmd == c {
			s.qqCmd = nil
		}
		s.qqMu.Unlock()
	}(cmd)
	for i := 0; i < 30; i++ {
		if s.qqAlive() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func (s *server) stopQqChild() {
	s.qqMu.Lock()
	cmd := s.qqCmd
	s.qqCmd = nil
	s.qqMu.Unlock()
	if cmd != nil && cmd.Process != nil && cmd.ProcessState == nil {
		_ = cmd.Process.Kill()
	}
}

func (s *server) serveQqProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var rawBody []byte
	if r.Method == http.MethodPost {
		var err error
		rawBody, err = io.ReadAll(io.LimitReader(r.Body, 64<<10))
		if err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
	}
	if r.URL.Path == "/__qq/boost" && r.Method == http.MethodPost {
		var b struct {
			Enabled bool `json:"enabled"`
		}
		_ = json.Unmarshal(rawBody, &b)
		if b.Enabled {
			s.ensureQqStarted()
		} else {
			s.stopQqChild()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "running": false, "boostActive": false})
			return
		}
	} else if r.URL.Path == "/__qq/config" || r.URL.Path == "/__qq/rebind" || r.URL.Path == "/__qq/proactive/trigger" {
		s.ensureQqStarted()
	}
	targetPath := r.URL.Path
	if targetPath == "/__qq/boost" {
		targetPath = "/__qq/health"
	}
	var body io.Reader
	if r.Method == http.MethodPost && targetPath != "/__qq/health" {
		body = bytes.NewReader(rawBody)
	}
	method := r.Method
	if targetPath == "/__qq/health" {
		method = http.MethodGet
	}
	timeout := 5 * time.Second
	if targetPath == "/__qq/proactive/trigger" {
		timeout = 18 * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	target := "http://127.0.0.1:8088" + targetPath
	hr, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if method == http.MethodPost {
		hr.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.httpClient.Do(hr)
	if err != nil {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "running": false, "configured": false, "paired": false})
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 256<<10))
}

func (s *server) serveHealth(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"ok":       len(s.pack.Missing) == 0 && len(s.pack.SizeBad) == 0 && len(s.pack.HashBad) == 0,
		"version":  s.version,
		"uptime_s": int64(time.Since(s.started).Seconds()),
		"requests": s.hits.Load(),
		"pack":     s.pack,
		"root":     s.root,
		"time":     time.Now().Format(time.RFC3339),
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(body)
}

func defaultApikeyDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, "Documents", "apikey")
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "监听地址（只允许回环）")
	pairAddr := flag.String("pair-addr", "0.0.0.0:8081", "局域网配对监听地址（空=关闭）")
	defaultWS := flag.String("default-ws", "", "未配对时的默认编排器 WS 地址（本机模拟用，如 ws://127.0.0.1:8877/dhvw）")
	apikeyDir := flag.String("apikey", defaultApikeyDir(), "本机 LLM 配置目录（读取第一个 *.txt）")
	root := flag.String("root", "./www", "资源包根目录")
	verifyHash := flag.Bool("verify-hash", false, "启动时校验 manifest 的 sha256（较慢，仅排障用）")
	dev := flag.Bool("dev", false, "开发模式：静态文件禁用长缓存")
	flag.Parse()

	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatalf("非法 -addr: %v", err)
	}
	if !isLoopbackHost(host) {
		log.Fatalf("拒绝监听非回环地址 %q（设备端只服务本机 kiosk）", host)
	}

	srv, err := newServer(*root, version, *verifyHash, *apikeyDir)
	if srv != nil {
		srv.noCache = *dev
		srv.defaultWS = strings.TrimSpace(*defaultWS)
	}
	if err != nil {
		log.Fatalf("初始化失败: %v", err)
	}
	if srv.pack.Checked {
		log.Printf("资源包: %d 个文件, 缺失 %d, 尺寸不符 %d, 哈希不符 %d",
			srv.pack.Files, len(srv.pack.Missing), len(srv.pack.SizeBad), len(srv.pack.HashBad))
	} else {
		log.Printf("资源包: 未找到 manifest.json（跳过校验）")
	}

	hs := &http.Server{
		Addr:              *addr,
		Handler:           srv,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ln, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatalf("监听失败: %v", err)
	}
	log.Printf("dhvw-shell %s → http://%s (root=%s)", version, *addr, srv.root)
	go func() {
		cfgPath := filepath.Join(srv.dataDir, "qq-openclaw", "bot-config.json")
		raw, err := os.ReadFile(cfgPath)
		if err != nil {
			return
		}
		var bc struct {
			AppID        string `json:"appId"`
			ClientSecret string `json:"clientSecret"`
			Enabled      *bool  `json:"enabled"`
		}
		if json.Unmarshal(raw, &bc) == nil && strings.TrimSpace(bc.AppID) != "" && strings.TrimSpace(bc.ClientSecret) != "" && (bc.Enabled == nil || *bc.Enabled) {
			log.Printf("[qq] 检测到已保存 QQ Bot 配置，自动拉起 qq-openclaw")
			srv.ensureQqStarted()
		}
	}()

	var pairSrv *http.Server
	if strings.TrimSpace(*pairAddr) != "" {
		pairSrv = &http.Server{
			Addr:              *pairAddr,
			Handler:           srv.pairHandler(),
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       30 * time.Second,
		}
		go func() {
			log.Printf("局域网配对 → http://%s/__identity", *pairAddr)
			if err := pairSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Printf("配对监听失败（继续仅本机）: %v", err)
			}
		}()
	}

	idle := make(chan struct{})
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Printf("收到退出信号，关闭服务")
		close(idle)
	}()

	go func() {
		if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("服务异常: %v", err)
		}
	}()
	<-idle
	srv.stopQqChild()
	if pairSrv != nil {
		_ = pairSrv.Close()
	}
	_ = hs.Close()
}
