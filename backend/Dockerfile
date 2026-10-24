FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Najpierw zależności (lepsze cache warstw przy aktualizacjach)
COPY pyproject.toml ./
COPY netpulse/__init__.py ./netpulse/__init__.py
RUN pip install . && pip uninstall -y netpulse

COPY netpulse ./netpulse
RUN pip install --no-deps . \
    && useradd --system --uid 10001 --no-create-home netpulse

USER netpulse
EXPOSE 8000
CMD ["netpulse", "api"]
