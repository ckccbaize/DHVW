package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const bingSample = `<ol id="b_results">
<li class="b_algo"><h2><a href="https://www.weather.com.cn/weather/101010100.shtml" h="ID=SERP">北京天气预报</a></h2><p>北京天气预报，及时准确。</p></li>
<li class="b_algo"><h2><a href="https://example.com/b">第二条</a></h2><p>摘要 &amp; 内容</p></li>
</ol>`

func TestParseBingResults(t *testing.T) {
	items := parseBingResults(bingSample, 5)
	if len(items) != 2 {
		t.Fatalf("want 2, got %d", len(items))
	}
	if items[0].URL != "https://www.weather.com.cn/weather/101010100.shtml" {
		t.Fatalf("url=%q", items[0].URL)
	}
	if items[0].Title != "北京天气预报" {
		t.Fatalf("title=%q", items[0].Title)
	}
	if items[1].Snippet != "摘要 & 内容" {
		t.Fatalf("snippet=%q", items[1].Snippet)
	}
}

func TestSearchRequiresQuery(t *testing.T) {
	s := &server{}
	rec := httptest.NewRecorder()
	s.serveSearch(rec, httptest.NewRequest(http.MethodGet, "/__search", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestSearchRejectsLongQuery(t *testing.T) {
	s := &server{}
	rec := httptest.NewRecorder()
	s.serveSearch(rec, httptest.NewRequest(http.MethodGet, "/__search?q="+strings.Repeat("a", 81), nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}
