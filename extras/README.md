# Extras for MMM-MplayerRadio-Advanced

🇩🇪 Kurzfassung auf Deutsch am Ende.

## Audio services (`audio/`)

Two services that run next to MagicMirror on the same device and use the same sound card as the radio:

| Service | What | Ports (host network) |
|---|---|---|
| `spotify` | [go-librespot](https://github.com/devgianlu/go-librespot): Spotify Connect speaker "MagicMirror" (Spotify Premium needed) | 3678 (API), 37377 (zeroconf) |
| `ytcast` | "Cast to" target for YouTube / YouTube Music ([yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver) + mpv + yt-dlp) | 8098 (DIAL), 8099 (status API) |

Both tell the radio module what is playing (`RADIO_EXTERNAL` via MMM-Remote-Control) and coordinate:
YouTube stops the radio and pauses Spotify, Spotify pauses YouTube and stops the radio, the radio stops both.

> **Spotify limitation:** for some accounts and playback contexts (mostly playlists) Spotify refuses the audio key
> to third-party Connect clients. The log then shows `failed retrieving aes key with code 1` and the player skips
> track after track. This is decided server-side by Spotify and cannot be fixed in this project, see
> [go-librespot #279](https://github.com/devgianlu/go-librespot/issues/279) and
> [#317](https://github.com/devgianlu/go-librespot/issues/317). Workarounds: play a single track/album instead of a
> playlist, try another account, or use YouTube Music.


### Setup

```bash
cp -r extras/audio ~/mm-audio && cd ~/mm-audio
cp .env.example .env            # MM_TOKEN = apiKey of MMM-Remote-Control, sound card, network interfaces
nano spotify/config.yml         # audio_device / mixer_device (aplay -l), zeroconf interface
docker compose up -d --build
```

- The sound card must be shared: use `plughw:` devices and let only one source play at a time (the services
  take care of that). On a Raspberry Pi the built-in output is usually `Headphones`.
- `group_add: "29"` in `compose.yaml` is the `audio` group of the host (`getent group audio`).
- First YouTube title of a cast session takes a few seconds (yt-dlp), following titles are prefetched.
- When YouTube changes something, raise the yt-dlp version in `ytcast/Dockerfile` and rebuild:
  `docker compose build ytcast && docker compose up -d ytcast`.

The module talks to the services at `http://127.0.0.1:8099` (ytcast) and `http://127.0.0.1:3678` (go-librespot),
see the option `externalControl`.

## MagicMirror image with VLC (`magicmirror-docker/`)

For the [karsten13/MagicMirror docker setup](https://gitlab.com/khassel/magicmirror): packages installed with
`docker exec … apt-get install` are lost whenever the container is recreated. The `Dockerfile` builds an image
with VLC, alsa-utils (`amixer`) and an emoji font on top of `karsten13/magicmirror`, `compose.override.yaml`
makes the setup use it. Copy the `Dockerfile` to a directory of your choice, set it as `build.context` and run
`docker compose up -d` in the MagicMirror run directory.

---

### Kurzfassung (Deutsch)

- `audio/`: Spotify-Connect-Lautsprecher und YouTube-/YouTube-Music-Cast-Ziel „MagicMirror“. Ordner kopieren,
  `.env` aus `.env.example` anlegen (`MM_TOKEN` = apiKey von MMM-Remote-Control, Soundkarte, Netzwerk),
  Soundkarte in `spotify/config.yml` eintragen, `docker compose up -d --build`.
- Hinweis Spotify: Bei manchen Konten/Kontexten (meist Playlists) verweigert Spotify Drittanbieter-Clients den
  Audio-Schlüssel (`failed retrieving aes key with code 1`), der Player springt dann Titel für Titel weiter. Das
  entscheidet Spotify serverseitig (go-librespot #279/#317). Abhilfe: einzelnen Titel/Album statt Playlist, anderes
  Konto oder YouTube Music.
- `magicmirror-docker/`: MagicMirror-Image mit VLC, alsa-utils und Emoji-Schrift für das karsten13-Docker-Setup,
  damit nachinstallierte Pakete beim Neuerstellen des Containers nicht verloren gehen.
