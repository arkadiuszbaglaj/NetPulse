# Usługa aktualizacji NetPulse. Kontekst budowania: katalog główny repozytorium (patrz deploy/docker-compose.yml)
# Obraz z klientem Dockera i pluginem compose; ma dostęp do gniazda Dockera, dlatego jest mały, osobny
# i nie wystawia żadnego portu poza siecią wewnętrzną.
FROM docker:27-cli

RUN apk add --no-cache git python3 tzdata \
    && git config --system --add safe.directory '*' \
    && docker compose version

WORKDIR /app
COPY updater/netpulse_updater ./netpulse_updater

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=4 --start-period=10s \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"

ENTRYPOINT []
CMD ["python3", "-m", "netpulse_updater"]
