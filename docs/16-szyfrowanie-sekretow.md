# Szyfrowanie sekretów w bazie (od 0.15.0)

NetPulse przechowuje w bazie dane, które dają dostęp do innych urządzeń i usług:

| Tabela | Kolumny |
|--------|---------|
| `devices` | `community` (SNMP v1/v2c), `v3_auth_key`, `v3_priv_key` (SNMPv3) |
| `controllers` | `api_key` (klucz API UniFi Network) |
| `notification_channels` | `url` (adres webhooka zawiera sekret) |

Od wersji 0.15.0 te wartości są w bazie zaszyfrowane. Kopia bazy, zrzut `pg_dump` albo podgląd tabel nie
pokazują ich jawnym tekstem. API ich nie zwraca (tak było już wcześniej).

## Klucz

- Powstaje sam przy pierwszym starcie wersji 0.15: losowy, 32 bajty, plik `/var/lib/netpulse/secret.key`
  w wolumenie Dockera `netpulse_keys` (widzą go tylko kontenery `api` i `collector`, prawa 600).
- Można go podać samemu w `deploy/.env` jako `NETPULSE_SECRET_KEY=...`. Zmienna ma pierwszeństwo przed plikiem
  (przydaje się przy przenoszeniu na nowy serwer).
- **Klucza nie zmieniaj.** Sekretów zapisanych starym kluczem nie da się odczytać nowym. NetPulse traktuje je
  wtedy jak puste (w logu jest błąd), a urządzenia, kontrolery i webhooki trzeba uzupełnić w panelu.

## Aktualizacja ze starszej wersji

Przy pierwszym starcie 0.15 kolektor (`netpulse db init`):

1. migracja `0004` zmienia typ tych kolumn na `TEXT` (zaszyfrowana wartość jest dłuższa),
2. powstaje klucz,
3. wszystkie sekrety zapisane jawnym tekstem zostają zaszyfrowane (log: „Zaszyfrowano N sekretów…”).

Nic nie trzeba robić ręcznie. Wartości bez prefiksu `enc:v1:` są dalej czytane, więc przejście jest bezpieczne
także w trakcie.

## Jak to działa

`backend/netpulse/crypto.py`: Fernet z biblioteki `cryptography` (AES-128-CBC + HMAC-SHA256, losowy wektor),
klucz Fernet wyprowadzony SHA-256 z klucza instalacji. W bazie: `enc:v1:` + token. Kolumny mają typ
`EncryptedText` (SQLAlchemy `TypeDecorator`), więc reszta kodu widzi zwykły tekst: szyfrowanie przy zapisie,
odszyfrowanie przy odczycie.

Szyfrowanie chroni sekrety w kopiach bazy i przy wycieku samej bazy. Nie chroni przed kimś, kto ma dostęp do
serwera z uprawnieniami roota (widzi i bazę, i klucz).
