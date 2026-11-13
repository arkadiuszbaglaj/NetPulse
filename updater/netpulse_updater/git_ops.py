"""Operacje na repozytorium instalacji: bieżąca wersja i sprawdzanie, co jest do pobrania."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from .config import Settings
from .state import now_iso

VERSION_RE = re.compile(r'^__version__\s*=\s*"([^"]+)"', re.MULTILINE)
VERSION_FILE = "backend/netpulse/__init__.py"
MAX_CHANGES = 50
# Klucze, którymi wolno podpisać aktualizację (format allowed_signers z ssh-keygen). Zaufany jest plik z ZAINSTALOWANEJ
# wersji – nowy klucz może więc wprowadzić tylko aktualizacja podpisana kluczem dotychczasowym.
SIGNERS_FILE = "deploy/update-signers"
UNSIGNED = (
    "Aktualizacja w źródle nie ma prawidłowego podpisu UplinkView – nie zostanie zainstalowana. "
    "Jeśli świadomie używasz własnego źródła aktualizacji, ustaw NETPULSE_UPDATE_VERIFY=off w deploy/.env."
)


class UpdateError(Exception):
    """Błąd, który można pokazać użytkownikowi."""


def sh(cmd: list[str], cwd: Path, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise UpdateError(f"Polecenie trwało zbyt długo: {' '.join(cmd[:3])}") from exc
    except FileNotFoundError as exc:
        raise UpdateError(f"Brak programu: {cmd[0]}") from exc


# Repozytorium przeniesione przy zmianie nazwy na UplinkView (0.78.0). GitHub przekierowuje stary adres, dopóki nikt nie
# zajmie starej nazwy – updater przestawia `origin` na nowy adres sam (bez NETPULSE_UPDATE_REPO).
NEW_REPO = "https://github.com/uplinkview/uplinkview.git"
_OLD_REPO = re.compile(r"github\.com[/:]arkadiuszbaglaj/netpulse(\.git)?/?$", re.IGNORECASE)


def set_origin(s: Settings) -> None:
    """Adres źródła przed pobraniem: NETPULSE_UPDATE_REPO albo – zamiast starego adresu repozytorium – nowy."""
    if s.repo_url:
        sh(["git", "remote", "set-url", "origin", s.repo_url], s.install_dir)
        return
    r = sh(["git", "remote", "get-url", "origin"], s.install_dir)
    if r.returncode == 0 and _OLD_REPO.search(r.stdout.strip()):
        sh(["git", "remote", "set-url", "origin", NEW_REPO], s.install_dir)


def parse_version(text: str) -> str | None:
    m = VERSION_RE.search(text)
    return m.group(1) if m else None


def _out(s: Settings, *args: str, timeout: int = 60) -> str:
    r = sh(["git", *args], s.install_dir, timeout)
    if r.returncode != 0:
        raise UpdateError(f"git {args[0]}: {(r.stderr or r.stdout).strip()[-300:]}")
    return r.stdout.strip()


def signature_required(s: Settings) -> bool:
    """Podpis sprawdzamy, gdy instalacja ma listę zaufanych kluczy (wersje od 0.69.0) i nie wyłączono tego w .env."""
    return s.verify_signatures and (s.install_dir / SIGNERS_FILE).is_file()


def verify_commit(s: Settings, commit: str) -> None:
    """Sprawdza, że `commit` jest podpisany kluczem SSH z listy zaufanych zainstalowanej wersji (od 0.69.0).

    Podpis ostatniego commita obejmuje całą historię przed nim (skróty), więc wystarczy jeden. Chroni przed
    podmianą kodu w źródle: ktoś, kto przejmie konto na GitHubie, nie ma klucza i nie podpisze zmiany.
    Wywoływać z pełnym skrótem commita i ten sam skrót instalować – nie nazwę gałęzi, która może się przesunąć."""
    if not signature_required(s):
        return
    signers = s.install_dir / SIGNERS_FILE
    r = sh(
        ["git", "-c", "gpg.format=ssh", "-c", f"gpg.ssh.allowedSignersFile={signers}", "verify-commit", commit],
        s.install_dir,
    )
    if r.returncode != 0:
        detail = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["brak podpisu"]
        raise UpdateError(f"{UNSIGNED} ({detail[0][:160]})")


def branch_name(s: Settings) -> str:
    if s.branch:
        return s.branch
    name = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], s.install_dir).stdout.strip()
    return name if name and name != "HEAD" else "main"  # odłączony HEAD → główna gałąź


def installed_version(s: Settings) -> str | None:
    try:
        return parse_version((s.install_dir / VERSION_FILE).read_text(encoding="utf-8"))
    except OSError:
        return None


def current(s: Settings) -> dict[str, Any]:
    """Zainstalowana wersja i commit (z katalogu instalacji)."""
    r = sh(["git", "rev-parse", "--short", "HEAD"], s.install_dir)
    return {
        "version": installed_version(s),
        "commit": r.stdout.strip() if r.returncode == 0 else None,
        "branch": branch_name(s),
    }


def check(s: Settings, fetch: bool = True) -> dict[str, Any]:
    """Pobiera informacje ze źródła (git fetch) i zwraca, co jest do zainstalowania.
    `fetch=False` liczy wynik na nowo z tego, co już pobrano (bez łączenia się ze źródłem)."""
    branch = branch_name(s)
    if fetch:
        set_origin(s)
        r = sh(["git", "fetch", "--quiet", "origin", branch], s.install_dir, timeout=120)
        if r.returncode != 0:
            detail = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["brak szczegółów"]
            raise UpdateError(f"Nie udało się połączyć ze źródłem aktualizacji: {detail[0][:200]}")

    remote = f"origin/{branch}"
    behind = int(_out(s, "rev-list", "--count", f"HEAD..{remote}"))
    if behind:
        # Niepodpisanej wersji nie pokazujemy jako dostępnej – panel dostaje czytelny błąd zamiast przycisku „Zainstaluj”
        verify_commit(s, _out(s, "rev-parse", remote))
    ahead = int(_out(s, "rev-list", "--count", f"{remote}..HEAD"))
    changes = []
    if behind:
        raw = _out(s, "log", "--no-merges", f"--max-count={MAX_CHANGES}", "--format=%h%x09%s", f"HEAD..{remote}")
        for line in raw.splitlines():
            sha, _, subject = line.partition("\t")
            changes.append({"sha": sha, "subject": subject})
    show = sh(["git", "show", f"{remote}:{VERSION_FILE}"], s.install_dir)
    latest_version = parse_version(show.stdout) if show.returncode == 0 else None
    cur = current(s)
    return {
        "current": cur,
        "latest": {"version": latest_version, "commit": _out(s, "rev-parse", "--short", remote)},
        "behind": behind,
        "ahead": ahead,
        # Lokalne commity, których nie ma w źródle, uniemożliwiają proste przesunięcie – wtedy nie aktualizujemy
        "diverged": ahead > 0 and behind > 0,
        "update_available": behind > 0 and ahead == 0,
        "changes": changes,
        "checked_at": now_iso(),
    }
