"""Public web search and page-fetch helper CLI for DHVW orchestrator agents.

Combines public encyclopedia APIs (Wikipedia zh/en, Baidu Baike lemma API) and
Bing CN RSS search so the persona agent can research existing characters or lore
reliably without browser dependencies or anti-bot bypasses.
"""

from __future__ import annotations

import argparse
import html
import ipaddress
import json
import re
import socket
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from typing import Any

USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


class _TextExtractor(HTMLParser):
    """Strip scripts/styles and extract clean paragraph text from HTML."""

    SKIP_TAGS = {"script", "style", "noscript", "svg", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() in self.SKIP_TAGS:
            self._skip_depth += 1
        elif self._skip_depth == 0 and tag.lower() in ("p", "div", "br", "li", "h1", "h2", "h3", "h4", "tr"):
            self._parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0 and data:
            self._parts.append(data)

    def text(self) -> str:
        raw = "".join(self._parts)
        lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in raw.splitlines()]
        return "\n".join(ln for ln in lines if ln)


def _is_public_url(url: str) -> bool:
    """Validate URL scheme and reject private/loopback host targets."""
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host in ("localhost", "ip6-localhost"):
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return True
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        except ValueError:
            continue
    return True


def _http_get(url: str, timeout: float = 8.0, max_bytes: int = 262_144) -> tuple[int, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read(max_bytes)
        charset = resp.headers.get_content_charset() or "utf-8"
        return int(resp.status), data.decode(charset, errors="replace")


def _search_wiki(lang: str, query: str, limit: int) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    results: list[dict[str, Any]] = []
    summaries: list[dict[str, str]] = []
    q = urllib.parse.quote(query)
    url = (
        f"https://{lang}.wikipedia.org/w/api.php"
        f"?action=query&list=search&srsearch={q}&format=json&utf8=1&srlimit={limit}"
    )
    _, body = _http_get(url)
    data = json.loads(body)
    hits = ((data.get("query") or {}).get("search")) or []
    for item in hits[:limit]:
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        snippet = re.sub(r"<[^>]+>", "", html.unescape(str(item.get("snippet") or ""))).strip()
        page_url = f"https://{lang}.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}"
        results.append({"source": f"{lang}wiki", "title": title, "url": page_url, "snippet": snippet})
    if hits:
        top_title = urllib.parse.quote(str(hits[0].get("title") or "").strip())
        if top_title:
            ext_url = (
                f"https://{lang}.wikipedia.org/w/api.php"
                f"?action=query&prop=extracts&explaintext=1&exintro=1&titles={top_title}&format=json&utf8=1"
            )
            try:
                _, ext_body = _http_get(ext_url)
                pages = ((json.loads(ext_body).get("query") or {}).get("pages")) or {}
                for page in pages.values():
                    extract = str(page.get("extract") or "").strip()
                    if extract:
                        summaries.append(
                            {
                                "source": f"{lang}wiki",
                                "title": str(page.get("title") or ""),
                                "url": f"https://{lang}.wikipedia.org/wiki/{top_title}",
                                "summary": extract[:2000],
                            }
                        )
            except Exception:
                pass
    return results, summaries


def _search_baike(query: str) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    q = urllib.parse.quote(query)
    url = f"https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key={q}"
    _, body = _http_get(url)
    data = json.loads(body)
    if not isinstance(data, dict) or not data.get("abstract"):
        return [], []
    title = str(data.get("title") or query)
    page_url = str(data.get("url") or f"https://baike.baidu.com/item/{q}")
    abstract = str(data.get("abstract") or "").strip()
    card_items = data.get("card") or []
    attrs: list[str] = []
    for entry in card_items[:12]:
        if isinstance(entry, dict) and entry.get("name") and entry.get("value"):
            val = entry["value"]
            val_str = ", ".join(str(x) for x in val) if isinstance(val, list) else str(val)
            val_str = re.sub(r"<[^>]+>", "", val_str).strip()
            if val_str:
                attrs.append(f"{entry['name']}: {val_str}")
    full_summary = abstract + ("\n" + "\n".join(attrs) if attrs else "")
    return (
        [{"source": "baike", "title": f"{title}_百度百科", "url": page_url, "snippet": abstract[:220]}],
        [{"source": "baike", "title": title, "url": page_url, "summary": full_summary[:2200]}],
    )


def _search_bing_rss(query: str, limit: int) -> list[dict[str, Any]]:
    q = urllib.parse.quote(query)
    _, xml_txt = _http_get(f"https://cn.bing.com/search?format=rss&q={q}")
    if not xml_txt.lstrip().startswith("<"):
        return []
    root = ET.fromstring(xml_txt)
    out: list[dict[str, Any]] = []
    for item in root.findall(".//item")[:limit]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        desc = re.sub(r"<[^>]+>", "", (item.findtext("description") or "")).strip()
        if title and link:
            out.append({"source": "bing", "title": title, "url": link, "snippet": desc})
    return out


def search_web(query: str, limit: int = 8) -> dict[str, Any]:
    """Search Bing RSS, Wikipedia, and Baidu Baike for character lore/details."""
    clean_q = " ".join(str(query or "").split())
    if not clean_q:
        return {"ok": False, "error": "empty_query", "results": [], "summaries": []}

    results: list[dict[str, Any]] = []
    summaries: list[dict[str, str]] = []
    errors: list[str] = []

    # Try Baike directly on the short core entity keyword if present
    baike_key = clean_q.split()[0]
    for label, fn in (
        ("bing", lambda: (_search_bing_rss(clean_q, limit), [])),
        ("baike", lambda: _search_baike(baike_key)),
        ("zhwiki", lambda: _search_wiki("zh", clean_q, min(limit, 5))),
        ("enwiki", lambda: _search_wiki("en", clean_q, min(limit, 3))),
    ):
        try:
            r, s = fn()
            results.extend(r)
            summaries.extend(s)
        except Exception as exc:
            errors.append(f"{label}: {exc}")

    seen_urls: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for item in results:
        u = item.get("url") or ""
        if u and u not in seen_urls:
            seen_urls.add(u)
            deduped.append(item)

    return {
        "ok": True,
        "query": clean_q,
        "results": deduped[: max(limit, 12)],
        "summaries": summaries,
        "errors": errors,
    }


def fetch_page(url: str, max_chars: int = 8000) -> dict[str, Any]:
    """Fetch a public webpage and extract plain text for character research."""
    clean_url = str(url or "").strip()
    if not _is_public_url(clean_url):
        return {"ok": False, "url": clean_url, "error": "disallowed_or_invalid_url"}
    try:
        status, body = _http_get(clean_url, timeout=10.0, max_bytes=393_216)
    except Exception as exc:
        return {"ok": False, "url": clean_url, "error": str(exc)}

    title_match = re.search(r"<title[^>]*>(.*?)</title>", body, flags=re.IGNORECASE | re.DOTALL)
    title = html.unescape(re.sub(r"<[^>]+>", "", title_match.group(1))).strip() if title_match else ""
    extractor = _TextExtractor()
    extractor.feed(body)
    text = extractor.text()
    lower = text[:800].lower()
    if "captcha" in lower or "verify you are human" in lower or "attention required! | cloudflare" in lower:
        return {"ok": False, "url": clean_url, "status": status, "error": "blocked_by_captcha"}

    return {
        "ok": True,
        "url": clean_url,
        "status": status,
        "title": title,
        "text": text[: max(500, min(max_chars, 20_000))],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dhvw_orchestrator.web_search")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_search = sub.add_parser("search", help="Search public web/encyclopedias")
    p_search.add_argument("query")
    p_search.add_argument("--limit", type=int, default=8)
    p_fetch = sub.add_parser("fetch", help="Fetch public page plain text")
    p_fetch.add_argument("url")
    p_fetch.add_argument("--max-chars", type=int, default=8000)
    args = parser.parse_args(argv)

    if args.cmd == "search":
        res = search_web(args.query, args.limit)
    else:
        res = fetch_page(args.url, args.max_chars)
    print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
