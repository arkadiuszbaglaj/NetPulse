# Asystent AI w NetPulse – propozycja (OpenRouter i inni dostawcy)

Status: **propozycja do decyzji**, bez kodu. Data: 29.10.2026.

## Cel

NetPulse zbiera dużo danych (ruch, porty, alerty, zdarzenia, serwery, Proxmox), ale użytkownik musi je sam
interpretować. Asystent AI ma **tłumaczyć dane na zwykły język** i podpowiadać, co zrobić – bez zastępowania
wykresów i alertów. Działa tylko na żądanie albo przy alertach, nigdy sam niczego nie zmienia w sieci.

## Co asystent miałby robić (od najprostszego)

1. **Wyjaśnienie alertu** – przycisk „Wyjaśnij” przy alercie: co się stało, prawdopodobna przyczyna, co sprawdzić.
   Np. „Port WAN wyłączony 2× w ciągu minuty o 00:28 – najpewniej restart modemu albo luźny kabel; sprawdź…”.
2. **Podsumowanie w powiadomieniu** – zamiast surowej listy alertów po cichych godzinach: 3–4 zdania o nocy.
3. **„Co się działo?” na wykresie** – zaznaczony fragment (mamy już powiększanie) → pytanie do AI z danymi tego
   okna i zdarzeniami (alerty, restarty, przełączenia WAN): „skok o 20:15 to ruch telewizora na porcie 7”.
4. **Raport tygodniowy** – e-mail/ntfy: dostępność, najbardziej obciążone porty, nowe urządzenia, kopie Proxmoxa,
   rzeczy do poprawy (np. fabryczne community SNMP).
5. **Pytania wolne** (później) – okno czatu: „który klient WiFi ma najsłabszy sygnał?”, „czy dysk serwera się
   zapełni w tym miesiącu?”. Asystent odpowiada na podstawie API NetPulse (narzędzia tylko do odczytu).

## Jak to podłączyć

- **Jeden interfejs, wielu dostawców**: moduł `ai` (Ustawienia → Moduły, domyślnie wyłączony) z wyborem dostawcy:
  - **OpenRouter** – jeden klucz, dowolny model (Claude, GPT, Gemini, Llama…), płatność za użycie,
  - **Anthropic / OpenAI bezpośrednio** – dla tych, którzy mają już klucz,
  - **lokalny model** (Ollama, LM Studio – API zgodne z OpenAI) – dane nie opuszczają domu.
  Wszystkie trzy mówią tym samym formatem (OpenAI-compatible chat), więc kod jest jeden; różni się adres i klucz.
- **Klucz API** zaszyfrowany jak inne sekrety (`EncryptedText`, `docs/16-szyfrowanie-sekretow.md`).
- **Backend** robi wszystkie wywołania (panel nigdy nie widzi klucza): `netpulse/ai.py` (klient + przygotowanie
  danych), `api/ai.py` (`POST /api/ai/explain-alert`, `/explain-range`, później `/chat`).
- **Kontekst** budowany po stronie NetPulse z istniejących funkcji (alerty, `events`, metryki, kolekcje) jako krótki,
  uporządkowany tekst – model nie dostaje bazy, tylko to, co potrzebne do pytania.

## Prywatność i bezpieczeństwo

- Moduł domyślnie **wyłączony**; przed pierwszym użyciem jasna informacja, jakie dane wychodzą i do kogo.
- **Anonimizacja przed wysłaniem** (przełącznik, domyślnie włączony): MAC-i, adresy IP, SSID, nazwy hostów
  zamieniane na etykiety („urządzenie A”, „sieć WiFi 1”) – ten sam pomysł co `walk2snmprec.py`.
- Nigdy nie wysyłamy: haseł, community SNMP, kluczy, tokenów, adresów webhooków.
- Asystent **tylko czyta** – żadnych akcji (restart, zmiana konfiguracji) bez osobnej, świadomej decyzji w przyszłości.
- Lokalny model jako opcja dla osób, które nie chcą nic wysyłać na zewnątrz.

## Koszty

- Wyjaśnienie alertu albo fragmentu wykresu: kilka tysięcy tokenów – przy tanim modelu ułamek grosza, przy
  najmocniejszych kilka groszy. Raport tygodniowy: podobnie.
- **Limit miesięczny** w ustawieniach (np. „najwyżej 5 zł / 200 zapytań”), licznik użycia w panelu.
- Domyślnie tani, szybki model; mocniejszy do wyboru.

## Etapy

| Etap | Zakres |
|------|--------|
| AI-1 | Moduł `ai`, ustawienia dostawcy (OpenRouter / OpenAI-compatible / lokalny), szyfrowany klucz, test połączenia, limit kosztów, anonimizacja. Przycisk „Wyjaśnij” przy alercie. |
| AI-2 | „Co się działo?” na zaznaczonym fragmencie wykresu (dane okna + zdarzenia). |
| AI-3 | Podsumowania w powiadomieniach i raport tygodniowy. |
| AI-4 | Czat z narzędziami tylko do odczytu (API NetPulse jako narzędzia modelu). |

Każdy etap to osobna wersja; testy na atrapie dostawcy (jak `pve_fake.py`), bez prawdziwych wywołań w CI.

## Pytania do decyzji

1. Czy AI ma być w ogóle w NetPulse, czy raczej jako dodatek w przyszłej chmurze / aplikacji mobilnej?
2. Który etap najpierw – wyjaśnianie alertów (AI-1) czy raport tygodniowy (AI-3)?
3. Domyślny dostawca w instrukcji: OpenRouter (prościej, płatnie) czy lokalny model (prywatnie, wymaga sprzętu)?
4. Czy anonimizacja ma być wymuszona dla dostawców zewnętrznych, czy tylko domyślnie włączona?
5. Związek z licencjami (`docs/09-licencje-propozycja.md`): funkcja dla wszystkich czy w wersji płatnej?
