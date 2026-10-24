#!/usr/bin/env bash
# NetPulse – instalacja jedną komendą na Ubuntu Server:
#
#   curl -fsSL https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/install.sh | sudo bash
#
# Co robi:
#   1. instaluje Dockera (oficjalne repozytorium Docker), jeśli go brak,
#   2. pobiera / aktualizuje NetPulse do $NETPULSE_DIR (domyślnie /opt/netpulse),
#   3. tworzy deploy/.env z losowymi hasłami (tylko przy pierwszej instalacji),
#   4. uruchamia `docker compose up -d --build` i czeka, aż aplikacja odpowie.
#
# Ponowne uruchomienie = aktualizacja (istniejący .env i dane w bazie zostają).
#
# Zmienne (opcjonalne):
#   NETPULSE_DIR     katalog instalacji        (domyślnie /opt/netpulse)
#   NETPULSE_REPO    adres repozytorium git
#   NETPULSE_BRANCH  gałąź                     (domyślnie main)

set -euo pipefail

NETPULSE_DIR="${NETPULSE_DIR:-/opt/netpulse}"
NETPULSE_REPO="${NETPULSE_REPO:-https://github.com/arkadiuszbaglaj/NetPulse.git}"
NETPULSE_BRANCH="${NETPULSE_BRANCH:-main}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m ✗\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
    [[ $EUID -eq 0 ]] || die "Uruchom jako root: curl -fsSL <adres>/install.sh | sudo bash"
}

check_os() {
    [[ -r /etc/os-release ]] || die "Nie rozpoznano systemu (brak /etc/os-release)."
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}" in
        ubuntu | debian) ok "System: ${PRETTY_NAME:-$ID}" ;;
        *) die "Obsługiwany system: Ubuntu Server (wykryto: ${PRETTY_NAME:-nieznany})." ;;
    esac
}

install_packages() {
    local missing=()
    for cmd in curl git openssl; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done
    if ((${#missing[@]})); then
        info "Instaluję pakiety: ${missing[*]}"
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates "${missing[@]}" >/dev/null
    fi
}

install_docker() {
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
        ok "Docker już zainstalowany: $(docker --version)"
    else
        info "Instaluję Dockera z oficjalnego repozytorium..."
        # shellcheck source=/dev/null
        . /etc/os-release
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl >/dev/null
        install -m 0755 -d /etc/apt/keyrings
        curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
        chmod a+r /etc/apt/keyrings/docker.asc
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc]" \
            "https://download.docker.com/linux/${ID} ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
            >/etc/apt/sources.list.d/docker.list
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli \
            containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
        ok "Docker zainstalowany: $(docker --version)"
    fi
    systemctl enable --now docker >/dev/null 2>&1 || true
    docker info >/dev/null 2>&1 || die "Docker nie działa (sprawdź: systemctl status docker)."
}

fetch_code() {
    if [[ -d "$NETPULSE_DIR/.git" ]]; then
        info "Aktualizuję NetPulse w $NETPULSE_DIR (gałąź $NETPULSE_BRANCH)..."
        git -C "$NETPULSE_DIR" fetch --quiet origin "$NETPULSE_BRANCH"
        git -C "$NETPULSE_DIR" checkout --quiet "$NETPULSE_BRANCH"
        git -C "$NETPULSE_DIR" merge --quiet --ff-only "origin/$NETPULSE_BRANCH" \
            || die "Lokalne zmiany w $NETPULSE_DIR blokują aktualizację (git status)."
    elif [[ -e "$NETPULSE_DIR" && -n "$(ls -A "$NETPULSE_DIR" 2>/dev/null)" ]]; then
        die "Katalog $NETPULSE_DIR istnieje i nie jest repozytorium NetPulse."
    else
        info "Pobieram NetPulse do $NETPULSE_DIR..."
        git clone --quiet --branch "$NETPULSE_BRANCH" "$NETPULSE_REPO" "$NETPULSE_DIR"
    fi
    ok "Kod: $(git -C "$NETPULSE_DIR" log -1 --format='%h %s')"
}

create_env() {
    local env_file="$NETPULSE_DIR/deploy/.env"
    if [[ -f "$env_file" ]]; then
        ok "Konfiguracja $env_file już istnieje – zostawiam bez zmian."
        return
    fi
    info "Tworzę $env_file z losowymi hasłami..."
    # Every KEY=CHANGE_ME line gets its own random value.
    local line
    while IFS= read -r line; do
        if [[ "$line" =~ ^([A-Z0-9_]+)=CHANGE_ME$ ]]; then
            line="${BASH_REMATCH[1]}=$(openssl rand -hex 24)"
        fi
        printf '%s\n' "$line"
    done <"$NETPULSE_DIR/deploy/.env.example" >"$env_file"
    chmod 600 "$env_file"
    ok "Hasła zapisane w $env_file (tylko root może go czytać)."
}

env_value() {
    sed -n "s/^$1=//p" "$NETPULSE_DIR/deploy/.env" | tail -n1
}

start_stack() {
    info "Buduję i uruchamiam kontenery (pierwszy raz może potrwać kilka minut)..."
    docker compose -f "$NETPULSE_DIR/deploy/docker-compose.yml" up -d --build --remove-orphans

    local port
    port="$(env_value NETPULSE_PORT)"
    port="${port:-8080}"
    info "Czekam, aż NetPulse odpowie na porcie $port..."
    for _ in $(seq 1 60); do
        if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
            local ip
            ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
            echo
            ok "NetPulse działa!"
            echo "    Stan:     http://${ip:-<adres-serwera>}:${port}/api/health"
            echo "    API docs: http://${ip:-<adres-serwera>}:${port}/docs"
            echo "    Katalog:  $NETPULSE_DIR"
            echo "    Logi:     docker compose -f $NETPULSE_DIR/deploy/docker-compose.yml logs -f"
            return
        fi
        sleep 3
    done
    docker compose -f "$NETPULSE_DIR/deploy/docker-compose.yml" ps
    die "NetPulse nie odpowiada po 3 minutach. Sprawdź logi:
    docker compose -f $NETPULSE_DIR/deploy/docker-compose.yml logs"
}

main() {
    echo "NetPulse – instalacja"
    require_root
    check_os
    install_packages
    install_docker
    fetch_code
    create_env
    start_stack
}

# Everything runs from main(), so a download cut off mid-way through `curl | bash`
# never executes a half-read script.
main "$@"
