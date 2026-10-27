# Integracja z Proxmox VE (od 0.17.0)

NetPulse czyta z Proxmox VE (7 i 8) przez API, tylko do odczytu:

- **węzły**: każdy węzeł staje się serwerem na pulpicie. Karta pokazuje CPU, RAM, obciążenie, czas pracy,
  system plików i magazyny węzła, maszyny i wynik ostatniej kopii. Działają dla niego alerty: nie odpowiada,
  CPU, RAM, zajętość dysku;
- **maszyny VM i kontenery LXC**: strona **Proxmox** w menu (stan, CPU, pamięć, czas pracy, ostatnia kopia),
  wykresy (CPU, pamięć, sieć, dysk wybranej maszyny) i alert „maszyna zatrzymana”;
- **magazyny** (local, LVM-thin, ZFS, NFS, Ceph…): paski zajętości na stronie Proxmox i na karcie węzła
  (alert „zajętość dysku” obejmuje też magazyny);
- **kopie zapasowe**: wynik ostatniego zadania vzdump na każdym węźle i czas ostatniej kopii każdej maszyny,
  z alertami „kopia nie powiodła się” i „brak świeżej kopii”.

## Konfiguracja krok po kroku

1. **Użytkownik:** Datacenter → Permissions → Users → Add: `netpulse`, realm *Proxmox VE authentication server*.
2. **Token:** Datacenter → Permissions → API Tokens → Add: użytkownik `netpulse@pve`, Token ID np. `monitor`,
   **odznacz „Privilege Separation”**. Skopiuj *Token Secret*, bo pokazuje się tylko raz.
3. **Uprawnienia:** Datacenter → Permissions → Add → User Permission: ścieżka `/`, użytkownik `netpulse@pve`,
   rola **PVEAuditor** (tylko odczyt).
4. **NetPulse:** Ustawienia → Proxmox → Dodaj serwer: adres dowolnego węzła (w klastrze wystarczy jeden),
   port 8006, identyfikator `netpulse@pve!monitor`, sekret. Najpierw kliknij **Testuj połączenie**, potem **Zapisz**.

Węzły pojawią się na pulpicie po pierwszym odczycie (do 30 s). Sekret tokenu jest w bazie zaszyfrowany
(`docs/16-szyfrowanie-sekretow.md`) i nie wraca do panelu.

To samo z konsoli Proxmoxa:

```bash
pveum user add netpulse@pve
```

```bash
pveum user token add netpulse@pve monitor --privsep 0
```

```bash
pveum acl modify / --users netpulse@pve --roles PVEAuditor
```

## Alerty (reguły domyślne)

| Reguła | Kiedy | Ważność |
|--------|-------|---------|
| Proxmox: maszyna zatrzymana | maszyna, która działała, zatrzymała się na dłużej niż 1 min. Z filtrem nazwy (np. `homeassistant*`) także maszyna, która nie wystartowała | ostrzeżenie |
| Proxmox: kopia zapasowa nie powiodła się | ostatnie zadanie vzdump na węźle zakończyło się błędem | krytyczny |
| Proxmox: brak świeżej kopii VM | ostatnia kopia maszyny starsza niż 36 h (maszyny bez żadnej kopii nie alarmują) | ostrzeżenie |

Przy aktualizacji ze starszej wersji reguły dochodzą raz. Usuniętej reguły NetPulse nie odtwarza.

## Jak to działa

- `backend/netpulse/proxmox.py`: klient API z tokenem (`Authorization: PVEAPIToken=…`) i parsery
  (`/version`, `/cluster/status`, `/cluster/resources`, `/nodes/<węzeł>/status`, zadania vzdump, pliki kopii).
- `backend/netpulse/proxmox_collector.py`: co cykl kolektora (30 s) węzły, maszyny i magazyny; kopie co 10 minut.
  Węzeł = urządzenie `driver = "proxmox"` (kolektor SNMP go nie odpytuje). Jeśli adres IP węzła jest już
  w NetPulse (np. ten sam serwer dodany przez SNMP), węzeł dostaje adres `nazwa.proxmox`.
- Tabele (migracja `0005`): `proxmox_servers`, `proxmox_nodes`, `proxmox_guests`, `proxmox_storages`. Historia
  maszyn trafia do ogólnej tabeli `metrics` (klucz „nazwa (vmid)”): `guest_up`, `guest_cpu_percent`,
  `guest_mem_bytes`, `guest_net_rx_bps`/`tx`, `guest_disk_read_bps`/`write`, `backup_age_h`, a na węźle `backup_task_ok`.
- Magazyn współdzielony (NFS, Ceph) jest liczony raz, przy pierwszym węźle (alfabetycznie).
- Usunięcie serwera w panelu usuwa jego węzły (urządzenia) z historią. W samym Proxmoxie nic się nie zmienia.

Integracja powstała na atrapie API (`backend/tests/pve_fake.py`) według dokumentacji Proxmox VE 8. 27.10.2026
sprawdzona na prawdziwym Proxmox VE 9.1.1 (jeden węzeł bez klastra, VM zatrzymana i uruchomiona, magazyny `local` i `local-lvm`):
wszystkie odpowiedzi parsują się bez zmian w kodzie, test `test_parsers_real_pve91_single_node` trzyma te dane.
Różnice względem atrapy: brak wpisu `cluster` przy pojedynczym węźle, zasób `network` (SDN) w `/cluster/resources`
– pomijany, pole `memhost` przy VM (PVE 9) – nieużywane. Na prawdziwym sprzęcie czekają jeszcze: LXC,
kopie vzdump, klaster kilku węzłów. Problemy widać w logu kolektora: `netpulse logs collector`.
