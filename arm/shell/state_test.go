package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServeStateRoundTrip(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	body := `{"v":1,"savedAt":123,"life":{"day":2,"minute":600},"agent":{"gx":8,"gy":8}}`
	rec := httptest.NewRecorder()
	s.serveState(rec, httptest.NewRequest(http.MethodPost, "/__state", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST want 200, got %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	s.serveState(rec, httptest.NewRequest(http.MethodGet, "/__state", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET want 200, got %d", rec.Code)
	}
	if strings.TrimSpace(rec.Body.String()) != body {
		t.Fatalf("GET body = %s", rec.Body.String())
	}
}

func TestServeStateRejectsInvalid(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.serveState(rec, httptest.NewRequest(http.MethodPost, "/__state", strings.NewReader("not json")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}
