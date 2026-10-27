from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    """Ustawienia usługi. Katalog instalacji ma tę samą ścieżkę na serwerze i w kontenerze
    (docker compose przekazuje demonowi ścieżki hosta, więc muszą się zgadzać)."""

    install_dir: Path
    token: str = ""
    # Plik z tokenem we wspólnym woluminie (updater go tworzy, API czyta). Pusty = tylko `token`
    token_file: str = ""
    # Uid użytkownika API w kontenerze – tylko on (i updater) może czytać token
    token_uid: int = 10001
    enabled: bool = True
    port: int = 8080
    repo_url: str = ""  # puste = adres `origin` z instalacji; ustawienie pozwala wskazać inne źródło
    branch: str = ""  # puste = bieżąca gałąź instalacji
    min_free_mb: int = 2000
    keep_cache_hours: int = 72
    # Górny limit cache budowania (format Dockera, np. 2gb): wiele aktualizacji w krótkim czasie nie zapcha dysku
    build_cache_max: str = "2gb"
    backups_keep: int = 3
    health_timeout_s: int = 150
    job_name: str = "netpulse-update-job"

    @property
    def state_dir(self) -> Path:
        return self.install_dir / ".update"

    @property
    def backups_dir(self) -> Path:
        return self.install_dir / "backups"

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ
        return cls(
            install_dir=Path(env.get("NETPULSE_DIR", "/opt/netpulse")),
            token=env.get("NETPULSE_UPDATER_TOKEN", ""),
            token_file=env.get("NETPULSE_UPDATER_TOKEN_FILE", ""),
            token_uid=int(env.get("NETPULSE_UPDATER_TOKEN_UID", "10001")),
            enabled=env.get("NETPULSE_UPDATER", "on").lower() not in ("off", "0", "false", "no"),
            port=int(env.get("NETPULSE_UPDATER_PORT", "8080")),
            repo_url=env.get("NETPULSE_UPDATE_REPO", ""),
            branch=env.get("NETPULSE_UPDATE_BRANCH", ""),
            min_free_mb=int(env.get("NETPULSE_MIN_FREE_MB", "2000")),
            keep_cache_hours=int(env.get("NETPULSE_KEEP_BUILD_CACHE_HOURS", "72")),
            build_cache_max=env.get("NETPULSE_BUILD_CACHE_MAX", "2gb").strip() or "2gb",
        )
