#!/usr/bin/env python3
"""Buduje jednoplikową stronę HTML poradnika z `docs/11-poradnik.md`.

Strona nie ma zewnętrznych zależności (style i skrypt są w pliku), więc można ją wgrać na dowolny hosting
albo otworzyć z dysku. Ma spis treści z podświetlaniem sekcji, przyciski „Kopiuj" przy poleceniach,
motyw jasny i ciemny oraz układ na telefon.

Użycie (wymaga `pip install markdown`):
    python backend/tools/build_poradnik.py            # docs/11-poradnik.md → docs/poradnik.html
    python backend/tools/build_poradnik.py in.md out.html
"""

from __future__ import annotations

import html
import re
import sys
from pathlib import Path

import markdown

ROOT = Path(__file__).resolve().parents[2]
REPO_BLOB = "https://github.com/arkadiuszbaglaj/NetPulse/blob/main/docs/"


def slugify(value: str, separator: str) -> str:
    """Identyfikatory jak na GitHubie (z polskimi literami), żeby linki ze spisu w Markdownie działały."""
    value = re.sub(r"[^\w\- ]", "", value.lower()).strip()
    return re.sub(r"\s", separator, value)


def prepare(md: str) -> str:
    """Wyrzuca ręczny spis treści (strona ma własny) i kieruje linki do innych dokumentów na GitHuba."""
    md = re.sub(r"## Spis treści\n.*?\n---\n", "", md, flags=re.S)
    return re.sub(r"\]\((\d\d-[\w-]+\.md)\)", lambda m: f"]({REPO_BLOB}{m.group(1)})", md)


def build(md_text: str) -> str:
    md = markdown.Markdown(
        extensions=["fenced_code", "tables", "toc"],
        extension_configs={"toc": {"slugify": slugify, "permalink": False}},
    )
    body = md.convert(prepare(md_text))
    title_match = re.search(r"<h1[^>]*>(.*?)</h1>", body, flags=re.S)
    title = html.unescape(re.sub(r"<[^>]+>", "", title_match.group(1))) if title_match else "Poradnik"
    # Tabele w przewijanym kontenerze (wąskie ekrany)
    body = re.sub(r"<table>", '<div class="table-wrap"><table>', body)
    body = body.replace("</table>", "</table></div>")
    # Spis: tylko nagłówki drugiego poziomu
    nav = "\n".join(
        f'<li><a href="#{t["id"]}">{html.escape(t["name"])}</a></li>'
        for top in md.toc_tokens
        for t in top["children"]
    )
    return TEMPLATE.replace("{{TITLE}}", html.escape(title)).replace("{{NAV}}", nav).replace("{{BODY}}", body)


TEMPLATE = r"""<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{TITLE}}</title>
<meta name="description" content="Instalacja, konfiguracja i obsługa NetPulse: monitorowanie sieci w homelabie.">
<style>
:root {
  --bg: #f6f7f9; --surface: #ffffff; --surface-2: #eef1f5; --text: #1b2330; --text-2: #5a6678; --border: #dde2ea;
  --accent: #1f5fbf; --accent-soft: #e4eefc; --code-bg: #0f1722; --code-text: #e6edf6; --warn-bg: #fff4dc; --warn-border: #e8b84a;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0e131b; --surface: #151c27; --surface-2: #1c2533; --text: #e6ebf2; --text-2: #9aa7ba; --border: #28323f;
    --accent: #6ea8ff; --accent-soft: #1b2a44; --code-bg: #090d13; --code-text: #e6edf6; --warn-bg: #2d2412; --warn-border: #8a6a1f;
  }
}
:root[data-theme="dark"] {
  --bg: #0e131b; --surface: #151c27; --surface-2: #1c2533; --text: #e6ebf2; --text-2: #9aa7ba; --border: #28323f;
  --accent: #6ea8ff; --accent-soft: #1b2a44; --code-bg: #090d13; --code-text: #e6edf6; --warn-bg: #2d2412; --warn-border: #8a6a1f;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 76px; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); }
header.top {
  position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 16px;
  background: var(--surface); border-bottom: 1px solid var(--border);
}
header.top .brand { font-weight: 650; letter-spacing: .2px; margin-right: auto; }
header.top button {
  font: inherit; font-size: 14px; color: var(--text); background: var(--surface-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px; cursor: pointer;
}
header.top button:hover { border-color: var(--accent); }
#menu-btn { display: none; }
.layout { display: grid; grid-template-columns: 280px minmax(0, 1fr); max-width: 1200px; margin: 0 auto; gap: 32px; padding: 24px 16px 64px; }
nav.toc { position: sticky; top: 80px; align-self: start; max-height: calc(100vh - 96px); overflow: auto; padding-right: 8px; }
nav.toc h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--text-2); margin: 0 0 8px; }
nav.toc ul { list-style: none; margin: 0; padding: 0; }
nav.toc a {
  display: block; padding: 6px 10px; border-radius: 8px; color: var(--text-2); text-decoration: none; font-size: 14.5px; line-height: 1.35;
}
nav.toc a:hover { background: var(--surface-2); color: var(--text); }
nav.toc a.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
main { min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px 40px 40px; }
main h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 12px; }
main h2 { font-size: 1.45rem; margin: 2.4em 0 .6em; padding-top: .4em; border-top: 1px solid var(--border); line-height: 1.3; }
main h2:first-of-type { border-top: 0; margin-top: 1.6em; }
main h3 { font-size: 1.1rem; margin: 1.8em 0 .4em; }
main p, main li { color: var(--text); }
main li { margin: .25em 0; }
main hr { display: none; }
main code { font: .88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--surface-2); padding: .12em .4em; border-radius: 5px; }
.code { position: relative; margin: 1em 0; }
.code pre { margin: 0; background: var(--code-bg); color: var(--code-text); border-radius: 10px; padding: 14px 16px; overflow-x: auto; line-height: 1.55; }
.code pre code { background: none; padding: 0; color: inherit; font-size: .87rem; white-space: pre; }
.code button.copy {
  position: absolute; top: 8px; right: 8px; font: inherit; font-size: 12px; color: #cfd8e6; background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.18); border-radius: 6px; padding: 3px 9px; cursor: pointer;
}
.code button.copy:hover { background: rgba(255,255,255,.16); }
.code button.copy.done { color: #8fe0a8; border-color: #8fe0a8; }
.code pre { padding-right: 76px; }
.table-wrap { overflow-x: auto; margin: 1em 0; border: 1px solid var(--border); border-radius: 10px; }
table { border-collapse: collapse; width: 100%; font-size: .94rem; }
th, td { text-align: left; vertical-align: top; padding: 9px 12px; border-bottom: 1px solid var(--border); }
th { background: var(--surface-2); font-weight: 600; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
blockquote { margin: 1em 0; padding: 10px 16px; background: var(--warn-bg); border-left: 4px solid var(--warn-border); border-radius: 6px; }
blockquote p { margin: .3em 0; }
footer { max-width: 1200px; margin: 0 auto; padding: 0 16px 40px; color: var(--text-2); font-size: 14px; text-align: center; }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); padding-top: 16px; }
  #menu-btn { display: inline-block; }
  nav.toc {
    position: fixed; inset: 56px 0 0 0; z-index: 15; max-height: none; background: var(--surface); padding: 16px; display: none;
  }
  nav.toc.open { display: block; }
  main { padding: 22px 18px 28px; border-radius: 12px; }
  main h1 { font-size: 1.6rem; }
}
@media print { header.top, nav.toc, .copy { display: none !important; } .layout { display: block; } main { border: 0; padding: 0; } }
</style>
</head>
<body>
<header class="top">
  <button id="menu-btn" type="button" aria-expanded="false" aria-controls="toc">Spis treści</button>
  <span class="brand">NetPulse · poradnik</span>
  <button id="theme-btn" type="button" aria-label="Przełącz motyw jasny i ciemny">Motyw</button>
</header>
<div class="layout">
  <nav class="toc" id="toc" aria-label="Spis treści">
    <h2>Spis treści</h2>
    <ul>
{{NAV}}
    </ul>
  </nav>
  <main id="content">
{{BODY}}
  </main>
</div>
<footer>NetPulse · self-hosted monitoring sieci w homelabie</footer>
<script>
(function () {
  var root = document.documentElement;
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

  // Motyw: zapamiętany wybór, inaczej ustawienie systemu
  var saved = store("poradnik-theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  document.getElementById("theme-btn").addEventListener("click", function () {
    var dark = root.getAttribute("data-theme") === "dark" ||
      (!root.getAttribute("data-theme") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var next = dark ? "light" : "dark";
    root.setAttribute("data-theme", next);
    store("poradnik-theme", next);
  });

  // Spis treści na telefonie
  var toc = document.getElementById("toc"), menuBtn = document.getElementById("menu-btn");
  menuBtn.addEventListener("click", function () {
    var open = toc.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", String(open));
  });
  toc.addEventListener("click", function (e) {
    if (e.target.tagName === "A") { toc.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); }
  });

  // Przyciski „Kopiuj" przy blokach kodu
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); } finally { document.body.removeChild(ta); }
    });
  }
  document.querySelectorAll("main pre").forEach(function (pre) {
    var wrap = document.createElement("div");
    wrap.className = "code";
    pre.parentNode.insertBefore(wrap, pre);
    wrap.appendChild(pre);
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "copy"; btn.textContent = "Kopiuj";
    btn.addEventListener("click", function () {
      var text = pre.innerText.replace(/\n$/, "");
      copyText(text).then(function () {
        btn.textContent = "Skopiowano"; btn.classList.add("done");
      }, function () { btn.textContent = "Zaznacz i skopiuj"; });
      setTimeout(function () { btn.textContent = "Kopiuj"; btn.classList.remove("done"); }, 1800);
    });
    wrap.appendChild(btn);
  });

  // Podświetlanie bieżącej sekcji w spisie
  var links = Array.prototype.slice.call(document.querySelectorAll("nav.toc a"));
  var byId = {};
  links.forEach(function (a) { byId[decodeURIComponent(a.getAttribute("href").slice(1))] = a; });
  var heads = Array.prototype.slice.call(document.querySelectorAll("main h2")).filter(function (h) { return byId[h.id]; });
  function spy() {
    var current = heads[0];
    heads.forEach(function (h) { if (h.getBoundingClientRect().top <= 100) current = h; });
    links.forEach(function (a) { a.classList.remove("active"); });
    if (current && byId[current.id]) byId[current.id].classList.add("active");
  }
  window.addEventListener("scroll", spy, { passive: true });
  spy();
})();
</script>
</body>
</html>
"""


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "11-poradnik.md"
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "docs" / "poradnik.html"
    out.write_text(build(src.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Zapisano {out} ({out.stat().st_size // 1024} kB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
