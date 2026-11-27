#!/bin/bash
# Container entrypoint: fetch/update the official Spotify Soloist build, start the bridge,
# then run Soloist in the foreground. Skeleton builds expire 90 days after their build date;
# refreshing the binary every 30 days keeps the container working without an image rebuild.
set -uo pipefail

log() { echo "$(date -Is) [entrypoint] $*"; }

ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) SOLOIST_ARCH=x86_64 ;;
  aarch64|arm64|armv8l) SOLOIST_ARCH=arm64 ;;
  armv7l|armv7|armhf) SOLOIST_ARCH=arm32 ;;
  *)
    log "unsupported architecture: $ARCH (Soloist supports x86_64, aarch64 and armv7)"
    exit 1
    ;;
esac

DATA_DIR=${SOLOIST_DATA_DIR:-/data}
BIN_DIR="$DATA_DIR/bin"
BIN="$BIN_DIR/soloist"
URL="https://soloist-builds.spotifycdn.com/soloist_release_${SOLOIST_ARCH}.tar.gz"

mkdir -p "$BIN_DIR" "$DATA_DIR/cache"

# Download when missing or older than 30 days. The official build expires after 90 days,
# so this leaves two months of margin and also works for a long-running container that is
# restarted by Docker after the old build expires (exit code 10).
refresh=0
if [ ! -x "$BIN" ]; then
  refresh=1
elif [ -n "$(find "$BIN" -maxdepth 0 -mtime +30 2>/dev/null)" ]; then
  refresh=1
fi

if [ "$refresh" = 1 ]; then
  log "downloading Spotify Soloist ($SOLOIST_ARCH)"
  tmp=$(mktemp -d)
  if curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 -o "$tmp/soloist.tar.gz" "$URL" \
     && tar -xzf "$tmp/soloist.tar.gz" -C "$tmp" soloist \
     && install -m 755 "$tmp/soloist" "$BIN.new" \
     && mv "$BIN.new" "$BIN"; then
    log "installed $("$BIN" --version 2>/dev/null | head -1)"
  else
    log "download failed"
    if [ ! -x "$BIN" ]; then
      log "no working Soloist binary available"
      rm -rf "$tmp"
      exit 1
    fi
    log "keeping the existing build"
  fi
  rm -rf "$tmp"
fi

NAME=${SOLOIST_DEVICE_NAME:-MagicMirror}
WS_PORT=${SOLOIST_WS_PORT:-9090}
VOLUME=${SOLOIST_INITIAL_VOLUME:-60}

args=(-n "$NAME" --ws "127.0.0.1:$WS_PORT" -D "$DATA_DIR" -C "$DATA_DIR/cache" -i "$VOLUME")
[ -n "${SOLOIST_AUDIO_DEVICE:-}" ] && args+=(--audio-device "$SOLOIST_AUDIO_DEVICE")
[ -n "${SOLOIST_API_KEY:-}" ] && args+=(-k "$SOLOIST_API_KEY")
[ "${SOLOIST_VERBOSE:-0}" = "1" ] && args+=(-v)

export SOLOIST_WS=${SOLOIST_WS:-ws://127.0.0.1:$WS_PORT}
node /app/bridge.js &
BRIDGE_PID=$!

log "starting Soloist as \"$NAME\" (ws 127.0.0.1:$WS_PORT)"
# hideifaces.so keeps Docker bridge/VPN addresses out of Soloist's mDNS record; without it
# the Spotify app receives an unreachable 172.x address and never lists the device.
LD_PRELOAD=/app/libhideifaces.so "$BIN" "${args[@]}" &
SOLOIST_PID=$!

shutdown() {
  log "shutting down"
  kill -TERM "$BRIDGE_PID" "$SOLOIST_PID" 2>/dev/null
  wait "$BRIDGE_PID" "$SOLOIST_PID" 2>/dev/null
  exit 0
}
trap shutdown TERM INT

wait -n "$BRIDGE_PID" "$SOLOIST_PID"
STATUS=$?
log "a child process exited (status $STATUS), stopping the container"
kill -TERM "$BRIDGE_PID" "$SOLOIST_PID" 2>/dev/null
wait "$BRIDGE_PID" "$SOLOIST_PID" 2>/dev/null
exit "$STATUS"
