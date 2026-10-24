# NetPulse – panel (frontend)

React 19 + TypeScript + Vite + Tailwind CSS 4, TanStack Query, React Router.
Panel jest wyłącznie klientem API (`/api`); w obrazie Dockera jest budowany w osobnym etapie
i serwowany przez backend (`NETPULSE_WEB_DIR`). Plan i etapy: [`docs/06-projekt-panelu.md`](../docs/06-projekt-panelu.md).

## Praca nad panelem

Wymaga Node.js 24 LTS.

```bash
cd frontend
npm install
npm run mock     # atrapa API na :8000 (dane w pamięci, bez bazy i urządzeń)
npm run dev      # panel na :5173, zapytania /api idą do :8000
```

Prawdziwy backend zamiast atrapy: `NETPULSE_API=http://adres:8000 npm run dev`.
Atrapa pierwszy raz pokazuje kreator konta, tak jak prawdziwe API.

```bash
npm run typecheck   # TypeScript
npm test            # testy (Vitest + Testing Library)
npm run build       # produkcyjny build do dist/
```

## Struktura

| Miejsce                  | Co tam jest                                                        |
|--------------------------|--------------------------------------------------------------------|
| `src/modules.tsx`        | rejestr modułów: z niego powstaje menu i routing (nowa sekcja = wpis) |
| `src/components/`        | powłoka (pasek górny, menu, menu konta, motyw) i wspólne elementy UI |
| `src/auth/`              | stan logowania, ekran logowania i kreator pierwszego konta          |
| `src/pages/`             | widoki (Dashboard, Ustawienia)                                      |
| `src/lib/`               | klient API, motyw, formatowanie, klient zapytań                     |
| `src/i18n/`              | teksty interfejsu (polski; kolejne języki = kolejne pliki)          |
| `dev/mock-api.mjs`       | atrapa API do developmentu                                          |
| `tools/make-icons.py`    | generuje favicon i ikony z logo (`pip install pillow`)              |

Kolory są zmiennymi CSS w `src/index.css` (motyw jasny i ciemny przełącza `data-theme` na `<html>`),
więc komponenty używają nazw semantycznych (`bg-surface`, `text-text-2`, `bg-accent`).
