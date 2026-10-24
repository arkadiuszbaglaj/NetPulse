"""Usługa aktualizacji NetPulse.

Mały proces z dostępem do Dockera, który na polecenie API sprawdza nowe wersje i je instaluje.
Sam API nie ma dostępu do Dockera. Usługa nasłuchuje tylko w sieci wewnętrznej, wymaga tokenu
i potrafi wyłącznie ustalone akcje (status, sprawdzenie, aktualizacja) – bez parametrów od użytkownika.
"""
