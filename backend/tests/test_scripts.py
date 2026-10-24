"""Kontrola miejsca na dysku w `scripts/netpulse` i `install.sh` – na atrapach `docker` i `df`.

Skrypty ładujemy poleceniem `source` (strażnik na końcu pliku nie uruchamia wtedy `main`),
a `docker` i `df` podmieniamy skryptami z katalogu tymczasowego.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NETPULSE = ROOT / "scripts" / "netpulse"
INSTALL = ROOT / "install.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="brak basha")

DF_STUB = """#!/bin/sh
f="$STUB_DIR/free_mb"
[ -f "$f" ] || exit 1
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/x 1 1 $(( $(cat "$f") * 1024 )) 1% /"
"""

DOCKER_STUB = """#!/bin/sh
echo "$*" >>"$STUB_DIR/docker.log"
case "$1" in
  info) echo "$STUB_DIR" ;;
  builder)
    # „Sprzątanie” zwalnia miejsce, jeśli test to przewidział
    if [ -f "$STUB_DIR/after_prune_mb" ]; then cp "$STUB_DIR/after_prune_mb" "$STUB_DIR/free_mb"; fi
    ;;
esac
exit 0
"""


def posix(p: Path) -> str:
    """Ścieżka w postaci zrozumiałej dla basha także na Windowsie (C:/x → /c/x)."""
    s = p.as_posix()
    if sys.platform == "win32" and len(s) > 2 and s[1] == ":":
        s = f"/{s[0].lower()}{s[2:]}"
    return s


class Env:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.bin = tmp / "bin"
        self.bin.mkdir()
        (self.bin / "df").write_text(DF_STUB, newline="\n")
        (self.bin / "docker").write_text(DOCKER_STUB, newline="\n")
        for f in self.bin.iterdir():
            f.chmod(0o755)

    def free(self, mb: int | None, after_prune: int | None = None):
        if mb is not None:
            (self.tmp / "free_mb").write_text(str(mb))
        if after_prune is not None:
            (self.tmp / "after_prune_mb").write_text(str(after_prune))

    def run(self, script_file: Path, code: str, **env: str) -> subprocess.CompletedProcess:
        cmd = (
            f'export PATH="{posix(self.bin)}:$PATH"; export STUB_DIR="{posix(self.tmp)}"; '
            f'source "{posix(script_file)}"; {code}'
        )
        return subprocess.run(
            ["bash", "-c", cmd],
            capture_output=True,
            text=True,
            encoding="utf-8",  # skrypty wypisują polskie znaki w UTF-8, niezależnie od strony kodowej systemu
            env={**os.environ, **env},
            timeout=60,
        )

    @property
    def docker_log(self) -> str:
        f = self.tmp / "docker.log"
        return f.read_text() if f.exists() else ""


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def test_docker_free_mb_reads_megabytes(env):
    env.free(8192)
    r = env.run(NETPULSE, "docker_free_mb")
    assert r.stdout.strip() == "8192"


def test_plenty_of_space_does_not_clean(env):
    env.free(10_000)
    r = env.run(NETPULSE, 'check_disk && echo "rc=0"')
    assert "rc=0" in r.stdout
    assert "prune" not in env.docker_log
    assert "czyszczę" not in r.stdout


def test_low_space_cleans_and_continues_when_it_helps(env):
    env.free(3_000, after_prune=9_000)
    r = env.run(NETPULSE, 'check_disk && echo "rc=0"')
    assert "rc=0" in r.stdout
    assert "czyszczę" in r.stdout
    assert "builder prune -af" in env.docker_log
    assert "Uwaga" not in r.stdout  # po sprzątaniu jest dość miejsca


def test_not_enough_space_stops_with_instructions(env):
    env.free(1_500, after_prune=1_500)
    r = env.run(NETPULSE, 'check_disk || echo "rc=$?"')
    assert "rc=1" in r.stdout
    assert "Za mało miejsca na dysku: wolne 1500 MB" in r.stderr
    assert "docker system df" in r.stderr and "lvextend" in r.stderr
    assert "Nic nie zostało zmienione" in r.stderr


def test_between_thresholds_warns_but_continues(env):
    env.free(3_000, after_prune=3_000)
    r = env.run(NETPULSE, 'check_disk && echo "rc=0"')
    assert "rc=0" in r.stdout
    assert "Uwaga: wolne 3000 MB" in r.stdout


def test_thresholds_can_be_overridden(env):
    env.free(600, after_prune=600)
    blocked = env.run(NETPULSE, 'check_disk || echo "rc=$?"')
    assert "rc=1" in blocked.stdout
    allowed = env.run(NETPULSE, 'check_disk && echo "rc=0"', NETPULSE_MIN_FREE_MB="500")
    assert "rc=0" in allowed.stdout


def test_unreadable_disk_does_not_block(env):
    env.free(None)  # df kończy się błędem
    r = env.run(NETPULSE, 'check_disk && echo "rc=0"')
    assert "rc=0" in r.stdout


def test_cleanup_never_touches_volumes(env):
    env.free(5_000)
    env.run(NETPULSE, "clean_docker; prune_build_cache")
    log = env.docker_log
    assert "volume" not in log and "system prune" not in log and "--volumes" not in log
    assert "builder prune" in log and "image prune" in log


def test_post_update_prune_keeps_recent_cache(env):
    env.free(5_000)
    env.run(NETPULSE, "prune_build_cache")
    assert "builder prune -f --filter until=72h" in env.docker_log


def test_post_update_prune_window_is_configurable(env):
    env.free(5_000)
    env.run(NETPULSE, "prune_build_cache", NETPULSE_KEEP_BUILD_CACHE_HOURS="12")
    assert "builder prune -f --filter until=12h" in env.docker_log


def test_install_script_has_the_same_disk_checks(env):
    env.free(10_000)
    ok = env.run(INSTALL, 'np_ensure_disk && echo "rc=0"')
    assert "rc=0" in ok.stdout and "prune" not in env.docker_log

    env.free(3_000, after_prune=9_000)
    cleaned = env.run(INSTALL, 'np_ensure_disk && echo "rc=0"')
    assert "rc=0" in cleaned.stdout and "builder prune -af" in env.docker_log

    env.free(1_500, after_prune=1_500)
    stopped = env.run(INSTALL, 'np_ensure_disk || echo "rc=$?"')
    assert "rc=1" in stopped.stdout
    assert "Za mało miejsca na dysku: wolne 1500 MB" in stopped.stderr


def test_sourcing_scripts_does_not_run_main(env):
    env.free(10_000)
    for script in (NETPULSE, INSTALL):
        r = env.run(script, "echo loaded")  # ASCII: argument wiersza poleceń nie przechodzi przez stronę kodową
        assert "loaded" in r.stdout
        assert "Uruchom jako root" not in r.stderr + r.stdout
