# API i logowanie

API NetPulse działa pod `http://IP-serwera:PORT/api` (port z `NETPULSE_PORT` w `.env`,
domyślnie 8000). Interaktywna dokumentacja z możliwością wywoływania: `http://IP-serwera:PORT/docs`.

## Pierwsze konto (kreator)

Po instalacji nie ma żadnego konta. Pierwsze konto administratora zakłada kreator:
panel (krok 5) sam o nie poprosi. Do tego czasu można to zrobić w `/docs`:

1. `POST /api/auth/setup` → **Try it out** → wpisz `username` i `password` (min. 8 znaków) → **Execute**.
2. Gotowe – przeglądarka dostała ciasteczko sesji, pozostałe endpointy w `/docs` działają.

Kreator działa tylko raz – gdy konto już istnieje, odpowiada `409`.

> Do chwili założenia konta zrobić to może każdy w sieci lokalnej – załóż je od razu po instalacji.

## Logowanie

| Endpoint                   | Co robi                                                    |
|----------------------------|------------------------------------------------------------|
| `GET /api/auth/status`     | czy trzeba założyć konto, czy jesteś zalogowany (publiczne) |
| `POST /api/auth/setup`     | kreator pierwszego konta (tylko raz)                        |
| `POST /api/auth/login`     | logowanie (`username`, `password`)                          |
| `POST /api/auth/logout`    | wylogowanie                                                 |
| `GET /api/auth/me`         | zalogowany użytkownik                                       |
| `POST /api/auth/password`  | zmiana hasła (wylogowuje pozostałe sesje)                   |

Bezpieczeństwo:
- hasła w bazie jako skrót Argon2, sesja w ciasteczku `HttpOnly`, `SameSite=Lax`,
  ważna 30 dni od ostatniej aktywności (`NETPULSE_SESSION_DAYS`),
- zmiany (POST/PATCH/DELETE) przyjmowane tylko z tej samej strony (ochrona CSRF) –
  za reverse proxy z inną nazwą dopisz ją w `.env`: `NETPULSE_TRUSTED_ORIGINS=https://netpulse.lan`,
- po 10 nieudanych logowaniach z jednego adresu – 15 minut blokady.

### Zapomniane hasło

Na serwerze:

```bash
netpulse user passwd admin
```

Pyta dwa razy o nowe hasło i wylogowuje wszystkie sesje tego konta. Lista kont: `netpulse user list`.

## Urządzenia

Wszystko poniżej wymaga zalogowania.

| Endpoint                                   | Co robi                                         |
|--------------------------------------------|-------------------------------------------------|
| `GET /api/devices`                         | lista urządzeń ze statusem                      |
| `POST /api/probe`                          | test SNMP bez zapisu (formularz „Dodaj”)         |
| `POST /api/devices`                        | dodanie (najpierw test SNMP; pominięcie: `?probe=false`) |
| `GET /api/devices/{id}`                    | szczegóły                                       |
| `PATCH /api/devices/{id}`                  | zmiana wybranych pól                            |
| `DELETE /api/devices/{id}`                 | usunięcie razem z historią                      |
| `POST /api/devices/{id}/probe`             | test SNMP zapisanego urządzenia                 |
| `GET /api/devices/{id}/interfaces`         | porty z bieżącym ruchem (`in_bps`, `out_bps`)   |
| `GET /api/devices/{id}/wifi`               | sieci WiFi (access point)                       |

Przykład dodania urządzenia:

```json
{ "name": "USW Lite 8 PoE", "host": "192.168.1.2", "community": "public" }
```

SNMPv3:

```json
{ "name": "Router", "host": "192.168.1.1", "snmp_version": "3",
  "v3_username": "monitor", "v3_auth_protocol": "SHA", "v3_auth_key": "...",
  "v3_priv_protocol": "AES", "v3_priv_key": "..." }
```

Community i klucze SNMPv3 **nigdy nie są zwracane** przez API. W `PATCH` pominięte pole
zostaje bez zmian – żeby zmienić np. nazwę, nie trzeba podawać community ponownie.

## Metryki (wykresy)

| Endpoint                                     | Wartości                                   |
|----------------------------------------------|--------------------------------------------|
| `GET /api/interfaces/{id}/metrics?minutes=60` | `in_bps`, `out_bps`, błędy, dropy          |
| `GET /api/devices/{id}/metrics?minutes=60`    | CPU, RAM, load, czas odpytania             |
| `GET /api/wifi/{id}/metrics?minutes=60`       | klienci, `rx_bps`, `tx_bps`                |

`minutes` od 5 do 43200 (30 dni). Punkty są uśredniane tak, żeby wykres miał ok. 300 punktów.
