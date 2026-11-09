// Manual browser smoke test against the actual UI and HTTP/transcode routes.
// Run: node tests/serve-player.mjs, then open the printed local URL. Ctrl+C cleans up.
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname, basename } from 'node:path'
import { apply, Config } from '../lib/reel.js'

const workspace = mkdtempSync(join(tmpdir(), 'reel-player-browser-'))
const mediaRoot = join(workspace, 'media')
const secondRoot = join(workspace, 'Archive')
mkdirSync(mediaRoot)
mkdirSync(join(secondRoot, '旅行'), { recursive: true })
const routes = new Map(), effects = []
const ctx = {
  logger: () => ({ info() {}, warn: console.warn, error: console.error }),
  root: { loader: { await: async () => {} } },
  get: (name) => name === 'webServer' ? { register: (route) => { const key = `${route.kind}:${route.path}`; routes.set(key, route.handler); return () => routes.delete(key) } } : undefined,
  effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
  on() {}, inject() {},
}
apply(ctx, Config({ roots: [mediaRoot, secondRoot], cacheDir: join(workspace, 'cache') }))
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const route = routes.get(`exact:${path}`) ?? (path.startsWith('/reel/') ? routes.get('prefix:/reel') : undefined)
  if (route) Promise.resolve(route(req, res)).catch(() => { res.statusCode = 500; res.end() })
  else { res.statusCode = 404; res.end() }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${server.address().port}/reel`
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  for (const dispose of effects.reverse()) dispose()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  // Verify the resolved recursive cleanup target is this explicitly named test directory.
  if (dirname(resolve(workspace)) === resolve(tmpdir()) && basename(workspace).startsWith('reel-player-browser-')) rmSync(workspace, { recursive: true, force: true })
}
try {
  const session = await (await fetch(`${url}/api/session`)).json()
  const binary = session.capabilities?.ffmpeg
  if (typeof binary !== 'string' || !binary) throw new Error('FFmpeg is required for this smoke test')
  const common = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '30', '-threads', '2', '-y']
  execFileSync(binary, [...common, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', join(mediaRoot, 'Sample.mp4')], { timeout: 60000 })
  execFileSync(binary, [...common, '-c:v', 'mpeg4', '-q:v', '7', '-c:a', 'mp3', join(mediaRoot, 'Stream.avi')], { timeout: 60000 })
  execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=24', '-t', '6', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', join(secondRoot, '旅行', 'Portrait.mp4')], { timeout: 30000 })
  for (const [name, source] of [['日落', 'color=c=0xc38c5c:size=640x400'], ['山林', 'testsrc2=size=640x400'], ['夜色', 'color=c=0x344e65:size=640x400']]) {
    execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-frames:v', '1', '-threads', '1', '-y', join(secondRoot, '旅行', `${name}.jpg`)], { timeout: 10000 })
  }
  for (const stem of ['Sample', 'Stream']) {
    writeFileSync(join(mediaRoot, `${stem}.zh.srt`), '1\n00:00:00,000 --> 00:00:29,000\n中文字幕测试\n')
    writeFileSync(join(mediaRoot, `${stem}.en.srt`), '1\n00:00:00,000 --> 00:00:29,000\nEnglish subtitle test\n')
  }
  await fetch(`${url}/api/search?k=lib&refresh=1`)
  console.log(`Browser smoke test: ${url}`)
  console.log(`Fixtures: ${workspace}`)
  console.log(`FFmpeg: ${binary}`)
  process.on('SIGINT', () => { void stop().then(() => process.exit(0)) })
  process.on('SIGTERM', () => { void stop().then(() => process.exit(0)) })
} catch (error) {
  await stop()
  throw error
}
