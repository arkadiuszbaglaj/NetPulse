#!/usr/bin/env bash
# Zamienia końcówkę pliku z logiem na jedną adnotację błędu GitHub Actions.
# Użycie: annotate.sh PLIK TYTUŁ [LICZBA_LINII]
set -u
file="$1"; title="$2"; lines="${3:-120}"
[ -f "$file" ] || exit 0
msg=$(tail -n "$lines" "$file" | sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk 'BEGIN{ORS="%0A"} {print}')
echo "::error title=${title}::${msg}"
