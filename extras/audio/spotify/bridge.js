// spotify-bridge – HTTP adapter between MMM-MplayerRadio-Advanced / magicmirror-control
// and the local WebSocket API of Spotify Soloist (https://developer.spotify.com/documentation/soloist).
//
// Soloist is Spotify's official headless Connect client. It replaces go-librespot, whose legacy
// audio-key path no longer works for many accounts (librespot issue #1649 / go-librespot #279).
//
// This bridge keeps the old go-librespot HTTP API (port 3678) alive, so the radio module and
// magicmirror-control need no changes:
//   GET  /status                 go-librespot-compatible player status (204 when nothing is active)
//   WS   /events                 go-librespot-compatible events (used by ytcast)
//   POST /player/pause|resume|playpause|next|prev|stop|seek|volume|play
// It also forwards RADIO_EXTERNAL notifications to MMM-Remote-Control so the carousel shows
// cover, title and artist, and stops the radio when Spotify starts.
import http from 'node:http'
import WebSocket, { WebSocketServer } from 'ws'

const env = (key, fallback = '') => process.env[key] ?? fallback
const WS_URL = env('SOLOIST_WS', 'ws://127.0.0.1:9090')
const HTTP_BIND = env('HTTP_BIND', '0.0.0.0')
const HTTP_PORT = Number(env('HTTP_PORT', '3678'))
const MM_URL = env('MM_URL', 'http://127.0.0.1:8080').replace(/\/$/, '')
const MM_TOKEN = env('MM_TOKEN')
const DEVICE_NAME = env('SOLOIST_DEVICE_NAME', 'MagicMirror')
const RESEND_MS = Number(env('RADIO_EXTERNAL_RESEND_MS', '60000'))

const log = (...args) => console.log(new Date().toISOString(), ...args)
const mmAuth = () => (MM_TOKEN ? { Authorization: `Bearer ${MM_TOKEN}` } : {})

// ---------------------------------------------------------------- Soloist state

let socket = null
let connected = false
let reconnectDelay = 1000
let auth = { logged_in: false, is_active: false, device_name: DEVICE_NAME }
let status = 'idle'
let item = null
let context = null
let position = { position_ms: 0, timestamp_ms: Date.now(), speed: 0 }
let volume = 0
let options = { shuffle: false, repeat: 'off' }

const entityName = (entity) => entity?.decorations?.identity?.name || ''
const creators = (entity) => (entity?.decorations?.creators || [])
  .map((creator) => entityName(creator.entity || creator))
  .filter(Boolean)

function coverUrl(entity) {
  const covers = entity?.decorations?.visual_identity?.cover
  if (!Array.isArray(covers) || covers.length === 0) return ''
  for (const size of ['xlarge', 'large', 'default', 'small']) {
    const match = covers.find((cover) => cover.size === size && cover.url)
    if (match) return match.url
  }
  return covers.find((cover) => cover.url)?.url || ''
}

const durationMs = () => item?.decorations?.playback?.duration_ms || 0
const isActive = () => !!(auth.logged_in && auth.is_active && item && status !== 'idle')
const isPlaying = () => status === 'playing' || status === 'buffering'

function currentPosition() {
  const duration = durationMs()
  let value = Number(position.position_ms) || 0
  if (isPlaying() && Number(position.speed) > 0) {
    value += (Date.now() - Number(position.timestamp_ms || Date.now())) * Number(position.speed)
  }
  value = Math.max(0, Math.round(value))
  return duration > 0 ? Math.min(value, duration) : value
}

function resetState(keepDevice = true) {
  auth = { logged_in: false, is_active: false, device_name: keepDevice ? auth.device_name : DEVICE_NAME }
  status = 'idle'
  item = null
  context = null
  position = { position_ms: 0, timestamp_ms: Date.now(), speed: 0 }
  options = { shuffle: false, repeat: 'off' }
}

function applyPlaybackState(message) {
  status = message.status || 'idle'
  item = message.item || null
  context = message.context || null
  if (typeof message.is_active === 'boolean') auth.is_active = message.is_active
  if (message.position) position = message.position
  if (typeof message.volume === 'number') volume = message.volume
  if (message.options) options = message.options
  scheduleNotify()
}

function handleMessage(message) {
  switch (message.type) {
    case 'auth_state':
      auth = {
        logged_in: !!message.logged_in,
        is_active: !!message.is_active,
        device_name: message.device_name || auth.device_name || DEVICE_NAME,
      }
      if (!auth.logged_in) resetState()
      scheduleNotify()
      break
    case 'playback_state':
      applyPlaybackState(message)
      break
    case 'track_changed':
      item = message.item || null
      scheduleNotify()
      break
    case 'playback_changed':
      status = message.status || status
      scheduleNotify()
      break
    case 'position_sync':
      if (message.position) position = message.position
      break
    case 'volume_changed':
      if (typeof message.volume === 'number') volume = message.volume
      break
    case 'device_changed':
      if (typeof message.is_active === 'boolean') auth.is_active = message.is_active
      if (message.device_name) auth.device_name = message.device_name
      scheduleNotify()
      break
    case 'context_changed':
      context = message.context || null
      break
    case 'options_changed':
      if (message.options) options = message.options
      break
    case 'queue_changed':
      break
    case 'error':
      log('[soloist] error:', message.message || JSON.stringify(message))
      break
  }
}

function send(command) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify({ type: 'command', ...command }))
  return true
}

// ---------------------------------------------------------------- go-librespot /events compatibility
// ytcast watches this WebSocket to pause YouTube and to stop the radio when Spotify starts.
// The event shapes match go-librespot's API.md, so ytcast keeps working unchanged.
const eventServer = new WebSocketServer({ noServer: true })
const eventClients = new Set()
let lastEventItem = null
let lastEventStatus = 'idle'
let lastEventActive = null

function metadataEvent() {
  return {
    uri: item?.uri || '',
    context_uri: context?.uri || '',
    name: entityName(item),
    artist_names: creators(item),
    album_name: entityName(item?.decorations?.parent?.entity),
    album_cover_url: coverUrl(item) || null,
    position: currentPosition(),
    duration: durationMs(),
    format: '',
    codec: '',
    bitrate: null,
    sample_rate: 0,
    bit_depth: null,
  }
}

function emit(type, data = {}) {
  const message = JSON.stringify({ type, data })
  for (const client of eventClients) {
    if (client.readyState !== WebSocket.OPEN) continue
    try {
      client.send(message)
    } catch {
      eventClients.delete(client)
    }
  }
}

function publishEvents() {
  const active = isActive()
  const activeChanged = active !== lastEventActive

  if (activeChanged) {
    if (active) {
      if (item) emit('metadata', metadataEvent())
      lastEventItem = item?.uri || null
    } else {
      emit('inactive', {})
      lastEventItem = null
    }
    lastEventActive = active
    lastEventStatus = 'idle'
  } else if (active && item && (item.uri || null) !== lastEventItem) {
    emit('metadata', metadataEvent())
    lastEventItem = item?.uri || null
  }

  if (active && status !== lastEventStatus) {
    if (status === 'playing' || status === 'buffering') {
      emit('playing', { uri: item?.uri || '', context_uri: context?.uri || '' })
    } else if (status === 'paused') {
      emit('paused', { uri: item?.uri || '', context_uri: context?.uri || '' })
    } else if (status === 'idle') {
      emit('stopped', {})
    }
    lastEventStatus = status
  } else if (!active) {
    lastEventStatus = 'idle'
  }
}

function sendSnapshot(client) {
  if (!isActive()) {
    client.send(JSON.stringify({ type: 'inactive', data: {} }))
    return
  }
  client.send(JSON.stringify({ type: 'metadata', data: metadataEvent() }))
  client.send(JSON.stringify({
    type: isPlaying() ? 'playing' : 'paused',
    data: { uri: item?.uri || '', context_uri: context?.uri || '' },
  }))
}

eventServer.on('connection', (client) => {
  eventClients.add(client)
  client.on('close', () => eventClients.delete(client))
  client.on('error', () => eventClients.delete(client))
  sendSnapshot(client)
})

// ---------------------------------------------------------------- radio module (RADIO_EXTERNAL)

let pendingNotify = null
let notifyTimer = null
let lastSent = ''
let lastPlaying = false

function externalPayload() {
  if (!isActive()) return { active: false, source: 'spotify' }
  return {
    active: true,
    source: 'spotify',
    playing: isPlaying(),
    title: entityName(item),
    artist: creators(item).join(', '),
    cover: coverUrl(item),
  }
}

async function postJson(url, body) {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mmAuth() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) log('[mirror] notification failed:', response.status)
  } catch (error) {
    log('[mirror] notification failed:', error.message)
  }
}

async function postNotification(notification) {
  try {
    await fetch(`${MM_URL}/api/notification/${notification}`, {
      headers: mmAuth(),
      signal: AbortSignal.timeout(4000),
    })
  } catch (error) {
    log('[mirror] stopping the radio failed:', error.message)
  }
}

function scheduleNotify(delay = 0) {
  publishEvents()
  pendingNotify = externalPayload()
  clearTimeout(notifyTimer)
  notifyTimer = setTimeout(flushNotify, delay)
}

function flushNotify() {
  const payload = pendingNotify
  if (!payload) return
  const key = JSON.stringify(payload)

  // A newly started Spotify has priority: stop the radio before taking over the carousel.
  // Do it only on the transition so a long playlist does not stop the radio every track.
  if (payload.active && payload.playing && !lastPlaying) {
    postNotification('RADIO_STOP')
  }
  lastPlaying = !!(payload.active && payload.playing)

  if (key === lastSent) return
  lastSent = key
  postJson(`${MM_URL}/api/notification/RADIO_EXTERNAL`, payload)
}

// MagicMirror may be restarted while Spotify keeps playing: repeat the current state so a
// freshly loaded module picks it up. This bypasses the duplicate filter on purpose.
setInterval(() => {
  const payload = externalPayload()
  if (payload.active) postJson(`${MM_URL}/api/notification/RADIO_EXTERNAL`, payload)
}, RESEND_MS).unref()

// ---------------------------------------------------------------- WebSocket client

function connect() {
  socket = new WebSocket(WS_URL, { handshakeTimeout: 5000 })
  socket.on('open', () => {
    connected = true
    reconnectDelay = 1000
    log('[soloist] connected to', WS_URL)
    // Soloist sends auth_state (and playback_state when logged in) automatically on connect.
  })
  socket.on('message', (data) => {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      return
    }
    handleMessage(message)
  })
  socket.on('error', (error) => log('[soloist] websocket error:', error.message))
  socket.on('close', () => {
    const wasConnected = connected
    connected = false
    socket = null
    resetState()
    scheduleNotify()
    if (wasConnected) log('[soloist] disconnected, reconnecting in', reconnectDelay, 'ms')
    setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30000)
  })
}

// ---------------------------------------------------------------- HTTP API (go-librespot compatible)

function statusJson() {
  if (!isActive()) return null
  const duration = durationMs()
  return {
    username: 'spotify',
    device_id: '',
    device_type: 'speaker',
    device_name: auth.device_name || DEVICE_NAME,
    play_origin: null,
    play_origin_device_id: null,
    context_uri: context?.uri || null,
    context_name: entityName(context) || null,
    stopped: false,
    paused: !isPlaying(),
    buffering: status === 'buffering',
    volume: Math.round(volume),
    volume_steps: 100,
    repeat_context: options.repeat === 'context',
    repeat_track: options.repeat === 'track',
    shuffle_context: !!options.shuffle,
    track: {
      uri: item.uri || '',
      name: entityName(item),
      artist_names: creators(item),
      artist_uris: (item.decorations?.creators || [])
        .map((creator) => (creator.entity || creator).uri || ''),
      album_name: entityName(item.decorations?.parent?.entity),
      album_uri: item.decorations?.parent?.entity?.uri || '',
      album_cover_url: coverUrl(item) || null,
      position: currentPosition(),
      duration,
      release_date: '',
      track_number: 0,
      disc_number: 0,
      format: '',
      codec: '',
      bitrate: null,
      sample_rate: 0,
      bit_depth: null,
    },
    next_track: null,
  }
}

function json(response, statusCode, body) {
  const text = JSON.stringify(body)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  response.end(text)
}

function readJson(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) request.destroy()
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve({})
      }
    })
    request.on('error', () => resolve({}))
  })
}

const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const path = (request.url || '/').split('?')[0].replace(/\/+$/, '') || '/'

  if (request.method === 'GET' && path === '/') {
    return json(response, 200, {
      alive: true,
      authenticated: auth.logged_in,
      connected,
      device_name: auth.device_name || DEVICE_NAME,
      soloist_ws: WS_URL,
    })
  }
  if (request.method === 'GET' && path === '/health') {
    return json(response, 200, { ok: connected, authenticated: auth.logged_in, active: isActive() })
  }
  if (request.method === 'GET' && path === '/status') {
    const body = statusJson()
    if (!body) {
      response.writeHead(204)
      response.end()
      return
    }
    return json(response, 200, body)
  }
  if (request.method === 'GET' && path === '/player/volume') {
    return json(response, 200, { volume: Math.round(volume), max: 100 })
  }
  if (request.method === 'GET' && path === '/player/queue') {
    return json(response, 200, { previous: [], upcoming: [] })
  }
  if (request.method === 'GET' && path === '/connect/devices') {
    return json(response, 200, [])
  }

  if (request.method === 'POST') {
    const body = await readJson(request)
    let command = null
    switch (path) {
      case '/player/pause':
      case '/player/stop':
        command = { command: 'pause' }
        break
      case '/player/resume':
        send({ command: 'activate' })
        command = { command: 'play' }
        break
      case '/player/playpause':
        if (isPlaying()) {
          command = { command: 'pause' }
        } else {
          send({ command: 'activate' })
          command = { command: 'play' }
        }
        break
      case '/player/play':
        send({ command: 'activate' })
        command = body.uri ? { command: 'play', uri: body.uri } : { command: 'play' }
        break
      case '/player/next':
        command = { command: 'skip_next' }
        break
      case '/player/prev':
        command = { command: 'skip_prev' }
        break
      case '/player/seek': {
        const positionMs = Number(body.position_ms ?? body.position ?? 0)
        command = { command: 'seek', position_ms: Math.max(0, positionMs) }
        break
      }
      case '/player/volume': {
        const value = Number(body.volume ?? body.value ?? 0)
        command = { command: 'set_volume', volume: Math.max(0, Math.min(100, value)) }
        break
      }
      case '/player/output':
        return json(response, 200, { ok: true })
      default:
        return json(response, 404, { error: 'unknown endpoint' })
    }

    if (!send(command)) {
      return json(response, 503, { error: 'Spotify Soloist is not connected' })
    }
    return json(response, 200, { ok: true })
  }

  return json(response, 404, { error: 'unknown endpoint' })
})

server.on('upgrade', (request, socket, head) => {
  const path = (request.url || '/').split('?')[0]
  if (path !== '/events') {
    socket.destroy()
    return
  }
  eventServer.handleUpgrade(request, socket, head, (client) => eventServer.emit('connection', client))
})

server.listen(HTTP_PORT, HTTP_BIND, () => {
  log(`[bridge] listening on ${HTTP_BIND}:${HTTP_PORT}, Soloist at ${WS_URL}`)
})

connect()
