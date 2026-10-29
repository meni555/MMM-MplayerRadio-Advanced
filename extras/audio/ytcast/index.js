// ytcast – "Cast to MagicMirror" for YouTube / YouTube Music.
//
// Design (deliberately small):
//  - yt-cast-receiver handles DIAL discovery and the cast protocol (Lounge API).
//  - Stream URLs come from a long-running yt-dlp process (resolver.py) instead of youtubei.js: more robust when
//    YouTube changes things, no Python start per title, cache and prefetching of the next title.
//  - Playback uses ONE long-running mpv (JSON IPC) instead of a process per title.
//  - Coordination: YouTube starting stops the radio (MagicMirror) and pauses Spotify; Spotify starting pauses YouTube.
//  - Small status API (port 8099) for magicmirror-control and MMM-MplayerRadio-Advanced.
import YouTubeCastReceiver, { Player, Constants, DataStore } from 'yt-cast-receiver';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, rename } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';

const env = (k, d = '') => process.env[k] ?? d;
const MM_URL = env('MM_URL', 'http://127.0.0.1:8080').replace(/\/$/, '');
const MM_TOKEN = env('MM_TOKEN');
const SPOTIFY_API = env('SPOTIFY_API', 'http://127.0.0.1:3678').replace(/\/$/, '');
const AUDIO_DEVICE = env('AUDIO_DEVICE', 'alsa/plughw:CARD=Headphones,DEV=0');
// ALSA card name for the "is the sound card free?" check (/proc/asound/<card>/pcm0p/sub0/status)
const ALSA_CARD = env('ALSA_CARD', 'Headphones');
const NAME = env('YTCAST_NAME', 'MagicMirror');
const DIAL_PORT = Number(env('DIAL_PORT', '8098'));
// Bind to the real LAN interfaces only, otherwise DIAL also announces Docker bridge IPs the phone cannot reach
const DIAL_IFACES = env('DIAL_INTERFACES', 'wlan0,eth0').split(',').map((x) => x.trim()).filter(Boolean);
const API_PORT = Number(env('API_PORT', '8099'));
const MPV_SOCK = '/tmp/mpv.sock';
// Key in the header: as a URL parameter MMM-Remote-Control would copy it into the payload of every notification
const mmAuth = () => (MM_TOKEN ? { Authorization: `Bearer ${MM_TOKEN}` } : {});
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- Resolver (yt-dlp)
class Resolver {
  #proc; #seq = 0; #pending = new Map(); #inflight = new Map();
  constructor() { this.#start(); }
  #start() {
    this.#proc = spawn('python3', ['-u', '/app/resolver.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
    createInterface({ input: this.#proc.stdout }).on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      const p = this.#pending.get(msg.id); if (!p) return;
      this.#pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg);
    });
    this.#proc.on('exit', (code) => {
      log('[resolver] exited with', code, '- restarting');
      for (const p of this.#pending.values()) p.reject(new Error('resolver restarted'));
      this.#pending.clear(); this.#inflight.clear();
      setTimeout(() => this.#start(), 1000);
    });
  }
  // concurrent requests for the same ID share one result (prefetch + play)
  get(videoId) {
    if (this.#inflight.has(videoId)) return this.#inflight.get(videoId);
    const id = ++this.#seq;
    const pr = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#proc.stdin.write(JSON.stringify({ id, video: videoId }) + '\n');
    }).finally(() => this.#inflight.delete(videoId));
    this.#inflight.set(videoId, pr);
    return pr;
  }
  prefetch(videoId) { if (videoId) this.get(videoId).catch(() => {}); }
}

// ---------------------------------------------------------------- mpv (JSON-IPC)
class Mpv {
  #sock = null; #seq = 0; #pending = new Map(); #buf = ''; #listeners = new Set();
  props = { pause: false, 'time-pos': 0, duration: 0, volume: 100, mute: false, 'idle-active': true };
  async start() {
    spawn('mpv', ['--idle=yes', '--no-video', '--no-terminal', '--really-quiet', `--input-ipc-server=${MPV_SOCK}`,
      `--audio-device=${AUDIO_DEVICE}`, '--volume=100', '--volume-max=100', '--cache=yes', '--demuxer-max-bytes=8MiB',
      '--network-timeout=15', '--keep-open=no'], { stdio: 'inherit' })
      .on('exit', (c) => { log('[mpv] exited with', c, '- restarting the service'); process.exit(1); });
    for (let i = 0; i < 50 && !this.#sock; i++) {
      try { this.#sock = await this.#connect(); } catch { await sleep(100); }
    }
    if (!this.#sock) throw new Error('mpv IPC not reachable');
    for (const [i, p] of Object.keys(this.props).entries()) this.cmd(['observe_property', i + 1, p]);
    const ver = String(await this.cmd(['get_property', 'mpv-version']).catch(() => 'mpv 0.35'));
    const [maj, min] = (ver.match(/(\d+)\.(\d+)/) || [0, 0, 35]).slice(1).map(Number);
    this.newLoadfile = maj > 0 || min >= 38;
    log('[mpv]', ver, this.newLoadfile ? '(loadfile with index)' : '(old loadfile)');
  }
  loadfile(url, opts) {
    return this.cmd(this.newLoadfile ? ['loadfile', url, 'replace', -1, opts] : ['loadfile', url, 'replace', opts]);
  }
  #connect() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(MPV_SOCK, () => resolve(s)).on('error', reject);
      s.on('data', (d) => {
        this.#buf += d; let i;
        while ((i = this.#buf.indexOf('\n')) >= 0) {
          const line = this.#buf.slice(0, i); this.#buf = this.#buf.slice(i + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m.request_id && this.#pending.has(m.request_id)) {
            const p = this.#pending.get(m.request_id); this.#pending.delete(m.request_id);
            m.error === 'success' ? p.resolve(m.data) : p.reject(new Error(m.error));
          } else if (m.event === 'property-change') { this.props[m.name] = m.data; }
          else if (m.event) { for (const l of this.#listeners) l(m); }
        }
      });
    });
  }
  cmd(command) {
    const request_id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(request_id, { resolve, reject });
      this.#sock.write(JSON.stringify({ command, request_id }) + '\n');
      setTimeout(() => { if (this.#pending.delete(request_id)) reject(new Error('mpv timeout')); }, 10000);
    });
  }
  onEvent(fn) { this.#listeners.add(fn); }
  set(prop, value) { return this.cmd(['set_property', prop, value]); }
}

// ---------------------------------------------------------------- Coordination with radio + Spotify
const coord = {
  async stopRadio() {
    try {
      await fetch(`${MM_URL}/api/notification/RADIO_STOP`, { headers: mmAuth(), signal: AbortSignal.timeout(4000) });
    } catch (e) { log('[coord] stopping the radio failed:', e.message); }
  },
  async pauseSpotify() {
    try { await fetch(`${SPOTIFY_API}/player/pause`, { method: 'POST', signal: AbortSignal.timeout(4000) }); }
    catch (e) { log('[coord] pausing Spotify failed:', e.message); }
  },
  // waits until the sound card is free (VLC/Spotify open it exclusively)
  async waitForSoundcard(maxMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try {
        const st = await readFile(`/host-asound/${ALSA_CARD}/pcm0p/sub0/status`, 'utf8');
        if (st.trim() === 'closed') return true;
      } catch { return true; }
      await sleep(150);
    }
    log('[coord] sound card still busy after', maxMs, 'ms - trying anyway');
    return false;
  },
  // ownsDevice: mpv holds the sound card itself (paused / next title) -> do not wait for "free"
  async claim(ownsDevice = false) {
    await Promise.all([this.stopRadio(), this.pauseSpotify()]);
    if (!ownsDevice) await this.waitForSoundcard();
  },
};

// ---------------------------------------------------------------- Display on the mirror (MMM-MplayerRadio-Advanced)
// Sends RADIO_EXTERNAL {active, source, title, artist, cover, playing} to the radio module.
const mirror = {
  last: {}, // last state sent per source (avoid duplicate notifications)
  async show(source, info) {
    const payload = info ? { active: true, source, playing: !!info.playing, title: info.title || '', artist: info.artist || '', cover: info.cover || '' }
                         : { active: false, source };
    const key = JSON.stringify(payload);
    if (this.last[source] === key) return;
    this.last[source] = key;
    try {
      await fetch(`${MM_URL}/api/notification/RADIO_EXTERNAL`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mmAuth() },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(4000) });
    } catch (e) { log('[mirror] display update failed:', e.message); }
  },
};

// ---------------------------------------------------------------- Player
class MpvPlayer extends Player {
  #mpv; #resolver; #current = null; #loading = 0;
  constructor(mpv, resolver) {
    super(); this.#mpv = mpv; this.#resolver = resolver;
    mpv.onEvent((ev) => {
      if (ev.event !== 'end-file' || !this.#current) return;
      if (ev.reason === 'eof') { this.#trackEnded('track ended'); }
      else if (ev.reason === 'error') { this.#trackEnded(`playback error (${ev.file_error || '?'})`); }
    });
  }
  get nowPlaying() { return this.#current; }
  async #trackEnded(why) {
    log('[player]', why, '->', this.#current?.id);
    this.#current = null;
    await this.notifyExternalStateChange(Constants.PLAYER_STATUSES.STOPPED);
    await this.next(); // next title from the queue or autoplay
  }
  // Resolve the next AND the autoplay title while playing (yt-dlp needs ~7 s for a new title, the cache is instant)
  // -> only the first title of a cast session has to wait.
  #prefetchNext() {
    const q = this.queue.getState();
    for (const v of new Set([q.next?.id, q.autoplay?.id])) this.#resolver.prefetch(v);
  }
  watchQueue() {
    for (const ev of ['playlistUpdated', 'playlistAdded', 'playlistSet', 'videoAdded', 'videoSelected', 'autoplayModeChange']) {
      this.queue.on(ev, () => { if (this.#current) this.#prefetchNext(); });
    }
  }
  async doPlay(video, position) {
    const ticket = ++this.#loading;
    const t0 = Date.now();
    log('[player] play', video.id, 'from', position, 's');
    let info;
    try {
      [info] = await Promise.all([this.#resolver.get(video.id), coord.claim(!this.#mpv.props['idle-active'])]);
    } catch (e) {
      log('[player] cannot resolve stream:', video.id, e.message);
      throw e;
    }
    if (ticket !== this.#loading) return false; // another title was requested meanwhile
    this.#current = { id: video.id, ...info, url: undefined };
    const opts = position > 0 ? `start=${Math.floor(position)},` : '';
    await this.#mpv.loadfile(info.url, `${opts}force-media-title=${info.title.replace(/,/g, ' ')}`);
    await this.#mpv.set('pause', false);
    log(`[player] playing: ${info.artist ? info.artist + ' - ' : ''}${info.title} (ready after ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    this.#prefetchNext();
    return true;
  }
  async doPause() { await this.#mpv.set('pause', true); return true; }
  async doResume() { await coord.claim(true); await this.#mpv.set('pause', false); return true; }
  async doStop() { this.#loading++; this.#current = null; await this.#mpv.cmd(['stop']); return true; }
  async doSeek(position) { await this.#mpv.cmd(['seek', position, 'absolute']); return true; }
  async doSetVolume(v) { await this.#mpv.set('volume', v.level); await this.#mpv.set('mute', v.muted); return true; }
  async doGetVolume() { return { level: Math.round(this.#mpv.props.volume ?? 100), muted: !!this.#mpv.props.mute }; }
  async doGetPosition() { return Number(this.#mpv.props['time-pos']) || 0; }
  async doGetDuration() { return Number(this.#mpv.props.duration) || this.#current?.duration || 0; }
}

// ---------------------------------------------------------------- Pairing data kept under /data
class FileDataStore extends DataStore {
  #file = '/data/store.json'; #data = null;
  async #load() { if (!this.#data) { try { this.#data = JSON.parse(await readFile(this.#file, 'utf8')); } catch { this.#data = {}; } } return this.#data; }
  async set(key, value) { const d = await this.#load(); d[key] = value; await writeFile(this.#file + '.tmp', JSON.stringify(d)); await rename(this.#file + '.tmp', this.#file); }
  async get(key) { return (await this.#load())[key] ?? null; }
  async clear() { this.#data = {}; await writeFile(this.#file, '{}'); }
}

// ---------------------------------------------------------------- Start
const mpv = new Mpv(); await mpv.start();
const resolver = new Resolver();
const player = new MpvPlayer(mpv, resolver);
const receiver = new YouTubeCastReceiver(player, {
  device: { name: NAME, screenName: NAME, brand: 'MagicMirror', model: 'MagicMirror' },
  dial: { port: DIAL_PORT, bindToInterfaces: DIAL_IFACES },
  app: { mutePolicy: Constants.MUTE_POLICIES.PRESERVE_VOLUME_LEVEL },
  dataStore: new FileDataStore(),
  logLevel: Constants.LOG_LEVELS.INFO,
});
receiver.on('senderConnect', (s) => log('[cast] connected:', s.name || s.device?.name || 'sender'));
receiver.on('senderDisconnect', (s, implicit) => log('[cast] disconnected:', s.name || 'sender', implicit ? '(network lost)' : ''));
receiver.on('error', (err) => log('[cast] error:', err?.message || err));
// On a fatal error (e.g. LoungeScreenDisconnected) yt-cast-receiver stops itself including the DIAL server,
// the mirror then disappears as a cast target. Exit and let Docker restart the service.
receiver.on('terminate', (err) => {
  log('[cast] receiver terminated:', err?.message || err, '- restarting the service');
  process.exit(1);
});
await receiver.start();
player.watchQueue();
// watchdog in case the receiver stops without 'terminate'
let notRunning = 0;
setInterval(() => {
  notRunning = receiver.status === 'running' ? 0 : notRunning + 1;
  if (notRunning >= 2) {
    log('[cast] receiver not running (status', receiver.status + ') - restarting the service');
    process.exit(1);
  }
}, 60000).unref();
player.on('state', ({ current }) => {
  const np = player.nowPlaying; const st = current?.status;
  if (np && (st === Constants.PLAYER_STATUSES.PLAYING || st === Constants.PLAYER_STATUSES.PAUSED || st === Constants.PLAYER_STATUSES.LOADING)) {
    mirror.show('youtube', { title: np.title, artist: np.artist, cover: np.thumbnail, playing: st !== Constants.PLAYER_STATUSES.PAUSED });
  } else if (st === Constants.PLAYER_STATUSES.STOPPED || st === Constants.PLAYER_STATUSES.IDLE) {
    mirror.show('youtube', null);
  }
});
log(`[ytcast] ready as "${NAME}" (DIAL :${DIAL_PORT}, API :${API_PORT}, output ${AUDIO_DEVICE})`);

// Spotify events: when Spotify starts, pause YouTube and stop the radio; show it on the mirror
const spotify = { track: null, playing: false };
(function watchSpotify() {
  let ws;
  try { ws = new WebSocket(SPOTIFY_API.replace(/^http/, 'ws') + '/events'); } catch { return setTimeout(watchSpotify, 5000); }
  ws.onmessage = async (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    const d = ev.data || {};
    if ((ev.type === 'will_play' || ev.type === 'playing') && player.status === Constants.PLAYER_STATUSES.PLAYING) {
      log('[coord] Spotify starts - pausing YouTube'); await player.pause().catch(() => {});
    }
    if (ev.type === 'metadata') spotify.track = { title: d.name, artist: (d.artist_names || []).join(', '), cover: d.album_cover_url };
    if (ev.type === 'playing') { spotify.playing = true; await coord.stopRadio(); }
    if (ev.type === 'paused') spotify.playing = false;
    if (['metadata', 'playing', 'paused'].includes(ev.type) && spotify.track) mirror.show('spotify', { ...spotify.track, playing: spotify.playing });
    if (['stopped', 'inactive'].includes(ev.type)) { spotify.track = null; spotify.playing = false; mirror.show('spotify', null); }
  };
  ws.onclose = () => setTimeout(watchSpotify, 5000);
  ws.onerror = () => {};
})();

// status API for the remote control
const STATUS = { [-1]: 'idle', 1: 'playing', 2: 'paused', 3: 'loading', 4: 'stopped' };
http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  try {
    if (req.method === 'GET' && req.url === '/status') {
      const np = player.nowPlaying;
      return send(200, { state: STATUS[player.status] || 'idle', id: np?.id || null, title: np?.title || null, artist: np?.artist || null,
        thumbnail: np?.thumbnail || null, position: await player.getPosition(), duration: await player.getDuration() });
    }
    if (req.method === 'POST' && req.url === '/pause') { await player.pause(); return send(200, { ok: true }); }
    if (req.method === 'POST' && req.url === '/stop') { await player.stop(); return send(200, { ok: true }); }
    if (req.method === 'POST' && req.url === '/resume') { await player.resume(); return send(200, { ok: true }); }
    if (req.method === 'POST' && req.url === '/next') { await player.next(); return send(200, { ok: true }); }
    if (req.method === 'POST' && req.url === '/previous') { await player.previous(); return send(200, { ok: true }); }
    send(404, { error: 'not found' });
  } catch (e) { send(500, { error: e.message }); }
}).listen(API_PORT, '0.0.0.0');

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { await receiver.stop().catch(() => {}); process.exit(0); });
