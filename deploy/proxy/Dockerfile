# Wejście do panelu (od 0.62.0): HTTP (jak dotąd) i HTTPS z certyfikatem lokalnego CA UplinkView.
# Kontekst budowania: katalog główny repozytorium (patrz deploy/docker-compose.yml)
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY deploy/proxy/nginx.conf /etc/nginx/nginx.conf
COPY deploy/proxy/proxy-common.conf /etc/nginx/proxy-common.conf
COPY deploy/proxy/tls.sh /usr/local/bin/netpulse-tls
RUN chmod 755 /usr/local/bin/netpulse-tls

EXPOSE 8080 8443
HEALTHCHECK --interval=15s --timeout=5s --retries=4 --start-period=10s \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/proxy-health || exit 1

ENTRYPOINT ["/usr/local/bin/netpulse-tls"]
CMD ["run"]
