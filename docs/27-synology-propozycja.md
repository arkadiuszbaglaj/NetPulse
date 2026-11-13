# Synology NAS – propozycja

Status: **propozycja, odłożona** (4.11.2026). Nic z tego nie jest jeszcze zrobione. Czeka na zrzut SNMP
z prawdziwego Synology (użytkownik nie ma urządzenia) i decyzję użytkownika.

Źródło: przewodnik Synology „SNMP MIB Guide” (aktualizacja sierpień 2026, 68 stron). PDF jest chroniony prawem
autorskim – **nie trafia do repo**; korzystamy tylko z numerów OID i znaczenia wartości (fakty techniczne).
MIB-y Synology użytkownik pobiera ze strony Synology.

## Dziś

Synology przedstawia się jak zwykły Linux (`sysDescr` „Linux …”, `sysObjectID` net-snmp), więc trafia do drivera
`linux`: porty (IF-MIB), CPU/RAM/load (UCD), zajętość systemów plików (HOST-RESOURCES). Brak dysków fizycznych,
RAID, temperatur, wentylatorów, UPS.

## Co daje SNMP Synology

Gałąź `.1.3.6.1.4.1.6574`; tabele mają prefiks `<gałąź>.1.1.<kolumna>.<indeks>`.

| MIB | OID | Co bierzemy | Uwagi |
|---|---|---|---|
| System | `.6574.1` | `systemStatus` (.1), `temperature` (.2), `powerStatus` (.3), `systemFanStatus` (.4.1), `cpuFanStatus` (.4.2), `modelName` (.5.1), `serialNumber` (.5.2), `version` (.5.3), `upgradeAvailable` (.5.4), `cpuUtilization` (.7.1), `memUtilization` (.7.2), `thermalStatus` (.8) | stany 1 = normal, 2 = failed; `upgradeAvailable` 1 = dostępna; numer seryjny anonimizować w zrzutach |
| Disk | `.6574.2.1.1` | `diskModel` (.3), `diskType` (.4), `diskStatus` (.5), `diskTemperature` (.6), `diskRole` (.7), `diskRetry` (.8), `diskBadSector` (.9), `diskIdentifyFail` (.10), `diskRemainLife` (.11), `diskName` (.12), `diskHealthStatus` (.13) | `diskStatus`: 1 normal, 2 initialized, 3 not initialized, 4 system partition failed, 5 crashed; `diskHealthStatus` (DSM 7.1+): 1 normal, 2 warning, 3 critical, 4 failing; .7–.12 od DSM 7.0 |
| RAID | `.6574.3.1.1` | `raidName` (.2), `raidStatus` (.3), `raidFreeSize` (.4), `raidTotalSize` (.5), `raidHotspareCnt` (.6) | wiersze = pule i wolumeny; `raidStatus`: 1 normal, 2–10 i 13–20 operacje w toku (naprawa, synchronizacja, scrubbing, rozbudowa…), 11 degraded, 12 crashed, 21 unknown |
| UPS | `.6574.4` | model (.1.1), producent (.1.2), stan (.2.1, tekst), obciążenie % (.2.12.1), naładowanie (.3.1.1), próg ostrzeżenia (.3.1.4) | OID-y pojawiają się tylko, gdy UPS je podaje; wartości „Float” – sprawdzić format na zrzucie |
| SMART | `.6574.5.1.1` | urządzenie (.2), nazwa atrybutu (.3), ID (.4), current (.5), worst (.6), threshold (.7), raw (.8), status (.9), raw64 (.10) | wiersz = atrybut dysku; dużo wierszy – czytać rzadziej (np. co 10 min) |
| Services | `.6574.6.1.1` | nazwa usługi (.2), liczba użytkowników (.3) | SMB, AFP, NFS, FTP, SSH, HTTP… |
| StorageIO | `.6574.101.1.1` | urządzenie (.2), bajty odczyt/zapis 64-bit (.12, .13), operacje odczyt/zapis (.5, .6, Counter32), obciążenie % (.8, .9–.11) | I/O na dysk |
| SpaceIO | `.6574.102.1.1` | urządzenie (.2), bajty odczyt 64-bit (.12), zapis (.4 Counter32 / .13 64-bit), obciążenie % (.8) | I/O na wolumen; **`spaceIONWrittenX` (.13) według dokumentu tylko DSM Enterprise / UC** |
| Ebox | `.6574.105.1.1` | model (.2), zasilanie (.3), zasilanie redundantne (.4) | półki rozszerzeń; 1 normal, 2 poor, 3 disconnected |
| FlashCache, iSCSI LUN/Target, NFS, SMB, GPU, SHA (HA) | `.103`, `.104`, `.110`, `.107`, `.111`, `.108`, `.106` | później, gdy ktoś będzie potrzebował | SMB od DSM 7.2; GPU tylko modele z kartą |
| CAM, NVMeoF, MailPlus, APM, Port | `.115`, `.114`, `.201`, `.301`, `.109` | pomijamy | DSM Enterprise, poczta, ActiveProtect, SRM (routery) |

Standardowe (już czytane): IF-MIB, UCD-SNMP-MIB (load, CPU, pamięć), HOST-RESOURCES (`hrStorage`);
dodatkowo dostępny UCD-DISKIO-MIB (`.1.3.6.1.4.1.2021.13.15`).

## Pułapki

1. **Rozpoznanie** – `match()` dostaje dziś tylko `SystemInfo` (`sysDescr`, `sysObjectID`). Synology wymaga
   dodatkowego odczytu `modelName` (`.1.3.6.1.4.1.6574.1.5.1.0`) przy wyborze drivera: np. krok „sondy” dla
   kandydatów z `sysDescr` „Linux ”, wynik zapamiętany, żeby nie pytać co cykl.
2. **`raidFreeSize` / `raidTotalSize` to Counter64, ale nie liczniki** – rozmiary w bajtach; traktować jak
   wartość chwilową, nie liczyć przyrostu na sekundę.
3. **Liczniki 32-bitowe** – zapis na wolumen w zwykłym DSM tylko jako Counter32 (`spaceIONWritten`): przekręca
   się powyżej ~143 MB/s przy cyklu 30 s (10 GbE to przekroczy). Preferować 64-bit, gdy jest; inaczej ryzyko R1
   z `docs/26-plan-testow-sprzetu.md`. Operacje (`storageIOReads/Writes`) też Counter32.
4. **Dużo pól tylko w DSM Enterprise** (opóźnienia I/O, `raidSummary`, numer seryjny dysku, operacje 64-bit) –
   driver musi działać, gdy ich brak.
5. **iSCSI / NVMeoF** – przepustowość jako dwie liczby 32-bit (High/Low) do złożenia.
6. **SNMPv3** – Synology zaleca v2c dla pełnych danych z gałęzi Synology; sprawdzić, czy v3 czegoś nie ukrywa.
7. **Brak pułapek SNMP w DSM** – nie przeszkadza, UplinkView odpytuje cyklicznie.
8. **Anonimizacja zrzutów** – numery seryjne NAS-a, dysków i UPS, nazwy wolumenów i usług, `sysName`.

## Propozycja

### Etap 1 – driver `synology` (SNMP), wersja minor

- rozpoznanie przez sondę `modelName` (pułapka 1), `vendor = "Synology"`, model i wersja DSM na karcie,
- karta NAS-a (rozszerzenie karty serwera): stan systemu, temperatura, wentylatory, zasilacz, CPU/RAM, dostępna
  aktualizacja DSM,
- tabela dysków: model, rola, stan, zdrowie, temperatura, złe sektory, pozostała żywotność; szczegóły SMART
  na stronie dysku (odczyt rzadziej),
- pule i wolumeny: stan (z mapą 21 stanów), zajętość, hot spare; oś stanów (`state_timeline`) – np. czas
  synchronizacji lub scrubbingu,
- wykresy: I/O dysków i wolumenów (bajty/s, obciążenie %), temperatury, użytkownicy usług, UPS,
- zapis: istniejące tabele dysków serwera tam, gdzie pasują, reszta w ogólnej tabeli `metrics`
  (`name` np. `syno_disk_temp`, `key` = dysk) – bez nowej tabeli, jeśli się da,
- **alerty**: dysk `diskStatus` ≠ normal lub `diskHealthStatus` ≥ warning, przyrost złych sektorów, pozostała
  żywotność poniżej progu, RAID degraded / crashed, operacja na RAID trwa dłużej niż N h, wentylator / zasilacz /
  stan termiczny failed, temperatura systemu lub dysku powyżej progu, zajętość wolumenu, UPS na baterii lub niskie
  naładowanie, dostępna aktualizacja DSM (informacyjnie),
- szablony widgetów (`lib/widgetTemplates.ts`) „Synology” i ścieżki w `resolve()` dla pulpitu publicznego,
- fixture `synology-<model>.snmprec` + testy drivera w CI.

### Etap 2 – moduł „Synology DSM” (API), później

To, czego SNMP nie daje: zadania **Hyper Backup** i Snapshot Replication (stan, ostatnie powodzenie – alert
„brak świeżej kopii”, jak w Proxmoxie), pakiety i ich aktualizacje, **Container Manager**, zajętość folderów
współdzielonych, zdarzenia i Security Advisor. Konto DSM tylko do odczytu, klucz w bazie zaszyfrowany
(`EncryptedText`), moduł w Ustawienia → Moduły (wzór: UniFi, Proxmox). Wymaga osobnej analizy API DSM.

### Później

FlashCache, iSCSI, NFS, SMB, GPU, HA, półki rozszerzeń – gdy zgłosi się użytkownik z takim sprzętem.

## Warunek startu

Zrzut `snmpwalk` z prawdziwego Synology (najlepiej DSM 7.2, z UPS i przynajmniej dwoma dyskami), zanonimizowany
(`backend/tools/walk2snmprec.py` – do rozszerzenia o numery seryjne Synology). Sam przewodnik nie wystarczy:
nie pokazuje jednostek w praktyce (°C czy dziesiąte części), indeksów, obecności SMART i UPS, zachowania
liczników. Źródła zrzutu: znajomy z Synology albo raport urządzenia z `docs/24-wykrywanie-propozycja.md` (część B).
Driver na syntetycznym zrzucie (jak Omada) – tylko jeśli użytkownik tak zdecyduje.

## Pytania otwarte

- Czy etap 1 robić na zrzucie syntetycznym z przewodnika, zanim pojawi się prawdziwy?
- Czy moduł DSM API ma obejmować tylko kopie (Hyper Backup), czy od razu pakiety i kontenery?
