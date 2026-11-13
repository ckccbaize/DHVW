// Bing 搜索（W28b）：无 key，返回结构化结果，供模型自由选目标。
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type searchItem struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
}

var (
	searchCacheMu sync.Mutex
	searchCache   = map[string]searchCacheEntry{}

	algoRE  = regexp.MustCompile(`(?is)<li class="b_algo".*?</li>`)
	hrefRE  = regexp.MustCompile(`(?is)<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	snipRE  = regexp.MustCompile(`(?is)<p[^>]*>(.*?)</p>`)
	htmlTag = regexp.MustCompile(`(?s)<[^>]+>`)
)

type searchCacheEntry struct {
	at  time.Time
	res []searchItem
}

func (s *server) serveSearch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		http.Error(w, "缺少 q", http.StatusBadRequest)
		return
	}
	if len([]rune(q)) > 80 {
		http.Error(w, "q 过长", http.StatusBadRequest)
		return
	}
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n <= 0 || n > 10 {
		n = 5
	}
	key := q + "|" + strconv.Itoa(n)
	searchCacheMu.Lock()
	if e, ok := searchCache[key]; ok && time.Since(e.at) < 5*time.Minute {
		searchCacheMu.Unlock()
		writeJSON(w, map[string]any{"ok": true, "query": q, "results": e.res})
		return
	}
	searchCacheMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	u := "https://cn.bing.com/search?q=" + url.QueryEscape(q) + "&form=QBLH"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	resp, err := textHTTPClient.Do(req)
	if err != nil {
		http.Error(w, "搜索失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("搜索 http %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		http.Error(w, "读取失败", http.StatusBadGateway)
		return
	}
	items := parseBingResults(string(body), n)
	if len(items) == 0 {
		http.Error(w, "没有结果", http.StatusBadGateway)
		return
	}
	searchCacheMu.Lock()
	searchCache[key] = searchCacheEntry{at: time.Now(), res: items}
	searchCacheMu.Unlock()
	writeJSON(w, map[string]any{"ok": true, "query": q, "results": items})
}

func parseBingResults(html string, n int) []searchItem {
	blocks := algoRE.FindAllString(html, n)
	out := make([]searchItem, 0, len(blocks))
	for _, block := range blocks {
		h := hrefRE.FindStringSubmatch(block)
		if len(h) < 3 {
			continue
		}
		item := searchItem{
			URL:   decodeEntities(h[1]),
			Title: strings.TrimSpace(htmlTag.ReplaceAllString(decodeEntities(h[2]), "")),
		}
		if p := snipRE.FindStringSubmatch(block); len(p) > 1 {
			item.Snippet = strings.TrimSpace(htmlTag.ReplaceAllString(decodeEntities(p[1]), ""))
		}
		if item.URL != "" && item.Title != "" {
			out = append(out, item)
		}
	}
	return out
}

func decodeEntities(s string) string {
	repl := strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&ensp;", " ", "&#0183;", "·")
	return repl.Replace(s)
}
