# Powiadomienia o alertach (od 0.25.0)

Ustawienia → Powiadomienia → **Dodaj kanał**. Każdy kanał ma własny próg ważności („od ostrzeżeń”, „tylko
krytyczne”), opcję powiadamiania o zakończeniu alertu, ciche godziny i przycisk wiadomości próbnej.

## Rodzaje kanałów

| Rodzaj | Co podać | Uwagi |
|--------|----------|-------|
| Webhook | adres webhooka | JSON z polami `text` (Slack, Telegram, Mattermost, Home Assistant) i `content` (Discord) oraz pełnymi danymi alertu |
| ntfy | adres tematu, np. `https://ntfy.sh/netpulse-xyz`; opcjonalnie token `tk_…` | ważność → priorytet (krytyczny 5, ostrzeżenie 4, informacja 3) i ikona. Na ntfy.sh temat zna każdy, kto zna jego nazwę – wybierz trudną do zgadnięcia albo własny serwer ntfy z tokenem |
| E-mail | serwer SMTP, port, szyfrowanie (STARTTLS / SSL / bez), użytkownik, hasło, nadawca, adresaci | temat `[NetPulse] …`. Gmail: hasło aplikacji (konto Google → Bezpieczeństwo → Hasła aplikacji), `smtp.gmail.com`, 587 STARTTLS |

ntfy na telefonie: zainstaluj aplikację ntfy (Android, iOS), dodaj temat o tej samej nazwie, potem w NetPulse
„Wyślij wiadomość próbną”. NetPulse publikuje JSON-em na adres serwera (`POST https://ntfy.sh/` z polem `topic`),
bo nagłówki HTTP nie przenoszą polskich znaków w tytule.

Sekrety (adres webhooka i tematu ntfy, token ntfy, hasło SMTP) są w bazie zaszyfrowane (kolumny `url` i `secret`,
`docs/16-szyfrowanie-sekretow.md`) i nie wracają do przeglądarki. W edycji puste pole = bez zmian; zapisany token
albo hasło usuwa pole wyboru „Usuń zapisany token / hasło”.

## Ciche godziny

Przy kanale: „Nie wysyłaj w nocy”, godziny od–do (okno może przechodzić przez północ, np. 22:00–07:00). Godziny
liczą się w strefie serwera NetPulse (zmienna `TZ` w `.env`, domyślnie Europe/Warsaw).

- W ciszy alerty krytyczne przychodzą od razu (można to wyłączyć: „Alerty krytyczne wysyłaj także w ciszy”).
- Pozostałe czekają w `notification_channels.quiet_backlog` (w bazie, więc restart ich nie gubi; najwyżej 200
  pozycji, reszta jako liczba). Panel pokazuje przy kanale plakietkę „czeka: N”.
- Po końcu ciszy, w pierwszym cyklu kolektora, przychodzi jedna wiadomość „NetPulse po cichych godzinach: …”
  z listą alertów i zakończeń. Wyłączenie cichych godzin wysyła zaległości od razu.

## Grupowanie

1. **W jednym cyklu**: od 4 zdarzeń naraz kanał dostaje jedną wiadomość zbiorczą zamiast kilku (było od 0.9).
2. **Po topologii**: gdy nie odpowiada urządzenie, a urządzenie nad nim na drodze do routera (mapa LLDP z kontrolera
   UniFi) też nie odpowiada, powiadomienie idzie tylko o tym wyżej, z dopiskiem „Za nim nie odpowiada też: …”.
   Alert urządzenia za nim jest w panelu normalnie, ale z `alerts.muted = true` i bez powiadomienia o zakończeniu.
   Jeśli przyczyna wróci, a urządzenie za nią dalej nie odpowiada, wtedy przychodzi osobne powiadomienie o nim.
   Bez kontrolera UniFi (brak mapy) albo bez routera na mapie grupowanie po topologii nie działa.

Kod: `backend/netpulse/notifications.py` (kanały, ciche godziny, wiadomości), `alerts.py` (`upstream_parents`,
`down_root`, wyciszanie), API `api/notifications.py`, migracja `0009`. Kolektor woła wysyłkę w każdym cyklu,
także bez nowych zdarzeń, żeby po ciszy wysłać zaległości.

## Sprawdzenie

1. Dodaj kanał ntfy albo e-mail i kliknij „Wyślij wiadomość próbną” – w panelu pojawi się „wysłano” albo opis błędu
   (np. `SMTPAuthenticationError` przy złym haśle).
2. Ustaw ciche godziny obejmujące bieżącą godzinę, wyłącz na chwilę urządzenie z regułą o ważności „ostrzeżenie”:
   przy kanale pojawi się „czeka: 1”. Wyłącz ciche godziny – w ciągu 30 s przyjdzie podsumowanie.
3. Grupowanie: wyciągnij kabel uplinku switcha, za którym jest AP – przyjdzie jedna wiadomość o switchu z dopiskiem o AP.
