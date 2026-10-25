# Serwer Linux w NetPulse przez SNMP

NetPulse monitoruje serwer tak samo jak router czy switch: przez SNMP, bez agenta. Na serwerze działa `snmpd`
(net-snmp), a NetPulse czyta z niego CPU, RAM, swap, obciążenie, dyski, liczbę procesów, czas pracy i ruch
na interfejsach. Interfejsy Dockera (`docker0`, `br-…`, `veth…`) są ukrywane, a dyski bez pamięci, `tmpfs`,
`/run`, `/dev`, snap-ów i warstw Dockera pomijane.

Czego SNMP nie da: kontenerów, usług systemd, SMART i temperatur. To zakres etapu B (własny agent), opisanego
w `docs/06-projekt-panelu.md`.

## 1. Zainstaluj i skonfiguruj `snmpd` (na monitorowanym serwerze)

```bash
sudo apt update && sudo apt install -y snmpd
```

Zastąp zawartość `/etc/snmp/snmpd.conf` minimalną konfiguracją tylko do odczytu. Podmień `192.168.1.10` na adres
serwera z NetPulse, a `netpulse-ro` na własną nazwę community (nie używaj `public`):

```
agentaddress udp:161
rocommunity netpulse-ro 192.168.1.10
sysLocation  szafa
sysContact   admin
```

Domyślnie `snmpd` na Ubuntu nasłuchuje tylko na `127.0.0.1`, dlatego potrzebne jest `agentaddress udp:161`.
`rocommunity` z adresem dopuszcza odczyt wyłącznie z serwera NetPulse.

```bash
sudo systemctl restart snmpd && sudo systemctl enable snmpd
```

Jeśli działa zapora `ufw`, wpuść zapytania tylko z NetPulse:

```bash
sudo ufw allow from 192.168.1.10 to any port 161 proto udp
```

## 2. Sprawdź z serwera NetPulse

```bash
snmpwalk -v2c -c netpulse-ro 192.168.1.20 1.3.6.1.2.1.1
snmpwalk -v2c -c netpulse-ro 192.168.1.20 1.3.6.1.2.1.25.2.3.1.3
```

Pierwsze polecenie ma zwrócić `Linux nazwa-serwera …`, drugie listę punktów montowania (`/`, `/boot`, …).

## 3. Dodaj w NetPulse

**Ustawienia → Urządzenia → Dodaj urządzenie**: adres serwera, community z konfiguracji, sterownik
„Automatyczny” (serwer zostanie rozpoznany sam) i „Testuj połączenie”. Po pierwszym cyklu kolektora (30 s)
karta serwera na Dashboardzie pokazuje CPU, RAM, swap i najbardziej zapełnione dyski. Wykres CPU, RAM i obciążenia
dodasz jako widget „Wykres” ze źródłem „Urządzenie”.

## Rozwiązywanie problemów

| Objaw | Przyczyna |
|-------|-----------|
| „Brak odpowiedzi SNMP” | `snmpd` słucha tylko na `127.0.0.1` (brak `agentaddress udp:161`), zapora albo zły adres w `rocommunity` |
| Brak dysków na karcie | community widzi tylko część drzewa (restrykcyjny `view` w `snmpd.conf`); odczyt `1.3.6.1.2.1.25` musi być dozwolony |
| Dysk, który znasz, nie jest na liście | montowania z `/run`, `/dev`, `/snap`, `/var/lib/docker`, `/boot/efi` są pomijane celowo |
| Serwer rozpoznany jako „Ogólne” urządzenie | wybierz ręcznie sterownik „Serwer Linux (snmpd)” |

## Dla twórców: zrzut do testów

Testy sterownika używają zrzutu `backend/tests/fixtures/linux-server.snmprec`. Obecny jest **syntetyczny**
(odwzorowuje strukturę odpowiedzi `snmpd`), więc dobrze go wymienić na zanonimizowany zrzut z prawdziwego serwera:

```bash
snmpwalk -v2c -On -c netpulse-ro 192.168.1.20 > snmpwalk_192.168.1.20.txt
python3 backend/tools/walk2snmprec.py snmpwalk_192.168.1.20.txt backend/tests/fixtures/linux-server.snmprec
```
