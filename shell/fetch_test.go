package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestStripHTML(t *testing.T) {
	in := `<html><head><style>.a{}</style><script>alert(1)</script></head><body><h1>标题</h1><p>正文 &amp; 内容</p></body></html>`
	out := stripHTML(in)
	if strings.Contains(out, "alert") || strings.Contains(out, "style") {
		t.Fatalf("脚本/样式未剔除: %s", out)
	}
	if !strings.Contains(out, "标题") || !strings.Contains(out, "正文 & 内容") {
		t.Fatalf("正文丢失: %s", out)
	}
}

func TestIsTextContent(t *testing.T) {
	for _, ct := range []string{"text/html; charset=utf-8", "text/plain", "application/json", "application/xhtml+xml"} {
		if !isTextContent(ct) {
			t.Errorf("%s 应判为文本", ct)
		}
	}
	for _, ct := range []string{"image/png", "application/octet-stream", "video/mp4"} {
		if isTextContent(ct) {
			t.Errorf("%s 不应判为文本", ct)
		}
	}
}

func TestFetchRateLimit(t *testing.T) {
	fetchMu.Lock()
	fetchTimes = nil
	fetchMu.Unlock()
	for i := range fetchPerHour {
		if !allowFetch() {
			t.Fatalf("第 %d 次不应超限", i+1)
		}
	}
	if allowFetch() {
		t.Fatal("第 61 次应超限")
	}
	fetchMu.Lock()
	fetchTimes = nil
	fetchMu.Unlock()
}

func TestFetchRejectsBadURL(t *testing.T) {
	s := &server{}
	for _, u := range []string{"", "file:///etc/passwd", "http://user:pass@example.com/x"} {
		rec := httptest.NewRecorder()
		s.serveFetch(rec, httptest.NewRequest(http.MethodGet, "/__fetch?url="+u, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: want 400, got %d", u, rec.Code)
		}
	}
}

func TestFetchReturnsText(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<html><body><p>你好</p><script>x</script></body></html>"))
	}))
	defer up.Close()

	old := textHTTPClient
	textHTTPClient = &http.Client{Timeout: time.Second}
	defer func() { textHTTPClient = old }()

	fetchMu.Lock()
	fetchTimes = nil
	fetchMu.Unlock()

	s := &server{}
	rec := httptest.NewRecorder()
	s.serveFetch(rec, httptest.NewRequest(http.MethodGet, "/__fetch?url="+up.URL+"/x", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Text string `json:"text"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Text != "你好" {
		t.Fatalf("text=%q", out.Text)
	}
}

func TestFetchRejectsNonText(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("PNG"))
	}))
	defer up.Close()

	old := textHTTPClient
	textHTTPClient = &http.Client{Timeout: time.Second}
	defer func() { textHTTPClient = old }()

	fetchMu.Lock()
	fetchTimes = nil
	fetchMu.Unlock()

	s := &server{}
	rec := httptest.NewRecorder()
	s.serveFetch(rec, httptest.NewRequest(http.MethodGet, "/__fetch?url="+up.URL+"/x", nil))
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("want 415, got %d", rec.Code)
	}
}
