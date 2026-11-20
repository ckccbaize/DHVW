package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTourSaveWritesRecording(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.serveTourSave(rec, httptest.NewRequest(http.MethodPost, "/__tour/save?name=tour-1.webm", bytes.NewReader([]byte("webm-bytes"))))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if got["ok"] != true {
		t.Fatalf("响应异常: %v", got)
	}
	if p, _ := got["path"].(string); !strings.HasSuffix(p, "/recordings/tour-1.webm") {
		t.Fatalf("path 异常: %v", got["path"])
	}
	raw, err := os.ReadFile(filepath.Join(s.dataDir, "recordings", "tour-1.webm"))
	if err != nil || string(raw) != "webm-bytes" {
		t.Fatalf("落盘内容不对: %q err=%v", raw, err)
	}
}

func TestTourSaveRejectsBadName(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	for _, name := range []string{"../escape.webm", "a.txt", "x/y.webm", ""} {
		rec := httptest.NewRecorder()
		s.serveTourSave(rec, httptest.NewRequest(http.MethodPost, "/__tour/save?name="+name, bytes.NewReader([]byte("x"))))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%q 应被拒绝，得到 %d", name, rec.Code)
		}
	}
}

func TestTourSaveRejectsEmptyBody(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.serveTourSave(rec, httptest.NewRequest(http.MethodPost, "/__tour/save?name=tour-2.webm", bytes.NewReader(nil)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("空录像应被拒绝，得到 %d", rec.Code)
	}
}
