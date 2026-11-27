// End-to-end test for the Soloist bridge without Spotify or a sound card:
// a fake Soloist WebSocket server feeds playback events, a fake MMM-Remote-Control
// records RADIO_EXTERNAL notifications, and the bridge is exercised over HTTP.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
}

async function waitFor(check, timeout = 5000, label = 'condition') {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
  if (response.status === 204) return { status: 204, body: null }
  return { status: response.status, body: await response.json() }
}

test('bridge translates Soloist events and controls both APIs', async (t) => {
  const notifications = []
  const mmServer = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    notifications.push({ url: request.url, body: body ? JSON.parse(body) : null })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end('{}')
  })
  mmServer.listen(0, '127.0.0.1')
  await once(mmServer, 'listening')
  const mmPort = mmServer.address().port

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  const wsPort = wss.address().port

  let client = null
  const commands = []
  wss.on('connection', (socket) => {
    client = socket
    socket.on('message', (data) => commands.push(JSON.parse(data.toString())))
  })

  const httpPort = await freePort()
  const bridge = spawn(process.execPath, [path.join(here, 'bridge.js')], {
    env: {
      ...process.env,
      SOLOIST_WS: `ws://127.0.0.1:${wsPort}`,
      HTTP_BIND: '127.0.0.1',
      HTTP_PORT: String(httpPort),
      MM_URL: `http://127.0.0.1:${mmPort}`,
      MM_TOKEN: 'test-token',
      SOLOIST_DEVICE_NAME: 'MagicMirror',
      RADIO_EXTERNAL_RESEND_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let logs = ''
  bridge.stdout.on('data', (data) => { logs += data })
  bridge.stderr.on('data', (data) => { logs += data })

  t.after(async () => {
    bridge.kill('SIGKILL')
    for (const socket of wss.clients) socket.terminate()
    wss.close()
    mmServer.close()
  })

  const base = `http://127.0.0.1:${httpPort}`
  await waitFor(async () => {
    try { return (await getJson(`${base}/health`)).status === 200 } catch { return false }
  }, 5000, 'bridge HTTP server')
  await waitFor(() => client, 5000, 'bridge WebSocket connection')

  const events = []
  const eventSocket = new WebSocket(`ws://127.0.0.1:${httpPort}/events`)
  await once(eventSocket, 'open')
  eventSocket.on('message', (data) => events.push(JSON.parse(data.toString())))
  t.after(() => eventSocket.terminate())

  const send = (message) => client.send(JSON.stringify(message))
  send({ type: 'auth_state', logged_in: true, is_active: true, device_name: 'MagicMirror' })
  send({
    type: 'playback_state',
    status: 'playing',
    item: {
      uri: 'spotify:track:1',
      entity_type: 'track',
      decorations: {
        identity: { name: 'Song' },
        creators: [{ entity: { uri: 'spotify:artist:1', decorations: { identity: { name: 'Artist' } } } }],
        parent: { entity: { uri: 'spotify:album:1', decorations: { identity: { name: 'Album' } } } },
        visual_identity: { cover: [{ url: 'https://img.example/large.jpg', size: 'large' }] },
        playback: { duration_ms: 200000, content_ratings: [] },
      },
    },
    context: { uri: 'spotify:playlist:1', decorations: { identity: { name: 'List' } } },
    position: { position_ms: 1000, timestamp_ms: Date.now(), speed: 1 },
    volume: 42,
    is_active: true,
    options: { shuffle: false, repeat: 'off' },
  })

  const playing = await waitFor(async () => {
    const result = await getJson(`${base}/status`)
    return result.status === 200 ? result.body : null
  }, 5000, 'status while playing')
  assert.equal(playing.track.name, 'Song')
  assert.deepEqual(playing.track.artist_names, ['Artist'])
  assert.equal(playing.track.album_name, 'Album')
  assert.equal(playing.track.album_cover_url, 'https://img.example/large.jpg')
  assert.equal(playing.track.duration, 200000)
  assert.ok(playing.track.position >= 1000 && playing.track.position < 5000)
  assert.equal(playing.paused, false)
  assert.equal(playing.volume, 42)

  await waitFor(() => notifications.some((entry) => entry.url === '/api/notification/RADIO_STOP'), 3000, 'RADIO_STOP')
  const playingNotification = await waitFor(() => notifications.find((entry) =>
    entry.url === '/api/notification/RADIO_EXTERNAL' && entry.body?.active), 3000, 'RADIO_EXTERNAL active')
  assert.deepEqual(playingNotification.body, {
    active: true, source: 'spotify', playing: true, title: 'Song', artist: 'Artist',
    cover: 'https://img.example/large.jpg',
  })
  await waitFor(() => events.find((entry) => entry.type === 'metadata' && entry.data?.name === 'Song'), 3000, 'metadata event')
  await waitFor(() => events.some((entry) => entry.type === 'playing'), 3000, 'playing event')

  let response = await fetch(`${base}/player/pause`, { method: 'POST' })
  assert.equal(response.status, 200)
  await waitFor(() => commands.some((entry) => entry.command === 'pause'), 2000, 'pause command')

  send({ type: 'playback_changed', status: 'paused' })
  const paused = await waitFor(async () => {
    const result = await getJson(`${base}/status`)
    return result.status === 200 && result.body.paused ? result.body : null
  }, 3000, 'paused status')
  assert.equal(paused.track.name, 'Song')
  await waitFor(() => notifications.find((entry) =>
    entry.url === '/api/notification/RADIO_EXTERNAL' && entry.body?.playing === false), 3000, 'paused notification')
  await waitFor(() => events.some((entry) => entry.type === 'paused'), 3000, 'paused event')

  response = await fetch(`${base}/player/next`, { method: 'POST' })
  assert.equal(response.status, 200)
  await waitFor(() => commands.some((entry) => entry.command === 'skip_next'), 2000, 'skip_next command')

  response = await fetch(`${base}/player/resume`, { method: 'POST' })
  assert.equal(response.status, 200)
  await waitFor(() => commands.some((entry) => entry.command === 'play'), 2000, 'play command')
  await waitFor(() => commands.some((entry) => entry.command === 'activate'), 2000, 'activate command')

  send({ type: 'playback_changed', status: 'idle' })
  await waitFor(async () => (await getJson(`${base}/status`)).status === 204, 3000, '204 while idle')
  await waitFor(() => notifications.find((entry) =>
    entry.url === '/api/notification/RADIO_EXTERNAL' && entry.body?.active === false), 3000, 'inactive notification')
  await waitFor(() => events.some((entry) => entry.type === 'inactive'), 3000, 'inactive event')

  send({ type: 'auth_state', logged_in: false, is_active: false, device_name: 'MagicMirror' })
  await waitFor(async () => {
    const health = await getJson(`${base}/health`)
    return health.body?.authenticated === false
  }, 3000, 'logged-out health')

  assert.ok(commands.length >= 3, `expected commands, got ${JSON.stringify(commands)}\n${logs}`)
})
