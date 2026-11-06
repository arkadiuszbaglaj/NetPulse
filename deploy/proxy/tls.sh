#!/bin/sh
# Certyfikat HTTPS panelu NetPulse (od 0.62.0) i start nginx.
#
# Katalog /tls (na serwerze: <katalog instalacji>/deploy/tls):
#   ca.pem, ca-key.pem          lokalne CA NetPulse (10 lat) – ca.pem można zaimportować do przeglądarki/systemu
#   server.pem, server-key.pem  certyfikat panelu podpisany przez to CA (397 dni, odnawiany 30 dni przed końcem)
#   names.active                adresy w bieżącym certyfikacie
#   request/names               adresy dopisane w panelu (Ustawienia → System → HTTPS) – zapisuje je API
#   custom/cert.pem + key.pem   własny certyfikat (np. z Let's Encrypt) – gdy są, mają pierwszeństwo
#
# Adresy w certyfikacie: localhost, 127.0.0.1, NETPULSE_TLS_NAMES z .env (instalator wpisuje nazwę i adresy IP
# serwera) i request/names. Co NETPULSE_TLS_CHECK_S sekund skrypt sprawdza, czy certyfikat trzeba wystawić
# od nowa (nowe adresy, koniec ważności, nowy własny certyfikat) i przeładowuje nginx.
set -eu

TLS=${NETPULSE_TLS_DIR:-/tls}
CHECK_EVERY=${NETPULSE_TLS_CHECK_S:-30}
RENEW_S=$((30 * 86400))
API_UID=10001

log() { echo "netpulse-tls: $*" >&2; }

valid_name() {
  # IPv4, IPv6 albo nazwa DNS (litery, cyfry, kropki, myślniki)
  echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[0-9a-f:]*:[0-9a-f:.]*$|^[a-z0-9]([a-z0-9-]{0,62}\.)*[a-z0-9-]{1,63}$'
}

is_ip() { echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$|:'; }

wanted_names() {
  {
    echo localhost
    echo 127.0.0.1
    echo "${NETPULSE_TLS_NAMES:-}" | tr ', ;' '\n\n\n'
    if [ -f "$TLS/request/names" ]; then cat "$TLS/request/names"; fi
  } | tr -d '\r\t ' | tr 'A-Z' 'a-z' | while read -r name; do
    if [ -n "$name" ] && valid_name "$name"; then echo "$name"; fi
  done | sort -u | head -n 50
}

ensure_ca() {
  [ -s "$TLS/ca.pem" ] && [ -s "$TLS/ca-key.pem" ] && return 0
  log "tworzę lokalne CA NetPulse"
  suffix=$(openssl rand -hex 4)
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days 3650 \
    -keyout "$TLS/ca-key.pem.tmp" -out "$TLS/ca.pem.tmp" \
    -subj "/O=NetPulse/CN=NetPulse local CA $suffix" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null     || { log "nie udało się utworzyć CA"; rm -f "$TLS/ca-key.pem.tmp" "$TLS/ca.pem.tmp"; return 1; }
  chmod 600 "$TLS/ca-key.pem.tmp"
  chmod 644 "$TLS/ca.pem.tmp"
  mv "$TLS/ca-key.pem.tmp" "$TLS/ca-key.pem"
  mv "$TLS/ca.pem.tmp" "$TLS/ca.pem"
  rm -f "$TLS/names.active" # nowe CA = nowy certyfikat panelu
}

issue() {
  names=$1
  tmp=$(mktemp -d)
  san=""
  cn=""
  for n in $names; do
    if is_ip "$n"; then entry="IP:$n"; else entry="DNS:$n"; fi
    san="${san:+$san,}$entry"
    if [ -z "$cn" ] && [ "$n" != localhost ] && [ "$n" != 127.0.0.1 ]; then cn=$n; fi
  done
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' "$san" >"$tmp/ext"
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
    -keyout "$tmp/key.pem" -out "$tmp/req.csr" -subj "/O=NetPulse/CN=${cn:-netpulse}" 2>/dev/null     || { log "nie udało się utworzyć klucza"; rm -rf "$tmp"; return 1; }
  openssl x509 -req -in "$tmp/req.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca-key.pem" \
    -set_serial "0x$(openssl rand -hex 16)" -days 397 -sha256 -extfile "$tmp/ext" -out "$tmp/cert.pem" 2>/dev/null     || { log "nie udało się podpisać certyfikatu"; rm -rf "$tmp"; return 1; }
  install_pair "$tmp/cert.pem" "$tmp/key.pem"
  echo "$names" | tr ' ' '\n' >"$TLS/names.active"
  chmod 644 "$TLS/names.active"
  rm -rf "$tmp"
  log "wystawiono certyfikat dla: $(echo "$names" | tr '\n' ' ')"
}

install_pair() {
  cp "$1" "$TLS/server.pem.tmp"
  cp "$2" "$TLS/server-key.pem.tmp"
  chmod 644 "$TLS/server.pem.tmp"
  chmod 600 "$TLS/server-key.pem.tmp"
  mv "$TLS/server-key.pem.tmp" "$TLS/server-key.pem"
  mv "$TLS/server.pem.tmp" "$TLS/server.pem"
}

pair_matches() {
  a=$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null) || return 1
  b=$(openssl pkey -in "$2" -pubout 2>/dev/null | openssl sha256 2>/dev/null) || return 1
  [ -n "$a" ] && [ "$a" = "$b" ]
}

# 0 = certyfikat zmieniony (trzeba przeładować nginx), 1 = bez zmian
sync_cert() {
  if [ -s "$TLS/custom/cert.pem" ] && [ -s "$TLS/custom/key.pem" ]; then
    if pair_matches "$TLS/custom/cert.pem" "$TLS/custom/key.pem"; then
      if [ -s "$TLS/server.pem" ] && cmp -s "$TLS/custom/cert.pem" "$TLS/server.pem" && cmp -s "$TLS/custom/key.pem" "$TLS/server-key.pem"; then
        return 1
      fi
      log "używam własnego certyfikatu z custom/"
      install_pair "$TLS/custom/cert.pem" "$TLS/custom/key.pem"
      echo custom >"$TLS/names.active"
      return 0
    fi
    log "custom/cert.pem nie pasuje do custom/key.pem – używam certyfikatu lokalnego CA"
  fi
  ensure_ca || return 1
  names=$(wanted_names)
  if [ ! -s "$TLS/server.pem" ] || [ ! -s "$TLS/server-key.pem" ] \
    || [ "$names" != "$(cat "$TLS/names.active" 2>/dev/null)" ] \
    || ! openssl x509 -in "$TLS/server.pem" -noout -checkend "$RENEW_S" >/dev/null 2>&1 \
    || ! openssl verify -CAfile "$TLS/ca.pem" "$TLS/server.pem" >/dev/null 2>&1; then
    issue "$names" || return 1
    return 0
  fi
  return 1
}

prepare() {
  mkdir -p "$TLS/request" "$TLS/custom"
  chmod 755 "$TLS" "$TLS/custom"
  # API (użytkownik netpulse w swoim kontenerze) dopisuje adresy z panelu
  chown "$API_UID" "$TLS/request"
  chmod 755 "$TLS/request"
  sync_cert || true
}

case "${1:-run}" in
  run)
    prepare
    nginx -g 'daemon off;' &
    pid=$!
    trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit 0' TERM INT
    while kill -0 "$pid" 2>/dev/null; do
      sleep "$CHECK_EVERY" &
      wait $! || true
      if sync_cert; then nginx -s reload || log "przeładowanie nginx nie powiodło się"; fi
    done
    wait "$pid"
    ;;
  names) wanted_names ;;
  sync) prepare ;;
  *) exec "$@" ;;
esac
