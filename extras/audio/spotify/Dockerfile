# Spotify Soloist + bridge for MMM-MplayerRadio-Advanced
#
# Debian trixie is required: the official Soloist binary needs glibc >= 2.38.
# It is not redistributed here; entrypoint.sh downloads the current build from
# soloist-builds.spotifycdn.com at container start (and refreshes it every 30 days,
# because Soloist builds expire after 90 days).
FROM debian:trixie-slim AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*
COPY hideifaces.c /src/hideifaces.c
RUN gcc -shared -fPIC -O2 -o /src/libhideifaces.so /src/hideifaces.c -ldl

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tar nodejs npm \
      libatomic1 libpulse0 pipewire-bin \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY bridge.js entrypoint.sh ./
COPY --from=builder /src/libhideifaces.so /app/libhideifaces.so
RUN chmod 755 entrypoint.sh \
 && mkdir -p /data \
 && chown 1000:1000 /data

ENTRYPOINT ["/app/entrypoint.sh"]
