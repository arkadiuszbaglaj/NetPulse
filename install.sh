#!/usr/bin/env bash
# Instalator UplinkView dla Ubuntu Server.
#
#   curl -fsSL https://raw.githubusercontent.com/uplinkview/uplinkview/main/install.sh | sudo bash
#
# Zmienne (opcjonalnie): NETPULSE_DIR (domyślnie /opt/uplinkview; instalacja sprzed zmiany nazwy w /opt/netpulse
# jest wykrywana i aktualizowana na miejscu), NETPULSE_BRANCH (main),
# NETPULSE_REPO (adres repozytorium), NETPULSE_PORT (8000), NETPULSE_HTTPS_PORT (8443).
#
# Ponowne uruchomienie jest bezpieczne – działa jak aktualizacja, nie rusza danych ani haseł.

set -euo pipefail

# --- miejsce na dysku ---------------------------------------------------------------
# Budowanie obrazów (Node + Python) potrzebuje kilku GB. Sprawdzamy to przed pobraniem projektu,
# żeby brak miejsca nie kończył się długim błędem Dockera w połowie instalacji.
np_min_free_mb() { echo "${NETPULSE_MIN_FREE_MB:-2000}"; }
np_warn_free_mb() { echo "${NETPULSE_WARN_FREE_MB:-4000}"; }

np_free_mb() {
  local dir
  dir=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -d "$dir" ] || dir=/var/lib/docker
  [ -d "$dir" ] || dir=/
  df -Pk "$dir" 2>/dev/null | awk 'NR==2 {print int($4/1024)}'
}

# Zwraca 1, gdy miejsca jest za mało (po próbie sprzątania nieużywanych danych Dockera)
np_ensure_disk() {
  local free min warn
  min=$(np_min_free_mb)
  warn=$(np_warn_free_mb)
  free=$(np_free_mb)
  case "$free" in '' | *[!0-9]*) return 0 ;; esac # nie umiemy sprawdzić – nie blokujemy
  if [ "$free" -lt "$warn" ]; then
    printf '\033[1;34m==>\033[0m Mało wolnego miejsca (%s MB) – czyszczę nieużywane dane Dockera...\n' "$free"
    docker builder prune -af >/dev/null 2>&1 || true
    docker image prune -f >/dev/null 2>&1 || true
    free=$(np_free_mb)
  fi
  if [ "$free" -lt "$min" ]; then
    printf '\033[1;31m✗ Za mało miejsca na dysku: wolne %s MB, a instalacja wymaga co najmniej %s MB.\033[0m\n' "$free" "$min" >&2
    echo "  Sprawdź: df -h /   oraz   sudo docker system df" >&2
    echo "  Jeśli dysk jest duży, a system używa tylko jego części (LVM): sudo vgs, potem" >&2
    echo "  sudo lvextend -r -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv" >&2
    return 1
  fi
  if [ "$free" -lt "$warn" ]; then
    printf '\033[1;34m==>\033[0m Uwaga: wolne %s MB – wystarczy na instalację, ale warto zwolnić miejsce.\n' "$free"
  fi
}

# Nazwa i adresy IPv4 serwera do certyfikatu HTTPS (bez sieci Dockera), przecinkami
np_tls_names() {
  local ips
  ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr)/ {sub(/\/.*/, "", $4); print $4}')
  [ -n "$ips" ] || ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9.]+$' | grep -v '^172\.1[7-9]\.' || true)
  { hostname -s 2>/dev/null; hostname -f 2>/dev/null; echo "$ips"; } | tr 'A-Z' 'a-z' | grep -E '^[a-z0-9][a-z0-9.:-]*$' \
    | grep -v '^localhost' | sort -u | paste -sd, -
}

# Uzupełnia NETPULSE_TLS_NAMES w .env, gdy brak albo puste (instalacja sprzed 0.62.0, aktualizacja z panelu)
np_fill_tls_names() {
  local env_file=$1 names
  if grep -q '^NETPULSE_TLS_NAMES=..*' "$env_file" 2>/dev/null; then return 0; fi
  names=$(np_tls_names || true)
  [ -n "$names" ] || return 0
  if grep -q '^NETPULSE_TLS_NAMES=' "$env_file"; then
    sed -i "s|^NETPULSE_TLS_NAMES=.*|NETPULSE_TLS_NAMES=${names}|" "$env_file"
  else
    echo "NETPULSE_TLS_NAMES=${names}" >>"$env_file"
  fi
}

# Repozytorium przeniesione przy zmianie nazwy na UplinkView (0.78.0). GitHub przekierowuje stary adres, ale tylko
# dopóki nikt nie zajmie starej nazwy – instalacja przestawia `origin` na nowy adres sama.
NP_REPO="https://github.com/uplinkview/uplinkview.git"
np_migrate_origin() {
  local dir=$1 url
  url=$(git -C "$dir" remote get-url origin 2>/dev/null) || return 0
  if printf '%s' "$url" | grep -qiE 'github\.com[/:]arkadiuszbaglaj/netpulse(\.git)?/?$'; then
    git -C "$dir" remote set-url origin "$NP_REPO"
  fi
}

# Katalog instalacji: NETPULSE_DIR, a bez niego /opt/uplinkview – chyba że na serwerze jest już instalacja sprzed
# zmiany nazwy w /opt/netpulse (ponowne uruchomienie instalatora aktualizuje ją na miejscu, z danymi)
np_default_dir() {
  if [ -n "${NETPULSE_DIR:-}" ]; then echo "$NETPULSE_DIR"
  elif [ ! -d /opt/uplinkview/.git ] && [ -d /opt/netpulse/.git ]; then echo /opt/netpulse
  else echo /opt/uplinkview
  fi
}

main() {
  local REPO="${NETPULSE_REPO:-$NP_REPO}"
  local BRANCH="${NETPULSE_BRANCH:-main}"
  local DIR
  DIR=$(np_default_dir)
  local PORT="${NETPULSE_PORT:-8000}"

  info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
  ok() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
  die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

  [ "$(id -u)" -eq 0 ] || die "Uruchom jako root: curl -fsSL ... | sudo bash"

  if [ -r /etc/os-release ]; then
    . /etc/os-release
    case "${ID:-}" in
      ubuntu | debian) ;;
      *) info "Uwaga: testowane na Ubuntu Server, wykryto: ${PRETTY_NAME:-nieznany}" ;;
    esac
  fi

  echo
  echo "  UplinkView – instalacja"
  echo "  katalog: $DIR   gałąź: $BRANCH"
  echo

  # 1. Pakiety systemowe
  if command -v apt-get >/dev/null; then
    info "Instaluję wymagane pakiety (git, curl, openssl)..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq git curl ca-certificates openssl >/dev/null
  fi

  # 2. Docker + Compose
  if ! command -v docker >/dev/null; then
    info "Instaluję Dockera (oficjalny skrypt get.docker.com)..."
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  docker compose version >/dev/null 2>&1 || die "Brak 'docker compose' – zainstaluj pakiet docker-compose-plugin"
  ok "Docker: $(docker --version | cut -d, -f1)"
  np_ensure_disk || exit 1

  # 3. Kod aplikacji
  if [ -d "$DIR/.git" ]; then
    info "Aktualizuję istniejącą instalację w $DIR..."
    [ -n "${NETPULSE_REPO:-}" ] || np_migrate_origin "$DIR"
    git -C "$DIR" fetch --quiet origin "$BRANCH"
    git -C "$DIR" checkout --quiet "$BRANCH"
    git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH"
  else
    info "Pobieram UplinkView do $DIR..."
    git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  fi

  # 4. Konfiguracja (.env z losowym hasłem – tylko przy pierwszej instalacji)
  local ENV_FILE="$DIR/deploy/.env"
  if [ ! -f "$ENV_FILE" ]; then
    info "Tworzę konfigurację z losowym hasłem do bazy..."
    sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" \
\
        -e "s|^NETPULSE_DIR=.*|NETPULSE_DIR=${DIR}|" \
        -e "s/^NETPULSE_PORT=.*/NETPULSE_PORT=${PORT}/" \
        "$DIR/deploy/.env.example" >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi

  # Adresy serwera w certyfikacie HTTPS (od 0.62.0) – także przy ponownym uruchomieniu na starej instalacji
  np_fill_tls_names "$ENV_FILE"
  grep -q '^NETPULSE_HTTPS_PORT=' "$ENV_FILE" || echo "NETPULSE_HTTPS_PORT=${NETPULSE_HTTPS_PORT:-8443}" >>"$ENV_FILE"

  # 5. Polecenie `uplinkview` (i dawne `netpulse` – to samo polecenie, dla instalacji sprzed zmiany nazwy)
  chmod +x "$DIR/scripts/netpulse"
  ln -sf "$DIR/scripts/netpulse" /usr/local/bin/uplinkview
  ln -sf "$DIR/scripts/netpulse" /usr/local/bin/netpulse

  # 6. Start
  info "Buduję i uruchamiam usługi (pierwszy raz może potrwać kilka minut)..."
  docker compose -f "$DIR/deploy/docker-compose.yml" --env-file "$ENV_FILE" up -d --build --remove-orphans

  PORT=$(sed -n 's/^NETPULSE_PORT=//p' "$ENV_FILE")
  local HTTPS_PORT
  HTTPS_PORT=$(sed -n 's/^NETPULSE_HTTPS_PORT=//p' "$ENV_FILE")
  info "Czekam na start..."
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      local ip
      ip=$(hostname -I 2>/dev/null | awk '{print $1}')
      echo
      ok "UplinkView działa!  Panel: http://${ip:-localhost}:${PORT}"
      echo "  HTTPS: https://${ip:-localhost}:${HTTPS_PORT:-8443}  (certyfikat lokalnego CA UplinkView –"
      echo "         CA do zaimportowania: panel → Ustawienia → System → HTTPS)"
      echo
      echo "  1. Otwórz panel i załóż konto administratora (kreator, tylko raz):"
      echo "     http://${ip:-localhost}:${PORT}"
      echo
      echo "  2. Dodaj urządzenia, np.:"
      echo "    uplinkview device add \"UCG Ultra\" 192.168.1.1 --community public"
      echo "    uplinkview device list"
      echo
      echo "  Aktualizacja do najnowszej wersji:  uplinkview update"
      echo "  Pomoc:                              uplinkview help"
      echo
      return 0
    fi
    sleep 2
  done
  die "Usługi nie wystartowały. Sprawdź logi: uplinkview logs"
}

# Całość w funkcji – przy `curl | bash` nic się nie wykona, dopóki skrypt nie pobierze się w całości.
# (Warunek pozwala załadować plik w testach; przy `curl | bash` BASH_SOURCE jest puste, więc main startuje.)
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  main "$@"
fi
