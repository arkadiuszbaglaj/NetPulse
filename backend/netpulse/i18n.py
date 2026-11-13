"""Język odpowiedzi API (od 0.75.0, etap 4b; opis: docs/44-jezyk-angielski.md).

Backend pisze komunikaty po polsku (błędy, tytuły alertów, opisy). Panel wysyła `Accept-Language` z wybranym
językiem; dla angielskiego `LanguageMiddleware` tłumaczy teksty w odpowiedziach JSON pod /api według katalogu
`messages.py`. Bez nagłówka (albo z polskim) odpowiedź zostaje bez zmian – stare klienty i testy działają jak dotąd.
Tekst spoza katalogu (nazwy urządzeń, odpowiedzi urządzeń) przechodzi bez zmian.
"""

from __future__ import annotations

import json
import re
from contextvars import ContextVar
from functools import lru_cache

from .messages import MESSAGES

# Język serwera (od 0.76.0): powiadomienia; panel i raporty mają język przeglądarki
SERVER_LANGUAGE_KEY = "language"

LANGUAGES = ("pl", "en")
DEFAULT = "pl"
_language: ContextVar[str] = ContextVar("netpulse_language", default=DEFAULT)

PLACEHOLDER = re.compile(r"\{(\w+)\}")
# Zmienne o szczególnym kształcie; reszta dopasowuje dowolny tekst (najkrócej, wzorzec jest zakotwiczony)
# (`num…` = liczba z opcjonalną jednostką: „91,5%”, „100,0 Mb/s”, „13,0 dni”)
SHAPES = {"op": r"[<>]", "num": r"-?\d[\d.,]*(?: ?[^\s\d]\S*)?"}
VALUE_ERROR = "Value error, "
# Ścieżki z dużymi odpowiedziami bez komunikatów (serie liczb) i z odpowiedziami nie-JSON
SKIP_PREFIXES = ("/api/live", "/api/agent/v1/")
SKIP_PARTS = ("/metrics",)
MAX_BODY = 4 * 1024 * 1024


def current_language() -> str:
    return _language.get()


def parse_accept_language(header: str | None) -> str:
    """Język z nagłówka `Accept-Language` (najwyższe q spośród obsługiwanych); inny albo brak – polski."""
    best, best_q = DEFAULT, -1.0
    for part in (header or "").split(","):
        tag, *params = (p.strip() for p in part.split(";"))
        q = 1.0
        for param in params:
            if param.startswith("q="):
                try:
                    q = float(param[2:])
                except ValueError:
                    q = 0.0
        primary = tag.lower().split("-")[0]
        if primary in LANGUAGES and q > best_q:
            best, best_q = primary, q
    return best


class _Template:
    __slots__ = ("names", "regex", "target", "anchor", "literal")

    def __init__(self, source: str, target: str) -> None:
        parts, names, pos = [], [], 0
        for m in PLACEHOLDER.finditer(source):
            parts.append(re.escape(source[pos : m.start()]))
            name = m.group(1)
            shape = SHAPES["num"] if name.startswith("num") else SHAPES.get(name, ".+?")
            parts.append(f"(?P<{name}>{shape})")
            names.append(name)
            pos = m.end()
        parts.append(re.escape(source[pos:]))
        self.names = names
        self.regex = re.compile("".join(parts) + r"\Z", re.S)
        self.target = target
        # Najdłuższy stały kawałek: szybkie odrzucenie tekstu bez niego, zanim zadziała wyrażenie regularne
        literals = PLACEHOLDER.split(source)[::2]
        self.anchor = max(literals, key=len)
        self.literal = sum(map(len, literals))

    def apply(self, text: str) -> str | None:
        if self.anchor not in text:
            return None
        m = self.regex.match(text)
        if m is None:
            return None
        values = {name: _param(name, m.group(name)) for name in self.names}
        return PLACEHOLDER.sub(lambda p: values[p.group(1)], self.target)


def _param(name: str, value: str) -> str:
    if name.startswith("num"):
        value = re.sub(r"(?<=\d),(?=\d)", ".", value)
        return re.sub(r" dni\Z", " days", value)
    if name == "op":
        return value
    return translate(value, "en")


EXACT: dict[str, str] = {}
TEMPLATES: list[_Template] = []
for _pl, _en in MESSAGES:
    if PLACEHOLDER.search(_pl):
        TEMPLATES.append(_Template(_pl, _en))
    else:
        EXACT[_pl] = _en
# Dłuższy stały tekst najpierw: „… przez {minutes} min” przed krótszym wzorcem bez tej końcówki
TEMPLATES.sort(key=lambda t: -t.literal)


@lru_cache(maxsize=8192)
def _to_english(text: str) -> str:
    if text in EXACT:
        return EXACT[text]
    if text.startswith(VALUE_ERROR):  # walidacja Pydantic: „Value error, <nasz komunikat>”
        return VALUE_ERROR + _to_english(text[len(VALUE_ERROR) :])
    for template in TEMPLATES:
        out = template.apply(text)
        if out is not None:
            return out
    if "\n" in text:
        return "\n".join(_to_english(line) for line in text.split("\n"))
    return text


def translate(text: str, lang: str | None = None) -> str:
    """Komunikat w języku `lang` (domyślnie języku bieżącego żądania). Spoza katalogu – bez zmian."""
    if (lang or current_language()) != "en" or len(text) < 2 or len(text) > 2000 or text[0].isdigit():
        return text
    return _to_english(text)


def translate_data(data, lang: str = "en"):
    """Wszystkie teksty w strukturze z JSON-a (bez kluczy słowników)."""
    if isinstance(data, str):
        return translate(data, lang)
    if isinstance(data, list):
        return [translate_data(v, lang) for v in data]
    if isinstance(data, dict):
        return {k: translate_data(v, lang) for k, v in data.items()}
    return data


def _skipped(path: str) -> bool:
    return not path.startswith("/api/") or path.startswith(SKIP_PREFIXES) or any(p in path for p in SKIP_PARTS)


class LanguageMiddleware:
    """Czysty middleware ASGI: ustawia język żądania i tłumaczy odpowiedzi JSON dla `Accept-Language: en`."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        header = next((v.decode("latin-1") for k, v in scope.get("headers", ()) if k == b"accept-language"), None)
        lang = parse_accept_language(header)
        token = _language.set(lang)
        try:
            if scope["type"] != "http" or lang == DEFAULT or _skipped(scope.get("path", "")):
                await self.app(scope, receive, send)
            else:
                await self._translated(scope, receive, send, lang)
        finally:
            _language.reset(token)

    async def _translated(self, scope, receive, send, lang: str) -> None:
        start: dict | None = None
        chunks: list[bytes] = []
        passthrough = False

        async def wrapped(message) -> None:
            nonlocal start, passthrough
            if message["type"] == "http.response.start":
                headers = {k.lower(): v for k, v in message.get("headers", ())}
                json_body = headers.get(b"content-type", b"").startswith(b"application/json")
                if not json_body or b"content-encoding" in headers:
                    passthrough = True
                    await send(message)
                else:
                    start = message
                return
            if message["type"] != "http.response.body" or passthrough:
                await send(message)
                return
            chunks.append(message.get("body", b""))
            if message.get("more_body", False):
                return
            body = b"".join(chunks)
            if 0 < len(body) <= MAX_BODY:
                try:
                    body = json.dumps(translate_data(json.loads(body), lang), ensure_ascii=False, separators=(",", ":")).encode()
                except ValueError:
                    pass
            assert start is not None
            headers = [(k, v) for k, v in start.get("headers", ()) if k.lower() != b"content-length"]
            headers.append((b"content-length", str(len(body)).encode()))
            await send({**start, "headers": headers})
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, wrapped)


async def server_language(session) -> str:
    """Język powiadomień zapisany w ustawieniach (`app_settings`), domyślnie polski."""
    from .db.models import AppSetting

    row = await session.get(AppSetting, SERVER_LANGUAGE_KEY)
    value = (row.value or {}).get("language") if row else None
    return value if value in LANGUAGES else DEFAULT


async def save_server_language(session, lang: str) -> None:
    from .db.models import AppSetting

    row = await session.get(AppSetting, SERVER_LANGUAGE_KEY, with_for_update=True)
    if row is None:
        session.add(AppSetting(key=SERVER_LANGUAGE_KEY, value={"language": lang}))
    else:
        row.value = {"language": lang}
