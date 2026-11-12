package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDigestRoundTrip(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	body := `{"v":1,"ts":1,"agenda":[{"kind":"outing"}]}`

	rec := httptest.NewRecorder()
	s.serveDigest(rec, httptest.NewRequest(http.MethodPost, "/__digest", strings.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST want 200, got %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	s.serveDigest(rec, httptest.NewRequest(http.MethodGet, "/__digest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET want 200, got %d", rec.Code)
	}
	if rec.Body.String() != body {
		t.Fatalf("roundtrip mismatch: %s", rec.Body.String())
	}
}

func TestDigestRejectsBadJSON(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.serveDigest(rec, httptest.NewRequest(http.MethodPost, "/__digest", strings.NewReader("not json")))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("want 400, got %d", rec.Code)
	}
}

func TestDigestRejectsOversize(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	big := bytes.Repeat([]byte("a"), maxDigestBytes+1)
	rec := httptest.NewRecorder()
	s.serveDigest(rec, httptest.NewRequest(http.MethodPost, "/__digest", bytes.NewReader(big)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d", rec.Code)
	}
}

func TestDigestMissing(t *testing.T) {
	s := &server{dataDir: t.TempDir()}
	rec := httptest.NewRecorder()
	s.serveDigest(rec, httptest.NewRequest(http.MethodGet, "/__digest", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404, got %d", rec.Code)
	}
}
