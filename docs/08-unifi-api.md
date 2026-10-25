# Etap 6 – driver UniFi przez API (PoE i klienci WiFi)

SNMP nie podaje PoE na portach ani listy klientów WiFi (nazwa, IP, sygnał). Te dane ma
**UniFi Network API**. Kolejność prac:

1. **6a – rozpoznanie** (ten dokument): sprawdzamy na prawdziwym kontrolerze, co API zwraca,
   i zapisujemy zanonimizowany zrzut jako dane testowe (jak `.snmprec` dla SNMP).
2. **6b – klient API i model danych:** klucz API przy urządzeniu (przechowywany tak jak community),
   nowe tabele na PoE portów i klientów WiFi, test połączenia w „Dodaj urządzenie”.
3. **6c – kolektor i panel:** odczyt co cykl kolektora, PoE na portach switcha, lista klientów WiFi,
   widgety na pulpicie.

## 6a. Klucz API i sonda

1. W UniFi Network: **Settings → Control Plane → Integrations → Create API Key**
   (nazwa dowolna, np. `netpulse`). Skopiuj klucz – widać go tylko raz. Klucz daje dostęp tylko do odczytu
   tego, co udostępnia API integracji; nie wpisuj go do czatu ani do repozytorium.
2. Na serwerze z NetPulse pobierz sondę i uruchom ją, podając klucz zmienną środowiskową:

```bash
curl -fsSLO https://raw.githubusercontent.com/arkadiuszbaglaj/NetPulse/main/backend/tools/unifi_probe.py
UNIFI_API_KEY='wklej-klucz' python3 unifi_probe.py 192.168.1.1
```

3. Sonda wypisuje kody odpowiedzi dla kolejnych adresów API i zapisuje `unifi_probe_192.168.1.1.json`.
   MAC-i, IP, nazwy, SSID, numery seryjne i identyfikatory są w nim zastąpione pseudonimami,
   a struktura i liczby (PoE, sygnał, ruch) zostają. Przejrzyj plik i podaj go do dalszej pracy.

Wersja aplikacji UniFi Network (Settings → System → About) też się przyda: API integracji zmienia się
między wersjami.
