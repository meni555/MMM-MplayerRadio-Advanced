# MagicMirror image with the packages MMM-MplayerRadio-Advanced needs: VLC for the streams, alsa-utils
# (amixer) for the volume, emoji font. Installing them with docker exec is lost when the container is recreated.
ARG BASE=karsten13/magicmirror:latest
FROM ${BASE}
USER root
RUN echo 'Acquire::Retries "5";' > /etc/apt/apt.conf.d/80-retries \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      vlc-bin vlc-plugin-base alsa-utils fonts-noto-color-emoji \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*
USER node
