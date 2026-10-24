#!/usr/bin/env bash
# Instalator NetPulse dla Ubuntu Server.
#
#   curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
#
# Zmienne (opcjonalnie): NETPULSE_DIR (domyślnie /opt/netpulse), NETPULSE_BRANCH (main),
# NETPULSE_REPO (adres repozytorium), NETPULSE_PORT (8000).
#
# Ponowne uruchomienie jest bezpieczne – działa jak aktualizacja, nie rusza danych ani haseł.

set -euo pipefail

main() {
  local REPO="${NETPULSE_REPO:-https://github.com/arkadiuszbaglaj/NetPulse.git}"
  local BRANCH="${NETPULSE_BRANCH:-main}"
  local DIR="${NETPULSE_DIR:-/opt/netpulse}"
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
  echo "  NetPulse – instalacja"
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

  # 3. Kod aplikacji
  if [ -d "$DIR/.git" ]; then
    info "Aktualizuję istniejącą instalację w $DIR..."
    git -C "$DIR" fetch --quiet origin "$BRANCH"
    git -C "$DIR" checkout --quiet "$BRANCH"
    git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH"
  else
    info "Pobieram NetPulse do $DIR..."
    git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
  fi

  # 4. Konfiguracja (.env z losowym hasłem – tylko przy pierwszej instalacji)
  local ENV_FILE="$DIR/deploy/.env"
  if [ ! -f "$ENV_FILE" ]; then
    info "Tworzę konfigurację z losowym hasłem do bazy..."
    sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" \
        -e "s/^NETPULSE_PORT=.*/NETPULSE_PORT=${PORT}/" \
        "$DIR/deploy/.env.example" >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi

  # 5. Polecenie `netpulse`
  chmod +x "$DIR/scripts/netpulse"
  ln -sf "$DIR/scripts/netpulse" /usr/local/bin/netpulse

  # 6. Start
  info "Buduję i uruchamiam usługi (pierwszy raz może potrwać kilka minut)..."
  docker compose -f "$DIR/deploy/docker-compose.yml" --env-file "$ENV_FILE" up -d --build --remove-orphans

  PORT=$(sed -n 's/^NETPULSE_PORT=//p' "$ENV_FILE")
  info "Czekam na start..."
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      local ip
      ip=$(hostname -I 2>/dev/null | awk '{print $1}')
      echo
      ok "NetPulse działa!  Panel: http://${ip:-localhost}:${PORT}"
      echo
      echo "  1. Otwórz panel i załóż konto administratora (kreator, tylko raz):"
      echo "     http://${ip:-localhost}:${PORT}"
      echo
      echo "  2. Dodaj urządzenia, np.:"
      echo "    netpulse device add \"UCG Ultra\" 192.168.1.1 --community public"
      echo "    netpulse device list"
      echo
      echo "  Aktualizacja do najnowszej wersji:  netpulse update"
      echo "  Pomoc:                              netpulse help"
      echo
      return 0
    fi
    sleep 2
  done
  die "Usługi nie wystartowały. Sprawdź logi: netpulse logs"
}

# Całość w funkcji – przy `curl | bash` nic się nie wykona, dopóki skrypt nie pobierze się w całości.
main "$@"
