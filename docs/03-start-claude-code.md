# Krok 2 – Przejście na Claude Code (serwer Ubuntu)

## 1. Zainstaluj Claude Code na serwerze

Zaloguj się na serwer przez SSH i uruchom:

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Zamknij i otwórz ponownie terminal (lub zaloguj się ponownie), potem sprawdź:

```bash
claude --version
```

Wymagany plan Pro, Max, Team lub Enterprise (darmowy plan nie obejmuje Claude Code).

## 2. Zainstaluj git i sklonuj repozytorium

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/arkadiuszbaglaj/NetPulse.git
cd NetPulse
```

## 3. Uruchom Claude Code w katalogu projektu

```bash
claude
```

Przy pierwszym uruchomieniu pojawi się link do logowania – otwórz go w przeglądarce
na Windowsie, zaloguj się i wklej kod z powrotem do terminala.

## 4. Pierwsze polecenie w Claude Code

Plik `CLAUDE.md` w repozytorium zawiera cały dotychczasowy kontekst (urządzenia, wyniki SNMP,
stack, plan). Claude Code wczytuje go automatycznie. Na start wystarczy napisać:

> Przeczytaj CLAUDE.md i docs/. Zaczynamy krok 2 z planu: szkielet projektu, Docker Compose
> z TimescaleDB i skrypt install.sh. Prowadź mnie krok po kroku.
