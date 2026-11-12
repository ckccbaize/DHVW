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
	"os/signal"
	"path"
	"path/filepath"
	"strconv"
	"strings"
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

type server struct {
	root       string
	version    string
	started    time.Time
	pack       packStatus
	verifyHash bool
	hits       atomic.Int64
	httpClient *http.Client
}

func newServer(root, ver string, verifyHash bool) (*server, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return nil, fmt.Errorf("root 不是目录: %s", abs)
	}
	s := &server{
		root:       abs,
		version:    ver,
		started:    time.Now(),
		verifyHash: verifyHash,
		httpClient: &http.Client{Timeout: 120 * time.Second},
	}
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
	case strings.HasPrefix(p, "/assets/"), strings.HasPrefix(p, "/js/"), strings.HasPrefix(p, "/css/"):
		return "public, max-age=31536000, immutable"
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
	h.Set("Cache-Control", cacheControl(urlPath))
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
func (s *server) serveLLMProxy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
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
	if req.APIKey != "" {
		hr.Header.Set("Authorization", "Bearer "+req.APIKey)
	}

	resp, err := s.httpClient.Do(hr)
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

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "监听地址（只允许回环）")
	root := flag.String("root", "./www", "资源包根目录")
	verifyHash := flag.Bool("verify-hash", false, "启动时校验 manifest 的 sha256（较慢，仅排障用）")
	flag.Parse()

	host, _, err := net.SplitHostPort(*addr)
	if err != nil {
		log.Fatalf("非法 -addr: %v", err)
	}
	if !isLoopbackHost(host) {
		log.Fatalf("拒绝监听非回环地址 %q（设备端只服务本机 kiosk）", host)
	}

	srv, err := newServer(*root, version, *verifyHash)
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
	_ = hs.Close()
}
