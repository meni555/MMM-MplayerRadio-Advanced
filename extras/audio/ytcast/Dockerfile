FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && apt-get install -y --no-install-recommends mpv python3 python3-pip ca-certificates tini \
 && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]==2026.10.26" \
 && rm -rf /var/lib/apt/lists/*
# Prefer IPv4 (glibc for mpv/ffmpeg/Python, Node separately): without a working IPv6 route connections to
# YouTube time out ("fetch failed", dropped cast sessions, slow stream resolution).
RUN echo 'precedence ::ffff:0:0/96  100' >> /etc/gai.conf
ENV NODE_OPTIONS=--dns-result-order=ipv4first
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY index.js resolver.py ./
# user node (1000) in group audio (29, as on the host)
RUN groupadd -f -g 29 hostaudio && usermod -aG 29 node && mkdir -p /data && chown node /data
USER node
# yt-dlp cache (player JS, signatures) kept in the volume
ENV XDG_CACHE_HOME=/data/cache
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
