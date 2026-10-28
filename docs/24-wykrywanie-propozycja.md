# Wykrywanie urządzeń i zgłaszanie specyfikacji – propozycja

Status: **propozycja, odłożona** (28.10.2026). Nic z tego nie jest jeszcze zrobione. Do decyzji użytkownika.

## Problem

Kupowanie każdego urządzenia, żeby dodać jego pełne wsparcie (driver producenta), jest kosztowne. Potrzebny jest
sposób, żeby system sam znajdował urządzenia w sieci i żeby użytkownicy mogli łatwo przekazać „specyfikację”
urządzenia, którego NetPulse jeszcze dobrze nie zna.

Ważne: nieznane urządzenie już dziś działa – driver ogólny (IF-MIB) obsługuje każde urządzenie z SNMP (porty,
ruch, błędy, stan). Driver producenta dokłada tylko szczegóły (nazwy portów, CPU, WiFi, czujniki).

## Część A – wykrywanie urządzeń w sieci

Ustawienia → Urządzenia → **Wykryj** (także jako krok kreatora `/setup`):

- skan wskazanej podsieci (np. `192.168.1.0/24`): ping (jest już w `netpulse/checks.py`), potem SNMP
  `sysDescr`, `sysObjectID`, `sysName` z podanym community albo danymi v3,
- lista wyników: adres, nazwa, producent, wykryty driver, oznaczenie „ogólny – brak pełnej specyfikacji”,
  „już w NetPulse”,
- **użytkownik zaznacza, co dodać** – bez automatycznego dodawania na start (w domu SNMP mają też drukarki,
  telewizory, NAS-y); automat jako opcja później, np. „dodawaj nowe routery i switche”,
- skan w tle w kolektorze albo API, z limitem równoległości i czasu; wyniki ważne kilka minut.

Wersja: minor. Korzysta z istniejących `snmp`/`drivers` (wybór drivera po `sysObjectID`/`sysDescr`).

## Część B – „Pomóż dodać to urządzenie” (raport specyfikacji)

Na stronie urządzenia działającego na driverze ogólnym (albo z nieznanym `sysObjectID`) komunikat i przycisk
**Przygotuj raport urządzenia**:

- NetPulse robi zrzut SNMP ważnych gałęzi (system, IF-MIB, ENTITY, HOST-RESOURCES, UCD, gałąź producenta),
- **od razu anonimizuje** – jak `backend/tools/walk2snmprec.py`: MAC-i, SSID, adresy IP, numery seryjne,
  `sysContact`, `sysLocation`; community nigdy nie trafia do raportu,
- **pokazuje treść przed wysłaniem**; użytkownik pobiera plik `.snmprec` albo klika link otwierający
  zgłoszenie na GitHubie (szablon issue z modelem, firmware, `sysObjectID`) i dołącza plik.

Na start **bez automatycznej wysyłki** (serwer projektu, e-mail):

- NetPulse nie ma jeszcze serwera projektu przyjmującego zgłoszenia – dojdzie z chmurą,
- automatyczne wysyłanie danych z cudzej sieci wymaga wyraźnej zgody, polityki prywatności i ustalenia
  administratora danych – łączy się z otwartą decyzją o licencji i modelu biznesowym (`docs/09-licencje-propozycja.md`),
- zgłoszenie na GitHubie nic nie kosztuje, jest jawne i widać, co wysłano.

Później: przycisk „Wyślij do NetPulse” z tym samym podglądem i zgodą, gdy będzie chmura.

Dalszy krok, gdy zgłoszeń przybędzie: profile urządzeń jako dane (np. YAML: rozpoznanie, role portów, OID-y CPU
i czujników) zamiast kodu – łatwiej przyjmować wkład od innych.

## Taniej niż kupowanie sprzętu

Routery wirtualne z SNMP w VirtualBoxie, jak MikroTik CHR (`mikrotik-chr.snmprec`): OpenWrt x86, pfSense,
OPNsense, VyOS. Sprzęt fizyczny potrzebny głównie do PoE, czujników i WiFi.

## Kolejność (gdy wrócimy)

1. Część A (wykrywanie) – od razu przydatne dla każdej instalacji.
2. Część B (raport) – korzysta z tego samego odczytu SNMP.
3. Wysyłka do serwera projektu – razem z chmurą i po decyzji o licencji.
