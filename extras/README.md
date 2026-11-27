# Extras for MMM-MplayerRadio-Advanced

🇩🇪 Kurzfassung auf Deutsch am Ende.

## Audio services (`audio/`)

Two services that run next to MagicMirror on the same device and use the same sound card as the radio:

| Service | What | Ports (host network) |
|---|---|---|
| `spotify` | [Spotify Soloist](https://github.com/spotify/soloist): Spotify's official headless Connect client "MagicMirror", plus a small bridge that keeps the old go-librespot API | 3678 (API), 9090 (local WebSocket) |
| `ytcast` | "Cast to" target for YouTube / YouTube Music ([yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) + mpv + yt-dlp) | 8098 (DIAL), 8099 (status API) |

Both tell the radio module what is playing (`RADIO_EXTERNAL` via MMM-Remote-Control) and coordinate:
YouTube stops the radio and pauses Spotify, Spotify stops the radio and pauses YouTube, the radio stops both.

### Why Spotify Soloist instead of go-librespot?

Spotify has switched off the legacy audio-key interface used by librespot, spotifyd and go-librespot for many
accounts. Those clients log `audio key error 0 1` / `failed retrieving aes key with code 1` and skip every track;
the restriction is server-side and cannot be fixed in librespot (see
[librespot #1649](https://github.com/librespot-org/librespot/issues/1649) and
[go-librespot #279](https://github.com/devgianlu/go-librespot/issues/279)). Spotify's official answer is
**Spotify Soloist**, a headless Connect client for Linux with the same playback engine as the desktop/mobile apps.
It supports x86_64, AArch64 and ARMv7 (Raspberry Pi) and offers a local WebSocket API.

A Premium account is needed once to create the Soloist API key; after that free and Premium accounts can connect.
The container downloads the official binary at start (Soloist may not be redistributed), and the bridge translates
between Soloist's WebSocket API and the HTTP API that MMM-MplayerRadio-Advanced and
[magicmirror-control](https://github.com/meni555/magicmirror-control) already use.

### Setup

```bash
cp -r extras/audio ~/mm-audio && cd ~/mm-audio
cp .env.example .env
chmod 600 .env
nano .env                       # MM_TOKEN, SOLOIST_API_KEY, PUID, AUDIO_GID, ...
mkdir -p spotify-data
docker compose up -d --build
```

1. **Create a Soloist API key** at <https://developer.spotify.com/dashboard/soloist> (Premium required once)
   and put it in `.env` as `SOLOIST_API_KEY=...`. Keep the key private.
2. **Set `PUID` and `AUDIO_GID`** to the user whose PipeWire/PulseAudio session runs on the host:
   `PUID=$(id -u)`, `AUDIO_GID=$(getent group audio | cut -d: -f3)`. The `spotify-data` directory must belong to
   that user (`chown -R "$PUID:$AUDIO_GID" spotify-data`). Existing installations: do **not** overwrite `.env`;
   add the new variables and set `AUDIO_DEVICE=pulse`/`ALSA_CARD=` instead of the old ALSA values.
3. **PipeWire or PulseAudio is required** by Soloist. Raspberry Pi OS Bookworm/Trixie ships it by default; check
   with `wpctl status` or `systemctl --user status pipewire`. If it is missing:
   `sudo apt install pipewire pipewire-pulse wireplumber`.
4. Start the stack and open the Spotify app on a phone/desktop in the same network. Select **MagicMirror** in the
   device picker and play. `docker compose logs -f spotify` shows the login state and errors.

The sound card is shared through PipeWire/PulseAudio: the `.env.example` sets `AUDIO_DEVICE=pulse` for ytcast and
leaves `ALSA_CARD` empty. VLC (radio) uses PulseAudio automatically when it is available. Only one source plays at a
time; the services pause/stop each other.

Soloist's built-in mDNS responder advertises one address as its `<device-id>.local` hostname. On hosts with Docker
that is often a bridge address (`172.x`), which phones cannot reach, so the container hides Docker/VPN interfaces
from Soloist (`hideifaces.c`, loaded with `LD_PRELOAD`). The advertised address is then the real LAN address. If the
device still does not appear, check `avahi-browse -rt _spotify-connect._tcp` on the host: the `address` must be the
mirror's LAN IP, not `172.x`.

### Spotify configuration

| Variable | Default | Description |
|---|---|---|
| `SOLOIST_API_KEY` | – | API key from the Spotify for Developers dashboard (required unless a key is already stored in `spotify-data`) |
| `SPOTIFY_NAME` | `MagicMirror` | Name in the Spotify device picker |
| `SPOTIFY_AUDIO_DEVICE` | default sink | Optional PipeWire node name/ID (`wpctl status`) |
| `SPOTIFY_INITIAL_VOLUME` | `60` | Initial Spotify stream volume (0–100) |
| `SPOTIFY_VERBOSE` | `0` | `1` for verbose Soloist logs (does not print the API key) |
| `PUID` | `1000` | Host user ID for the PipeWire/PulseAudio socket |
| `AUDIO_GID` | `29` | Host `audio` group ID |

The bridge listens on `0.0.0.0:3678` and provides the endpoints used by the module and magicmirror-control:
`GET /status`, `GET /player/volume`, `WS /events`, `POST /player/pause|resume|playpause|next|prev|stop|seek|volume|play`.
`curl http://127.0.0.1:3678/health` returns the connection state. The API has no authentication, like the old
go-librespot API — keep the mirror on a trusted network or firewall port 3678.

### Soloist build lifetime and updates

Official Soloist builds expire **90 days** after their build date. `entrypoint.sh` downloads the current build on the
first start and refreshes the binary when it is older than 30 days. If a build expires while the container is
running, it exits with code 10; Docker restarts it and the entrypoint fetches a newer build. This needs internet
access. The binary is stored in `spotify-data/bin` (not in the image), so no image rebuild is necessary.

### Troubleshooting Spotify

- **Device does not appear:** Soloist and the phone must be on the same LAN; VPNs, client isolation and mDNS blockers
  prevent discovery. Check `docker compose logs spotify` and the device name. The container uses host networking.
- **No sound:** check the default PipeWire sink with `wpctl status`/`wpctl inspect`, then set `SPOTIFY_AUDIO_DEVICE`
  to the node name/ID if needed. Also check the hardware mixer (the module's volume buttons use `amixer`).
- **`command requires authentication`:** a command arrived before the Spotify login completed; it disappears after
  the first successful login.
- **Switching from go-librespot:** `docker compose down` removes the old container; the old `./spotify` config/state
  directory is no longer used and can be deleted. The new runtime data lives in `./spotify-data`.

### YouTube / YouTube Music

- The sound card must be shared: with Soloist use `AUDIO_DEVICE=pulse` and let only one source play at a time (the
  services take care of that). Without PipeWire/PulseAudio, use `plughw:` ALSA devices instead.
- First YouTube title of a cast session takes a few seconds (yt-dlp), following titles are prefetched.
- When YouTube changes something, raise the yt-dlp version in `ytcast/Dockerfile` and rebuild:
  `docker compose build ytcast && docker compose up -d ytcast`.

The module talks to the services at `http://127.0.0.1:8099` (ytcast) and `http://127.0.0.1:3678` (Spotify bridge),
see the option `externalControl`.

## MagicMirror image with VLC (`magicmirror-docker/`)

For the [karsten13/MagicMirror docker setup](https://gitlab.com/khassel/magicmirror): packages installed with
`docker exec … apt-get install` are lost whenever the container is recreated. The `Dockerfile` builds an image
with VLC, alsa-utils (`amixer`) and an emoji font on top of `karsten13/magicmirror`, `compose.override.yaml`
makes the setup use it and passes the host PulseAudio/PipeWire socket (`PUID`, `AUDIO_GID`) into the container so
VLC plays through the same mixer as Spotify and YouTube. Copy the `Dockerfile` to a directory of your choice, set
it as `build.context` and run `docker compose up -d` in the MagicMirror run directory. Run compose as the mirror
user (not via `sudo`) so `$HOME/.config/pulse` is the right cookie.

---

### Kurzfassung (Deutsch)

- `audio/`: Spotify-Connect-Lautsprecher über **Spotify Soloist** (offizieller Headless-Client von Spotify) und
  YouTube-/YouTube-Music-Cast-Ziel „MagicMirror“. Ordner kopieren, `.env` aus `.env.example` anlegen
  (`MM_TOKEN`, `SOLOIST_API_KEY`, `PUID`, `AUDIO_GID`), `spotify-data` anlegen, `docker compose up -d --build`.
- **API-Key:** <https://developer.spotify.com/dashboard/soloist> (einmalig Premium nötig). Danach können auch
  Free-Konten verbinden. Der Key steht in `.env` (`chmod 600 .env`). Bei bestehenden Installationen `.env` nicht
  überschreiben, sondern die neuen Variablen ergänzen (`AUDIO_DEVICE=pulse`, `ALSA_CARD=`).
- **PipeWire/PulseAudio ist Voraussetzung** (auf Raspberry Pi OS normalerweise vorhanden). `PUID` = `id -u` des
  Nutzers, in dessen Sitzung PipeWire läuft; `AUDIO_GID` = GID der Gruppe `audio`.
- **Warum nicht go-librespot?** Spotify hat die alte Audio-Key-Schnittstelle für Drittanbieter-Clients abgeschaltet
  (`audio key error 0 1`). Soloist nutzt die offizielle Wiedergabe-Engine. Der Bridge-Dienst hält die alte
  go-librespot-HTTP-API auf Port 3678 am Leben, damit Modul und magicmirror-control unverändert funktionieren.
- **Build-Ablauf:** Soloist-Builds verfallen nach 90 Tagen. Der Container lädt beim Start die aktuelle Version und
  erneuert sie nach 30 Tagen automatisch; ein Image-Rebuild ist nicht nötig, Internetzugang schon.
- **Gerät erscheint nicht:** Der Container blendet Docker-/VPN-Interfaces für Soloists mDNS aus, damit nicht eine
  unerreichbare `172.x`-Adresse angekündigt wird. Prüfen mit `avahi-browse -rt _spotify-connect._tcp` (Adresse muss
  die LAN-IP des Spiegels sein).
- Hinweis: Spotify pausiert das Radio, sobald die Wiedergabe startet; Radio/YouTube pausieren Spotify. Das Modul
  zeigt Titel, Interpret und Cover im Karussell.
- `magicmirror-docker/`: MagicMirror-Image mit VLC, alsa-utils und Emoji-Schrift für das karsten13-Docker-Setup,
  damit nachinstallierte Pakete beim Neuerstellen des Containers nicht verloren gehen.
