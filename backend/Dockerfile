# Kontekst budowania: katalog główny repozytorium (patrz deploy/docker-compose.yml)

# --- 1. Panel (Node tylko do zbudowania; w obrazie końcowym go nie ma) ---
FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./
RUN npm run build

# --- 2. API i kolektor (Python) ---
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Najpierw zależności (lepsze cache warstw przy aktualizacjach)
COPY backend/pyproject.toml ./
COPY backend/netpulse/__init__.py ./netpulse/__init__.py
RUN pip install . && pip uninstall -y netpulse

COPY backend/netpulse ./netpulse
RUN pip install --no-deps . \
    && useradd --system --uid 10001 --no-create-home netpulse \
    && install -d -o netpulse -g netpulse -m 700 /var/lib/netpulse

# Zbudowany panel – serwuje go API (NETPULSE_WEB_DIR)
COPY --from=web /web/dist /app/web
ENV NETPULSE_WEB_DIR=/app/web

USER netpulse
EXPOSE 8000
CMD ["netpulse", "api"]
