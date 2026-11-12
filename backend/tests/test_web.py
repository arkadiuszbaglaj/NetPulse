"""Serwowanie panelu: fallback dla adresów aplikacji, JSON-owe 404 dla /api, cache, bezpieczeństwo ścieżek."""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from netpulse.api.web import mount_web


@pytest.fixture
def client(tmp_path):
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<html>PANEL</html>")
    (web / "favicon.svg").write_text("<svg/>")
    (web / "manifest.webmanifest").write_text("{}")
    (web / "assets" / "app-abc123.js").write_text("console.log(1)")
    (tmp_path / "sekret.txt").write_text("nie wolno")

    app = FastAPI()

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    assert mount_web(app, web) is True
    return TestClient(app)


def test_root_and_app_routes_return_index(client):
    for path in ("/", "/settings/account", "/jakis/glebszy/adres"):
        r = client.get(path)
        assert r.status_code == 200 and "PANEL" in r.text, path
        assert r.headers["cache-control"] == "no-cache"


def test_api_routes_win_and_unknown_api_is_json_404(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    r = client.get("/api/nie-ma-takiego")
    assert r.status_code == 404 and r.json() == {"detail": "Not Found"}
    assert client.get("/api").status_code == 404


def test_static_files_and_hashed_assets_cache(client):
    assert client.get("/favicon.svg").text == "<svg/>"
    assert client.get("/manifest.webmanifest").headers["content-type"].startswith("application/manifest+json")
    r = client.get("/assets/app-abc123.js")
    assert r.status_code == 200
    assert "immutable" in r.headers["cache-control"]
    assert client.get("/assets/nie-ma.js").status_code == 404


@pytest.mark.parametrize("path", ["/../sekret.txt", "/%2e%2e/sekret.txt", "/..%2fsekret.txt", "/assets/../../sekret.txt"])
def test_no_path_traversal(client, path):
    r = client.get(path)
    assert "nie wolno" not in r.text


def test_missing_web_dir_is_skipped(tmp_path):
    assert mount_web(FastAPI(), tmp_path / "nie-ma") is False


def test_inline_script_hashes_and_policy():
    """Pełny CSP (od 0.68.0): skrót skryptu wpisanego w stronę, skrypty z plików bez skrótu, brak 'unsafe-inline' dla skryptów."""
    import base64
    import hashlib

    from netpulse.api.web import content_security_policy, inline_script_hashes, panel_script_hashes

    body = "\n      document.documentElement.dataset.theme = 'dark';\n    "
    html = f'<html><head><script>{body}</script><script type="module" crossorigin src="/assets/index.js"></script></head></html>'
    expected = "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
    assert inline_script_hashes(html) == [expected]
    assert inline_script_hashes("<html><script src='/a.js'></script></html>") == []

    policy = content_security_policy([expected])
    assert f"script-src 'self' {expected};" in policy
    assert "default-src 'self'" in policy and "frame-ancestors 'self'" in policy and "object-src 'none'" in policy
    script_src = next(part for part in policy.split("; ") if part.startswith("script-src"))
    assert "unsafe-inline" not in script_src and "unsafe-eval" not in policy
    assert content_security_policy().split("; ")[1] == "script-src 'self'"
    assert panel_script_hashes("/nie/ma/takiego/katalogu") == []


def test_panel_script_hashes_from_built_index(tmp_path):
    from netpulse.api.web import panel_script_hashes

    (tmp_path / "index.html").write_text("<html><script>var a = 1;</script></html>", encoding="utf-8")
    hashes = panel_script_hashes(tmp_path)
    assert len(hashes) == 1 and hashes[0].startswith("'sha256-")
