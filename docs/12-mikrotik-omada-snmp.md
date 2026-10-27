# MikroTik i TP-Link (Omada, JetStream) w NetPulse

NetPulse monitoruje te urządzenia przez SNMP. Sterownik **MikroTik RouterOS** i **TP-Link Omada / JetStream**
rozpoznawany jest automatycznie, więc przy dodawaniu zostaw sterownik „Automatyczny".

> **Status:** MikroTik sprawdzony na **prawdziwym RouterOS 7.18.2** (CHR x86 w VirtualBox, zrzut z 2026-10-27:
> `backend/tests/fixtures/mikrotik-chr.snmprec`). Fizycznego routerboardu jeszcze nie było – syntetyczny zrzut
> `mikrotik-hex.snmprec` zostaje dla przypadków, których CHR nie ma (kilka rdzeni, PPPoE, bridge, komentarze portów).
> TP-Link nadal tylko na syntetycznym zrzucie (`tplink-jetstream.snmprec`). Jeśli któreś pole wyjdzie puste albo
> błędne, zrób zrzut (ostatni rozdział) i dopracujemy sterownik.

## Co pokazują

| | MikroTik RouterOS | TP-Link JetStream / Omada |
|---|---|---|
| Typ urządzenia | po nazwie płyty: CRS/CSS i RB260/RB250 = switch, cAP/wAP/SXT/LHG = access point, reszta = router | po modelu: EAP = access point, ER = router, reszta = switch |
| Model i wersja | nazwa płyty i wersja RouterOS (MIKROTIK-MIB) | model z opisu systemu |
| CPU i RAM | średnia z rdzeni i pamięć główna (HOST-RESOURCES-MIB) | tylko jeśli urządzenie udostępnia (zwykle nie) |
| Porty | `ether1` bez komentarza = WAN; komentarz albo nazwa portu ze słowem „wan" lub „internet" (np. przemianowany port „WAN”, „wan1”, „ether1-wan”) oznacza WAN na dowolnym porcie; pozostałe `ether`/`sfp` i przemianowane porty Ethernet (np. „LAN”) = LAN; komentarz portu jest jego nazwą | „Port N" z numeru na końcu nazwy (`gi1/0/12` to Port 12); LAG jako „LAG N" |
| Ukryte | `bridge`, `vlan`, `pppoe-out`, tunele, `lo`, radia `wlan` | `vlan`, `loopback`, `null`, radia |

Tunel PPPoE jest ukryty celowo: ten sam ruch przechodzi przez fizyczny port WAN, więc zliczenie obu podwoiłoby ruch WAN na pulpicie.

Czego jeszcze nie ma: temperatury i napięć MikroTik (wymagają nowych kolumn w bazie, czyli migracji Alembic), danych z kontrolera
Omada (klienci, PoE) oraz API RouterOS.

## Włączenie SNMP

### MikroTik RouterOS (terminal lub WinBox → New Terminal)

SNMP v2c, tylko odczyt, tylko z adresu serwera NetPulse (podmień `192.168.1.10` i nazwę community):

```
/snmp set enabled=yes
/snmp community set [find default=yes] name=netpulse-ro addresses=192.168.1.10/32 read-access=yes write-access=no
```

SNMP v3 (uwierzytelnianie i szyfrowanie), użytkownik `monitor`:

```
/snmp community add name=monitor addresses=192.168.1.10/32 security=private read-access=yes write-access=no authentication-protocol=SHA1 authentication-password=KLUCZ-AUTH encryption-protocol=AES encryption-password=KLUCZ-PRIV
```

W NetPulse wybierz SNMP v3, użytkownika `monitor`, protokół uwierzytelniania `SHA` (to SHA1 z RouterOS) i szyfrowania `AES`.
Klucze muszą mieć co najmniej 8 znaków.

Zapora RouterOS musi przepuszczać UDP 161 z adresu NetPulse do routera (reguła w `input` chain).

### TP-Link JetStream / Omada

Włącz SNMP w interfejsie WWW przełącznika (sekcja **SNMP**: włączony agent, community tylko do odczytu, a przy v3 użytkownik z
uwierzytelnianiem i szyfrowaniem). Dla urządzeń zarządzanych przez kontroler Omada ustawienie SNMP znajduje się w ustawieniach
sieci (site) kontrolera. Nazwy menu zależą od modelu i wersji oprogramowania.

## Dodanie w NetPulse

**Ustawienia → Urządzenia → Dodaj urządzenie**, sterownik „Automatyczny", **Testuj połączenie** (pokaże wykryty typ i model).
To samo z terminala:

```bash
netpulse probe 192.168.1.2 --community netpulse-ro
netpulse device add "hEX" 192.168.1.2 --community netpulse-ro
```

SNMP v3:

```bash
netpulse device add "hEX" 192.168.1.2 --snmp-version 3 --v3-user monitor \
  --v3-auth-proto SHA --v3-auth-key 'KLUCZ-AUTH' --v3-priv-proto AES --v3-priv-key 'KLUCZ-PRIV'
```

Gdy autodetekcja nie trafi, wymuś sterownik w formularzu (MikroTik RouterOS albo TP-Link Omada / JetStream) albo `--driver mikrotik` / `--driver omada`.

## Zrzut do dopracowania sterownika

```bash
snmpwalk -v2c -On -c netpulse-ro 192.168.1.2 > snmpwalk_192.168.1.2.txt
```

Wrzuć plik do folderu projektu (jest w `.gitignore`), a zanonimizujemy go skryptem `backend/tools/walk2snmprec.py` i zastąpimy nim
zrzut syntetyczny.
