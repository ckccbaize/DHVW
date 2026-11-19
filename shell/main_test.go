package main

import (
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeFile(t *testing.T, p, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func newTestServer(t *testing.T) (*server, string) {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "index.html"), "<!doctype html><title>t</title>")
	writeFile(t, filepath.Join(root, "js", "app.js"), "export const x = 1;\n")
	writeFile(t, filepath.Join(root, "assets", "a.png"), "PNGDATA")
	writeFile(t, filepath.Join(root, "manifest.json"),
		`{"version":"t","files":[{"path":"index.html","size":28},{"path":"js/app.js","size":20}]}`)
	s, err := newServer(root, "test", false, "")
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func get(t *testing.T, s *server, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func TestServesIndexAndMime(t *testing.T) {
	s, _ := newTestServer(t)
	rec := get(t, s, "/")
	if rec.Code != 200 {
		t.Fatalf("GET / → %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("index content-type = %q", ct)
	}
	rec = get(t, s, "/js/app.js")
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/javascript") {
		t.Fatalf("js content-type = %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Fatalf("js 必须可重验证（no-cache），got %q", cc)
	}
	rec = get(t, s, "/assets/a.png")
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("assets 应长缓存，got %q", cc)
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("缺少 nosniff")
	}
}

func TestNoDirectoryListing(t *testing.T) {
	s, _ := newTestServer(t)
	rec := get(t, s, "/assets/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("目录请求应 404，得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "a.png") {
		t.Fatal("响应体泄露了目录内容")
	}
}

func TestNoEscapeFromRoot(t *testing.T) {
	s, root := newTestServer(t)
	outside := filepath.Join(filepath.Dir(root), "secret.txt")
	writeFile(t, outside, "TOP-SECRET")
	defer os.Remove(outside)

	for _, target := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt"} {
		rec := get(t, s, target)
		if strings.Contains(rec.Body.String(), "TOP-SECRET") {
			t.Fatalf("%s 泄露了 root 之外的文件", target)
		}
	}
}

func TestETagNotModified(t *testing.T) {
	s, _ := newTestServer(t)
	first := get(t, s, "/index.html")
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("缺少 ETag")
	}
	req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
	req.Header.Set("If-None-Match", etag)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("带 If-None-Match 应 304，得到 %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Fatalf("304 不应有响应体，得到 %d 字节", rec.Body.Len())
	}
}

func TestSPAFallback(t *testing.T) {
	s, _ := newTestServer(t)
	rec := get(t, s, "/overview/room")
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "<!doctype html>") {
		t.Fatalf("无扩展名路径应回退 index.html，得到 %d", rec.Code)
	}
	rec = get(t, s, "/missing.js")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("缺失的 .js 应 404，得到 %d", rec.Code)
	}
}

func TestPairWritesHostConfig(t *testing.T) {
	s, _ := newTestServer(t)
	pair := s.pairHandler()

	body := `{"wsUrl":"wss://192.168.8.51:8443/ws/orchestrator?token=abc","name":"md1000"}`
	req := httptest.NewRequest(http.MethodPost, "/__pair", strings.NewReader(body))
	req.RemoteAddr = "192.168.8.83:4567"
	rec := httptest.NewRecorder()
	pair.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("pair → %d: %s", rec.Code, rec.Body.String())
	}

	rec = get(t, s, "/__host")
	if rec.Code != http.StatusOK {
		t.Fatalf("host → %d", rec.Code)
	}
	var host struct {
		OK    bool   `json:"ok"`
		WSURL string `json:"wsUrl"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &host); err != nil {
		t.Fatal(err)
	}
	if !host.OK || !strings.Contains(host.WSURL, "token=abc") {
		t.Fatalf("host 配置不对: %+v", host)
	}

	req = httptest.NewRequest(http.MethodGet, "/__identity", nil)
	req.RemoteAddr = "192.168.8.83:4567"
	rec = httptest.NewRecorder()
	pair.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"paired":true`) {
		t.Fatalf("identity 不对: %d %s", rec.Code, rec.Body.String())
	}
}

func TestPairRejectsPublicAndBadURL(t *testing.T) {
	s, _ := newTestServer(t)
	pair := s.pairHandler()

	req := httptest.NewRequest(http.MethodPost, "/__pair", strings.NewReader(`{"wsUrl":"wss://x/y"}`))
	req.RemoteAddr = "8.8.8.8:1234"
	rec := httptest.NewRecorder()
	pair.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("公网来源应 403，得到 %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodPost, "/__pair", strings.NewReader(`{"wsUrl":"http://x/y"}`))
	req.RemoteAddr = "192.168.8.83:4567"
	rec = httptest.NewRecorder()
	pair.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("非 ws/wss 应 400，得到 %d", rec.Code)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/index.html", strings.NewReader("x"))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 应 405，得到 %d", rec.Code)
	}
}

func TestHealthReportsPack(t *testing.T) {
	s, root := newTestServer(t)
	rec := get(t, s, "/__health")
	if rec.Code != 200 {
		t.Fatalf("health → %d", rec.Code)
	}
	var body struct {
		OK   bool `json:"ok"`
		Pack struct {
			Checked bool     `json:"checked"`
			Files   int      `json:"files"`
			Missing []string `json:"missing"`
		} `json:"pack"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("health 不是合法 JSON: %v", err)
	}
	if !body.Pack.Checked || body.Pack.Files != 2 || len(body.Pack.Missing) != 0 {
		t.Fatalf("pack 状态不对: %+v", body.Pack)
	}

	// 删掉一个文件后应报告缺失且 ok=false
	if err := os.Remove(filepath.Join(root, "js", "app.js")); err != nil {
		t.Fatal(err)
	}
	s.pack = s.checkPack()
	rec = get(t, s, "/__health")
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.OK {
		t.Fatal("缺文件时 ok 应为 false")
	}
	if len(body.Pack.Missing) != 1 || body.Pack.Missing[0] != "js/app.js" {
		t.Fatalf("missing = %v", body.Pack.Missing)
	}
}

func TestRejectsNonLoopback(t *testing.T) {
	// 直接用 SplitHostPort 的判定逻辑：0.0.0.0 必须被 main 拒绝。
	// 这里验证 host 判定函数在 main 内联，改为断言常量行为。
	if !isLoopbackHost("127.0.0.1") || !isLoopbackHost("::1") || !isLoopbackHost("localhost") {
		t.Fatal("回环地址应被接受")
	}
	if isLoopbackHost("0.0.0.0") || isLoopbackHost("192.168.1.10") {
		t.Fatal("非回环地址应被拒绝")
	}
}

func TestLLMProxyForwards(t *testing.T) {
	var gotAuth, gotBody string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"pong"}}]}`))
	}))
	defer upstream.Close()

	s, _ := newTestServer(t)
	payload := `{"baseUrl":"` + upstream.URL + `/v1","apiKey":"sk-x","body":{"model":"m","messages":[]}}`
	req := httptest.NewRequest(http.MethodPost, "/__llm/chat/completions", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)

	if rec.Code != 200 {
		t.Fatalf("proxy → %d: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "pong") {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if gotAuth != "Bearer sk-x" {
		t.Fatalf("auth = %q", gotAuth)
	}
	if !strings.Contains(gotBody, `"model":"m"`) {
		t.Fatalf("upstream body = %s", gotBody)
	}
}

func TestLLMProxyRejectsBadInput(t *testing.T) {
	s, _ := newTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/__llm/chat/completions", nil)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET → %d", rec.Code)
	}

	for _, body := range []string{
		`{"baseUrl":"ftp://x","body":{}}`,
		`{"baseUrl":"","body":{}}`,
		`{"baseUrl":"http://127.0.0.1:1/v1"}`,
		`not json`,
	} {
		req = httptest.NewRequest(http.MethodPost, "/__llm/chat/completions", strings.NewReader(body))
		rec = httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("body %q → %d", body, rec.Code)
		}
	}
}

func TestLLMProxyUpstreamDown(t *testing.T) {
	s, _ := newTestServer(t)
	payload := `{"baseUrl":"http://127.0.0.1:1/v1","body":{"model":"m"}}`
	req := httptest.NewRequest(http.MethodPost, "/__llm/chat/completions", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("unreachable upstream → %d", rec.Code)
	}
}

func TestLlmConfigReadsApikeyFile(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "index.html"), "x")
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "codex.txt"), "https://example.test\nsk-abc\nmodel-x\n")
	s, err := newServer(root, "test", false, dir)
	if err != nil {
		t.Fatal(err)
	}
	rec := get(t, s, "/__llm/config")
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["baseUrl"] != "https://example.test" || out["apiKey"] != "sk-abc" || out["model"] != "model-x" {
		t.Fatalf("bad config: %v", out)
	}
}

func TestPairStoresCAAndLLMProxyTrustsSelfSigned(t *testing.T) {
	var seenAuth string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer upstream.Close()

	caPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: upstream.Certificate().Raw}))
	s, _ := newTestServer(t)

	// 配对写入自签 CA 后，/__llm/chat/completions 必须信任该网关证书并透传 Bearer token
	pairBody, _ := json.Marshal(map[string]string{
		"wsUrl": "wss://192.168.1.10:8443/ws/orchestrator?token=tok-1",
		"name":  "arm-board",
		"caPem": caPem,
	})
	pairReq := httptest.NewRequest(http.MethodPost, "/__pair", strings.NewReader(string(pairBody)))
	pairReq.RemoteAddr = "192.168.1.10:5555"
	pairRec := httptest.NewRecorder()
	s.pairHandler().ServeHTTP(pairRec, pairReq)
	if pairRec.Code != http.StatusOK {
		t.Fatalf("__pair → %d %s", pairRec.Code, pairRec.Body.String())
	}
	if _, err := os.Stat(s.caFile); err != nil {
		t.Fatalf("caFile missing: %v", err)
	}

	proxyBody, _ := json.Marshal(map[string]any{
		"baseUrl": upstream.URL + "/llm/v1",
		"apiKey":  "tok-1",
		"body":    map[string]any{"model": "nemotron-3.5-bolt-e4b", "messages": []any{}},
	})
	req := httptest.NewRequest(http.MethodPost, "/__llm/chat/completions", strings.NewReader(string(proxyBody)))
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("TLS proxy → %d body=%s", rec.Code, rec.Body.String())
	}
	if seenAuth != "Bearer tok-1" {
		t.Fatalf("Authorization mismatch: got %q", seenAuth)
	}
}

func TestDefaultWSFallbackWhenUnpaired(t *testing.T) {
	s, _ := newTestServer(t)
	s.defaultWS = "ws://127.0.0.1:8877/dhvw"

	rec := get(t, s, "/__host")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /__host → %d", rec.Code)
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["ok"] != true || out["wsUrl"] != "ws://127.0.0.1:8877/dhvw" {
		t.Fatalf("expected defaultWS fallback, got %v", out)
	}
}
