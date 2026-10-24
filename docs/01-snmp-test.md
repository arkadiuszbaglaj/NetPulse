# Krok 1 – Włączenie i test SNMP

## 1. Włącz SNMP w UniFi

W aplikacji UniFi Network (na Cloud Gateway Ultra):

1. **Settings → System → Advanced** (w niektórych wersjach: *Settings → Control Plane → Integrations*)
2. Znajdź sekcję **SNMP Monitoring**
3. Włącz **SNMPv1/v2c**, ustaw własne community (nie zostawiaj `public`), np. `netpulse-ro`
4. Zapisz – ustawienie trafia do adoptowanych urządzeń (switch, AP)

> Nazwy menu zmieniają się między wersjami UniFi Network. Jeśli nie znajdziesz opcji,
> podaj wersję aplikacji (Settings → System → About), dopasujemy instrukcję.

## 2. Spisz adresy IP

| Urządzenie              | IP     | Uwagi |
|-------------------------|--------|-------|
| Cloud Gateway Ultra     | 192.168.1.1 | router / gateway |
| USW Lite 8 PoE          | 192.168.1.2 | switch           |
| U6+                     | 192.168.1.3 | access point     |

Community SNMP v2c: `public` (do zmiany na własną nazwę przed wdrożeniem produkcyjnym)

Adresy znajdziesz w UniFi Network → **UniFi Devices**.

## 3. Test z serwera Ubuntu

```bash
sudo apt update && sudo apt install -y snmp snmp-mibs-downloader
sudo sed -i 's/^mibs :/# mibs :/' /etc/snmp/snmp.conf   # włącza czytelne nazwy MIB

COMM=public
IP=192.168.1.1      # potem 192.168.1.2 i 192.168.1.3

# Podstawowe informacje o urządzeniu
snmpwalk -v2c -c $COMM $IP SNMPv2-MIB::system

# Lista portów
snmpwalk -v2c -c $COMM $IP IF-MIB::ifName

# Liczniki ruchu (64-bit)
snmpwalk -v2c -c $COMM $IP IF-MIB::ifHCInOctets
snmpwalk -v2c -c $COMM $IP IF-MIB::ifHCOutOctets

# Status i prędkość portów
snmpwalk -v2c -c $COMM $IP IF-MIB::ifOperStatus
snmpwalk -v2c -c $COMM $IP IF-MIB::ifHighSpeed

# Sąsiedzi LLDP (topologia) – może być pusto, to też informacja
snmpwalk -v2c -c $COMM $IP 1.0.8802.1.1.2.1.4.1.1
```

## 4. Zapisz wyniki

Najprościej zrzucić wszystko do plików i przekazać je do analizy:

```bash
COMM=public
for IP in 192.168.1.1 192.168.1.2 192.168.1.3; do
  snmpwalk -v2c -c $COMM -On $IP . > snmpwalk_$IP.txt 2>&1
done
```

Pełny walk (`.`) może potrwać do minuty na urządzenie. Te pliki pokażą dokładnie,
jakie dane udostępnia każde urządzenie – na ich podstawie napiszemy driver UniFi.
