// 巡演录像保存（2026-11-19）：tour.html 录完的 webm 直接落设备 data/recordings/。
// 设备 kiosk 没有文件管理器，浏览器下载在无桌面环境里等于丢素材，所以由外壳代收。
package main

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
)

const maxTourRecordingBytes = 512 << 20

var tourRecordingName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,80}\.webm$`)

func (s *server) serveTourSave(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := r.URL.Query().Get("name")
	if !tourRecordingName.MatchString(name) {
		http.Error(w, "非法录像文件名", http.StatusBadRequest)
		return
	}
	dir := filepath.Join(s.dataDir, "recordings")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, "创建目录失败", http.StatusInternalServerError)
		return
	}
	dst := filepath.Join(dir, name)
	tmp := dst + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		http.Error(w, "写入失败", http.StatusInternalServerError)
		return
	}
	n, err := io.Copy(f, io.LimitReader(r.Body, maxTourRecordingBytes+1))
	closeErr := f.Close()
	if err != nil || closeErr != nil {
		_ = os.Remove(tmp)
		http.Error(w, "读取请求体失败", http.StatusBadRequest)
		return
	}
	if n == 0 {
		_ = os.Remove(tmp)
		http.Error(w, "录像为空", http.StatusBadRequest)
		return
	}
	if n > maxTourRecordingBytes {
		_ = os.Remove(tmp)
		http.Error(w, "录像超过 512MB", http.StatusRequestEntityTooLarge)
		return
	}
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		http.Error(w, "替换失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":    true,
		"path":  filepath.ToSlash(filepath.Join(filepath.Base(s.dataDir), "recordings", name)),
		"bytes": n,
	})
}
