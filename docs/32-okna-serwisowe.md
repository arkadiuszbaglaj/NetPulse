# Okna serwisowe (0.60.0)

Planowane prace (restart routera, aktualizacja firmware, wymiana kabla) nie powinny budzić powiadomieniami
ani obniżać dostępności. Okno serwisowe mówi NetPulse: „w tym czasie to jest zaplanowane”.

## Co robi okno

| W trakcie okna | Zachowanie |
|---|---|
| Nowy alert (urządzenie nie odpowiada, port, metryka, restart…) | powstaje w panelu z plakietką **„okno serwisowe”**, **bez powiadomienia** i bez zapalania dzwonka |
| Alert, który trwa dalej po końcu okna | wtedy przychodzi powiadomienie (jak o nowym alercie, z pierwotnym czasem początku) |
| Alert, który kończy się w trakcie okna | bez powiadomienia „zakończony” |
| Alert sprzed okna | trwa normalnie (było już o nim powiadomienie) |
| Dostępność urządzenia i jego portów | próbki z czasu okna się nie liczą; kafelek pokazuje „bez X prac serwisowych” |
| Karta, tabela i strona urządzenia | plakietka **„prace serwisowe”** |

## Rodzaje okien

- **Jednorazowe** – początek i koniec (czas przeglądarki), najwyżej 31 dni.
- **Co tydzień** – dni tygodnia, godzina początku (czas serwera, zmienna TZ) i czas trwania (do 7 dni).
  Okno przez północ (np. sobota 23:00 przez 3 h) należy do dnia, w którym się zaczyna. Po zmianie czasu
  zostaje o tej samej godzinie lokalnej.

**Zakres:** wybrane urządzenia albo „Wszystkie urządzenia”. Okno na wszystko obejmuje też alerty bez urządzenia
(sprawdzenia dostępności, dysk serwera NetPulse).

## Kod

- Model `MaintenanceWindow` (tabela `maintenance_windows`, migracja 0013; ta sama migracja dodaje `alerts.maintenance`).
- Logika (czysta, bez bazy): `backend/netpulse/maintenance.py` – `Window.occurrences`, `active`, `in_maintenance`, `spans_for`.
- API: `backend/netpulse/api/maintenance.py` – `GET/POST /api/maintenance`, `PUT/DELETE /api/maintenance/{id}`
  (zmiany tylko administrator). `DeviceOut.maintenance`, `AlertOut.maintenance`, `AvailabilityOut.maintenance_s`.
- Alerty: `alerts.py` – alert z okna ma `muted = maintenance = true`; po oknie `muted` znika i idzie powiadomienie.
  `/api/alerts/summary` nie liczy alertów z okna do `unacked` (dzwonek).
- Dostępność: `api/availability.py` odejmuje próbki z przedziałów okien (surowe tabele złączone z listą przedziałów).
- Panel: Ustawienia → Okna serwisowe (`pages/settings/MaintenancePage.tsx`, `lib/maintenance.ts`), `MaintenanceBadge`
  w `components/widgets/DevicesWidget.tsx`.

## Ograniczenia

- Odejmowanie z dostępności korzysta z surowych próbek (retencja `NETPULSE_RETENTION_DAYS`, domyślnie 30 dni).
  Okna starsze niż retencja zostają w wyniku dostępności za rok.
- SLA łączy WAN (`/api/wan/sla`) i dostępność sprawdzeń (`availability_24h`) jeszcze nie odliczają okien.
- Usunięcie albo wyłączenie okna przywraca jego czas do wyniku dostępności.

## Jak sprawdzić na serwerze

1. Ustawienia → Okna serwisowe → **Dodaj okno**: jednorazowe, teraz + 15 min, tylko jedno urządzenie (np. AP).
2. Na pulpicie przy AP pojawia się „prace serwisowe”.
3. Odłącz AP od zasilania na 4 minuty (reguła „Urządzenie nie odpowiada” czeka 2 min). W Alertach pojawia się „U6+ nie odpowiada” z plakietką „okno serwisowe”,
   bez powiadomienia, a dzwonek się nie zapala.
4. Podłącz AP. Alert się kończy bez powiadomienia „zakończony”, a strona AP pokazuje dostępność bez tych minut
   („bez X prac serwisowych”).
