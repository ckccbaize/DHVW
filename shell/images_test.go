package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseBingHTML(t *testing.T) {
	html := `<a m="{&quot;murl&quot;:&quot;https://img.example.com/a.jpg&quot;,&quot;turl&quot;:&quot;https://img.example.com/a_t.jpg&quot;}"></a>` +
		`<a m="{&quot;murl&quot;:&quot;https://img.example.com/b.jpg&quot;,&quot;turl&quot;:&quot;https://img.example.com/b_t.jpg&quot;}"></a>`
	items := parseBingHTML(html, 8)
	if len(items) != 2 {
		t.Fatalf("want 2, got %d", len(items))
	}
	if items[0].URL != "https://img.example.com/a.jpg" || items[0].Thumb != "https://img.example.com/a_t.jpg" {
		t.Fatalf("bad item: %+v", items[0])
	}
	if items[1].URL != "https://img.example.com/b.jpg" {
		t.Fatalf("bad item: %+v", items[1])
	}
}

func TestIsPublicIP(t *testing.T) {
	bad := []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fc00::1", "0.0.0.0"}
	for _, s := range bad {
		if isPublicIP(net.ParseIP(s)) {
			t.Errorf("%s 应判为非公网", s)
		}
	}
	if !isPublicIP(net.ParseIP("1.1.1.1")) {
		t.Error("1.1.1.1 应为公网")
	}
}

func TestImageSearchRequiresQuery(t *testing.T) {
	s := &server{httpClient: &http.Client{Timeout: time.Second}}
	rec := httptest.NewRecorder()
	s.serveImageSearch(rec, httptest.NewRequest(http.MethodGet, "/__image/search", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestImageFetchRejectsBadURL(t *testing.T) {
	s := &server{}
	for _, u := range []string{"", "file:///etc/passwd", "http:///nohost"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/__image/fetch?url="+u, nil)
		s.serveImageFetch(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: want 400, got %d", u, rec.Code)
		}
	}
}

func TestImageFetchRejectsNonImage(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html></html>"))
	}))
	defer up.Close()
	// 用可注入的 client 绕过公网限制，只验证 Content-Type 闸门。
	old := imageHTTPClient
	imageHTTPClient = &http.Client{Timeout: time.Second}
	defer func() { imageHTTPClient = old }()

	s := &server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/__image/fetch?url="+up.URL+"/x", nil)
	s.serveImageFetch(rec, req)
	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("want 415, got %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "<html>") {
		t.Fatal("不应透传非图片内容")
	}
}
