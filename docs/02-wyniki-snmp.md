# Krok 1 – Wyniki testu SNMP (2026-10-24)

Wszystkie trzy urządzenia odpowiadają na SNMP v2c (community `public`).

## Cloud Gateway Ultra – 192.168.1.1

- sysDescr: `Ubiquiti UniFi UCG-Ultra 5.1.33 Linux 5.4.213 ipq5322`
- Porty fizyczne (IF-MIB, liczniki 64-bit `ifHCIn/OutOctets` działają):

| ifIndex | ifName | Rola (do potwierdzenia) | Status |
|---------|--------|-------------------------|--------|
| 8       | eth4   | WAN                     | up, 1 Gb/s |
| 12      | eth0   | LAN 1                   | up, 1 Gb/s |
| 13      | eth1   | LAN 2                   | up, 1 Gb/s, brak ruchu |
| 14      | eth2   | LAN 3                   | up, 1 Gb/s |
| 15      | eth3   | LAN 4                   | up, 1 Gb/s, brak ruchu |
| 9 / 16 / 17 | switch0, switch0.1, br0 | wewnętrzny switch / VLAN / bridge LAN | – |

- Interfejsy techniczne do ukrycia: `lo`, `dummy0`, `ip_vti0`, `ip6_vti0`, `ip6tnl0`, `miireg`, `bond0`, `ifb0`, `ifb1`.
- Zasoby: UCD-SNMP-MIB (`.1.3.6.1.4.1.2021`) – RAM, load average. Brak HOST-RESOURCES.
- Dodatkowo: IP-MIB, TCP/UDP-MIB, ICMP – statystyki stosu sieciowego.

## USW Lite 8 PoE – 192.168.1.2

- sysName: `USW-Switch`, 8 portów (`ifName` 0/1 … 0/8, `ifDescr` Port 1 … Port 8)
- `ifAlias` niesie nazwy portów nadane w UniFi:

| Port | Alias      | Status |
|------|------------|--------|
| 1    | AP U6+     | up, 1 Gb/s |
| 2–6  | –          | down |
| 7    | –          | up, **100 Mb/s** |
| 8    | UCG Ultra  | up, 1 Gb/s (uplink) |

- BRIDGE-MIB: tablica MAC (11 wpisów) → można pokazać, jakie urządzenia (MAC) są za którym portem.
- UCD-SNMP-MIB: RAM, load.
- **Brak:** PoE (POWER-ETHERNET-MIB), LLDP-MIB.

## U6+ – 192.168.1.3

- Firmware `6.7.54.15663`, interfejs uplink `eth0` (1 Gb/s)
- Radia: `ra*` = 2.4 GHz, `rai*` = 5 GHz (jeden interfejs na SSID)
- **UBNT-UniFi-MIB** (`.1.3.6.1.4.1.41112.1.6`):
  - tabela radiów (2 radia: `ng` 2.4 GHz, `na` 5 GHz)
  - tabela VAP (SSID): nazwa SSID, kanał, **liczba klientów na SSID**, ruch
  - SSID: `Home_WiFi`, `Home 2.4GHz` (+ wewnętrzne `element-*`, `vwire-*` do ukrycia)
- IEEE 802.11 MIB (`.1.2.840.10036`), HOST-RESOURCES, UCD-SNMP-MIB.
- Brak LLDP-MIB.

## Wnioski dla projektu

1. **Ruch na portach** – pełne wsparcie przez IF-MIB na wszystkich urządzeniach.
   Driver generyczny wystarczy do wykresów.
2. **Filtr interfejsów** – driver UniFi musi ukrywać interfejsy techniczne i oznaczać
   WAN/LAN na gatewayu oraz radia/SSID na AP.
3. **Nazwy portów** – brać z `ifAlias` (switch), z fallbackiem na `ifDescr`.
4. **WiFi** – liczba klientów i ruch na SSID dostępne przez SNMP (UBNT-UniFi-MIB).
5. **Czego SNMP nie da:** PoE (pobór mocy na porcie), LLDP/topologia, lista klientów
   z nazwami/IP/sygnałem. To pobierzemy z **UniFi Network API** (klucz API) – etap 6.
6. Port 7 na switchu (100 Mb/s) to telewizor – prędkość prawidłowa.
7. Mapowanie portów UCG Ultra (`eth4` = WAN, `eth0`–`eth3` = LAN 1–4) potwierdzone.
