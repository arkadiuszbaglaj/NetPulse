#!/usr/bin/env bash
# Instalacja (i aktualizacja) agenta NetPulse na serwerze Linux. Polecenie z tokenem pokazuje panel:
#   curl -fsSL http://NETPULSE:8000/agent/install.sh | sudo bash -s -- --url http://NETPULSE:8000 --token npa_...
# Ponowne uruchomienie z tym samym adresem aktualizuje agenta (konfiguracja zostaje).
# Odinstalowanie:
#   curl -fsSL http://NETPULSE:8000/agent/install.sh | sudo bash -s -- --uninstall
set -euo pipefail

URL=""
TOKEN=""
UNINSTALL=0
DIR=/opt/netpulse-agent
CONF=/etc/netpulse-agent.conf
UNIT=/etc/systemd/system/netpulse-agent.service

err() { echo "Błąd: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) err "nieznana opcja: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || err "uruchom jako root (sudo)"
command -v systemctl >/dev/null || err "agent wymaga systemd"

if [ "$UNINSTALL" = 1 ]; then
  systemctl disable --now netpulse-agent 2>/dev/null || true
  rm -f "$UNIT" "$CONF"
  rm -rf "$DIR"
  systemctl daemon-reload
  echo "Agent NetPulse usunięty. Serwer usuń też w panelu (Ustawienia → Agenci), jeśli nie jest już potrzebny."
  exit 0
fi

# Przy aktualizacji adres i token mogą zostać z istniejącej konfiguracji
if [ -f "$CONF" ]; then
  [ -n "$URL" ] || URL=$(sed -n 's/^NETPULSE_URL=//p' "$CONF")
  [ -n "$TOKEN" ] || TOKEN=$(sed -n 's/^NETPULSE_TOKEN=//p' "$CONF")
fi
[ -n "$URL" ] || err "podaj adres NetPulse: --url http://ADRES:8000"
[ -n "$TOKEN" ] || err "podaj token agenta: --token npa_... (Ustawienia → Agenci w panelu)"
URL="${URL%/}"

if ! command -v python3 >/dev/null; then
  if command -v apt-get >/dev/null; then
    echo "Instaluję python3..."
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 >/dev/null
  else
    err "brak python3 – zainstaluj go i uruchom instalację ponownie"
  fi
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || err "agent wymaga Pythona 3.8 lub nowszego"

echo "Pobieram agenta z $URL ..."
mkdir -p "$DIR"
curl -fsSL "$URL/agent/netpulse-agent.py" -o "$DIR/netpulse-agent.py.new" || err "nie udało się pobrać agenta z $URL"
mv "$DIR/netpulse-agent.py.new" "$DIR/netpulse-agent.py"
chmod 755 "$DIR/netpulse-agent.py"

# Konfiguracja: adres i token zawsze aktualne, pozostałe ustawienia (SERVICES, DOCKER, SMART) bez zmian
touch "$CONF"
chmod 600 "$CONF"
set_conf() {
  if grep -q "^$1=" "$CONF"; then
    sed -i "s|^$1=.*|$1=$2|" "$CONF"
  else
    echo "$1=$2" >>"$CONF"
  fi
}
set_conf NETPULSE_URL "$URL"
set_conf NETPULSE_TOKEN "$TOKEN"
grep -q '^SERVICES=' "$CONF" || echo "SERVICES=" >>"$CONF"
grep -q '^DOCKER=' "$CONF" || echo "DOCKER=auto" >>"$CONF"
grep -q '^SMART=' "$CONF" || echo "SMART=auto" >>"$CONF"

echo "Sprawdzam połączenie z NetPulse..."
python3 "$DIR/netpulse-agent.py" --config "$CONF" --once || err "NetPulse nie przyjął raportu (sprawdź adres i token)"

# Root jest potrzebny do SMART i gniazda Dockera; reszta systemu tylko do odczytu
cat >"$UNIT" <<EOF
[Unit]
Description=NetPulse Agent (metryki serwera dla NetPulse)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env python3 $DIR/netpulse-agent.py --config $CONF
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
Nice=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable netpulse-agent >/dev/null 2>&1
systemctl restart netpulse-agent
echo "Gotowe: agent NetPulse działa (systemctl status netpulse-agent). Serwer pojawi się w panelu w ciągu minuty."
