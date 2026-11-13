// 联网代理（W28）：设备侧只读抓取，禁内网/元数据/凭据/POST。
// 返回纯文本摘要；完整审计写 stdout（设备由 journald 收集）。
package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	maxFetchBytes = 512 << 10
	maxFetchChars = 4000
	fetchPerHour  = 60
)

var (
	fetchMu    sync.Mutex
	fetchTimes []time.Time

	scriptRE = regexp.MustCompile(`(?is)<(script|style|noscript)[^>]*>.*?</(script|style|noscript)>`)
	tagRE    = regexp.MustCompile(`(?s)<[^>]+>`)
	spaceRE  = regexp.MustCompile(`\s+`)
)

func (s *server) serveFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	raw := r.URL.Query().Get("url")
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		http.Error(w, "非法 url", http.StatusBadRequest)
		return
	}
	if u.User != nil {
		http.Error(w, "不允许带凭据的 url", http.StatusBadRequest)
		return
	}
	if !allowFetch() {
		http.Error(w, "抓取频率超限", http.StatusTooManyRequests)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 dhvw-device/0.1")
	req.Header.Set("Accept", "text/html,text/plain,application/json")
	resp, err := textHTTPClient.Do(req)
	if err != nil {
		http.Error(w, "上游失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		http.Error(w, fmt.Sprintf("上游 http %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if !isTextContent(ct) {
		http.Error(w, "不是文本: "+ct, http.StatusUnsupportedMediaType)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFetchBytes+1))
	if err != nil {
		http.Error(w, "读取失败", http.StatusBadGateway)
		return
	}
	truncated := len(body) > maxFetchBytes
	if truncated {
		body = body[:maxFetchBytes]
	}
	text := stripHTML(string(body))
	if len([]rune(text)) > maxFetchChars {
		text = string([]rune(text)[:maxFetchChars])
		truncated = true
	}
	writeJSON(w, map[string]any{
		"ok":        true,
		"url":       u.String(),
		"status":    resp.StatusCode,
		"bytes":     len(body),
		"truncated": truncated,
		"text":      text,
	})
}

func isTextContent(ct string) bool {
	ct = strings.ToLower(ct)
	return strings.HasPrefix(ct, "text/") ||
		strings.Contains(ct, "application/json") ||
		strings.Contains(ct, "application/xhtml")
}

func stripHTML(s string) string {
	s = scriptRE.ReplaceAllString(s, " ")
	s = tagRE.ReplaceAllString(s, " ")
	repl := strings.NewReplacer("&nbsp;", " ", "&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'")
	s = repl.Replace(s)
	return strings.TrimSpace(spaceRE.ReplaceAllString(s, " "))
}

func allowFetch() bool {
	fetchMu.Lock()
	defer fetchMu.Unlock()
	now := time.Now()
	cut := now.Add(-time.Hour)
	kept := fetchTimes[:0]
	for _, t := range fetchTimes {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	fetchTimes = kept
	if len(fetchTimes) >= fetchPerHour {
		return false
	}
	fetchTimes = append(fetchTimes, now)
	return true
}

var textHTTPClient = &http.Client{
	Timeout:   8 * time.Second,
	Transport: publicTransport,
}
