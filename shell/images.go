// 图片搜索与下载代理（W15）：设备端无 API key，走壳的 /__image/*。
//
// 搜索顺序：Bing 图片（国内可达）→ Openverse（CC，无需 key）→ Wikimedia Commons。
// 下载：仅 http(s)、仅公网 IP、仅 image/*、≤6MiB。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

type imageItem struct {
	URL     string `json:"url"`
	Thumb   string `json:"thumb"`
	Title   string `json:"title"`
	License string `json:"license"`
	Author  string `json:"author"`
	Page    string `json:"page"`
}

type imageResult struct {
	Source string      `json:"source"`
	Items  []imageItem `json:"items"`
}

type imageCacheEntry struct {
	at  time.Time
	res imageResult
}

var (
	imageCacheMu sync.Mutex
	imageCache   = map[string]imageCacheEntry{}
)

const imageCacheTTL = 10 * time.Minute

var bingMURL = regexp.MustCompile(`murl&quot;:&quot;(https?://[^&]+)`)
var bingTURL = regexp.MustCompile(`turl&quot;:&quot;(https?://[^&]+)`)

func (s *server) serveImageSearch(w http.ResponseWriter, r *http.Request) {
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
	n, _ := strconv.Atoi(r.URL.Query().Get("n"))
	if n <= 0 || n > 20 {
		n = 8
	}
	key := q + "|" + strconv.Itoa(n)
	imageCacheMu.Lock()
	if e, ok := imageCache[key]; ok && time.Since(e.at) < imageCacheTTL {
		imageCacheMu.Unlock()
		writeJSON(w, e.res)
		return
	}
	imageCacheMu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	src := r.URL.Query().Get("provider")
	var res imageResult
	var err error
	try := func(name string, fn func(context.Context, string, int) ([]imageItem, error)) bool {
		if src != "" && src != name {
			return false
		}
		items, e := fn(ctx, q, n)
		if e == nil && len(items) > 0 {
			res = imageResult{Source: name, Items: items}
			return true
		}
		err = e
		return false
	}
	if !try("bing", s.searchBing) && !try("openverse", s.searchOpenverse) {
		try("wikimedia", s.searchWikimedia)
	}
	if len(res.Items) == 0 {
		msg := "没有结果"
		if err != nil {
			msg = err.Error()
		}
		writeJSONStatus(w, http.StatusBadGateway, map[string]any{"ok": false, "error": msg})
		return
	}
	imageCacheMu.Lock()
	imageCache[key] = imageCacheEntry{at: time.Now(), res: res}
	imageCacheMu.Unlock()
	writeJSON(w, res)
}

func (s *server) searchBing(ctx context.Context, q string, n int) ([]imageItem, error) {
	u := "https://cn.bing.com/images/search?q=" + url.QueryEscape(q) + "&form=HDRSC2&first=1"
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bing http %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	return parseBingHTML(string(body), n), nil
}

func parseBingHTML(html string, n int) []imageItem {
	murls := bingMURL.FindAllStringSubmatch(html, n)
	turls := bingTURL.FindAllStringSubmatch(html, n)
	out := make([]imageItem, 0, len(murls))
	for i, m := range murls {
		item := imageItem{URL: m[1], Thumb: m[1], License: "unknown"}
		if i < len(turls) {
			item.Thumb = turls[i][1]
		}
		out = append(out, item)
	}
	return out
}

func (s *server) searchOpenverse(ctx context.Context, q string, n int) ([]imageItem, error) {
	u := "https://api.openverse.org/v1/images/?q=" + url.QueryEscape(q) + "&page_size=" + strconv.Itoa(n)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "dhvw-device/0.1")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("openverse http %d", resp.StatusCode)
	}
	var data struct {
		Results []struct {
			URL               string `json:"url"`
			Thumbnail         string `json:"thumbnail"`
			Title             string `json:"title"`
			License           string `json:"license"`
			Creator           string `json:"creator"`
			ForeignLandingURL string `json:"foreign_landing_url"`
		} `json:"results"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 2<<20)).Decode(&data); err != nil {
		return nil, err
	}
	out := make([]imageItem, 0, len(data.Results))
	for _, r := range data.Results {
		out = append(out, imageItem{
			URL: r.URL, Thumb: r.Thumbnail, Title: r.Title,
			License: r.License, Author: r.Creator, Page: r.ForeignLandingURL,
		})
	}
	return out, nil
}

func (s *server) searchWikimedia(ctx context.Context, q string, n int) ([]imageItem, error) {
	params := url.Values{}
	params.Set("action", "query")
	params.Set("generator", "search")
	params.Set("gsrsearch", q+" filetype:bitmap")
	params.Set("gsrnamespace", "6")
	params.Set("gsrlimit", strconv.Itoa(n))
	params.Set("prop", "imageinfo")
	params.Set("iiprop", "url|extmetadata")
	params.Set("iiurlwidth", "640")
	params.Set("iiextmetadatafilter", "LicenseShortName|Artist")
	params.Set("format", "json")
	u := "https://commons.wikimedia.org/w/api.php?" + params.Encode()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "dhvw-device/0.1 (contact: dev@local)")
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("wikimedia http %d", resp.StatusCode)
	}
	var data struct {
		Query struct {
			Pages map[string]struct {
				Title     string `json:"title"`
				Imageinfo []struct {
					Thumburl       string `json:"thumburl"`
					URL            string `json:"url"`
					Descriptionurl string `json:"descriptionurl"`
					Extmetadata    map[string]struct {
						Value string `json:"value"`
					} `json:"extmetadata"`
				} `json:"imageinfo"`
			} `json:"pages"`
		} `json:"query"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&data); err != nil {
		return nil, err
	}
	out := make([]imageItem, 0, len(data.Query.Pages))
	for _, p := range data.Query.Pages {
		if len(p.Imageinfo) == 0 {
			continue
		}
		ii := p.Imageinfo[0]
		out = append(out, imageItem{
			URL: ii.URL, Thumb: ii.Thumburl, Title: p.Title,
			License: ii.Extmetadata["LicenseShortName"].Value,
			Author:  ii.Extmetadata["Artist"].Value,
			Page:    ii.Descriptionurl,
		})
	}
	return out, nil
}

func (s *server) serveImageFetch(w http.ResponseWriter, r *http.Request) {
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
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 dhvw-device/0.1")
	req.Header.Set("Accept", "image/*")
	resp, err := imageHTTPClient.Do(req)
	if err != nil {
		http.Error(w, "上游失败: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("上游 http %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "image/") {
		http.Error(w, "不是图片: "+ct, http.StatusUnsupportedMediaType)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 6<<20))
}

// imageHTTPClient 固定解析到公网 IP，防 DNS 重绑定与内网探测。
var imageHTTPClient = &http.Client{
	Timeout: 12 * time.Second,
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if !isPublicIP(ip.IP) {
					continue
				}
				d := net.Dialer{Timeout: 8 * time.Second}
				return d.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			}
			return nil, fmt.Errorf("拒绝非公网地址: %s", host)
		},
	},
}

func isPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v any) {
	writeJSONStatus(w, http.StatusOK, v)
}

func writeJSONStatus(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
