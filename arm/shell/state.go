// 设备状态文件（2026-11-14）：浏览器会话/IndexedDB 丢失后可从本地文件恢复。
// 路径：<root 的父目录>/data/state.json；仅回环可访问。
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

const maxStateBytes = 2 << 20

func (s *server) serveState(w http.ResponseWriter, r *http.Request) {
	p := filepath.Join(s.dataDir, "state.json")
	switch r.Method {
	case http.MethodGet:
		raw, err := os.ReadFile(p)
		if err != nil {
			http.Error(w, "state 尚未生成", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(raw)
	case http.MethodPost:
		body, err := io.ReadAll(io.LimitReader(r.Body, maxStateBytes+1))
		if err != nil {
			http.Error(w, "读取失败", http.StatusBadRequest)
			return
		}
		if len(body) > maxStateBytes {
			http.Error(w, "state 超过 2MB", http.StatusRequestEntityTooLarge)
			return
		}
		if !json.Valid(body) {
			http.Error(w, "不是合法 JSON", http.StatusBadRequest)
			return
		}
		if err := os.MkdirAll(s.dataDir, 0o755); err != nil {
			http.Error(w, "创建目录失败", http.StatusInternalServerError)
			return
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, body, 0o644); err != nil {
			http.Error(w, "写入失败", http.StatusInternalServerError)
			return
		}
		if err := os.Rename(tmp, p); err != nil {
			http.Error(w, "替换失败", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"ok":true}`))
	default:
		w.Header().Set("Allow", "GET, POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
