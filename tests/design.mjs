import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, utimesSync, statSync } from 'node:fs'
import { join, resolve, sep, parse, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { apply, Config } from '../lib/reel.js'
import { mediaKeyOf } from '../lib/addressing.js'
import { resolveInside } from '../lib/media.js'
import { createTranscoder } from '../lib/transcode.js'
import { createScanPool } from '../lib/scan.js'

let passes = 0
const check = (label, value) => { assert.ok(value, label); passes += 1 }
const equal = (label, actual, expected) => { assert.deepEqual(actual, expected, label); passes += 1 }
const tick = () => new Promise((done) => setImmediate(done))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const workspace = mkdtempSync(join(tmpdir(), 'reel-design-test-'))
const cleanups = []

async function boot(raw) {
  const routes = new Map(), effects = [], listeners = new Map()
  const entry = Config(raw)
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    root: { loader: { await: async () => {} } },
    get: (name) => name === 'webServer' ? {
      register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    } : undefined,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') effects.push(dispose) },
    on: (name, callback) => listeners.set(name, callback),
    inject() {},
  }
  apply(ctx, entry)
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://x').pathname)
    if (handler) void handler(req, res)
    else { res.statusCode = 404; res.end() }
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  cleanups.push(async () => {
    for (const dispose of effects.reverse()) dispose()
    await new Promise((done) => server.close(done))
  })
  return {
    async get(path, options) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options)
      const text = await response.text()
      return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) }
    },
    update(roots) {
      entry.roots[Symbol.for('cosmokit.volatile.write')](roots)
      listeners.get('loader/volatile-update')([['roots']])
    },
    routes,
  }
}

class ResponseStub extends EventEmitter {
  headers = {}
  statusCode = 0
  destroyed = false
  writableEnded = false
  body = ''
  backpressure = false
  setHeader(key, value) { this.headers[key] = value }
  writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) }
  write(chunk) { this.body += chunk; return !this.backpressure }
  end(chunk = '') { this.body += chunk; this.writableEnded = true; this.emit('finish') }
  destroy() { this.destroyed = true; this.emit('close') }
}

function fakeSpawn(autoClose = false) {
  const children = []
  const spawnProcess = (binary, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.paused = 0; child.resumed = 0; child.kills = []
    child.stdout.pause = () => { child.paused += 1 }
    child.stdout.resume = () => { child.resumed += 1 }
    child.kill = (signal) => {
      child.kills.push(signal)
      if (autoClose) queueMicrotask(() => child.emit('close', -1))
    }
    children.push({ child, binary, args, options })
    return child
  }
  return { children, spawnProcess }
}

try {
  const rootA = join(workspace, 'A'), rootB = join(workspace, 'B'), alias = join(workspace, 'alias')
  mkdirSync(rootA); mkdirSync(rootB)
  writeFileSync(join(rootA, 'same.jpg'), 'A')
  writeFileSync(join(rootB, 'same.jpg'), 'B')
  const host = await boot({ roots: [rootA, rootB] })
  const keyA = mediaKeyOf(rootA, 'same.jpg'), keyB = mediaKeyOf(rootB, 'same.jpg')
  equal('固定 key 读取 A', (await host.get(`/reel/stream?k=${encodeURIComponent(keyA)}`)).text, 'A')
  renameSync(rootA, `${rootA}-offline`)
  equal('A 离线时其旧 key 404', (await host.get(`/reel/stream?k=${encodeURIComponent(keyA)}`)).status, 404)
  equal('A 离线不会重编号 B', (await host.get(`/reel/stream?k=${encodeURIComponent(keyB)}`)).text, 'B')
  equal('空 key 选当前可用根', (await host.get('/reel/api/list?k=')).json().key, mediaKeyOf(rootB))
  renameSync(`${rootA}-offline`, rootA)
  host.update([rootB, rootA])
  equal('重排后 A key 保持身份', (await host.get(`/reel/stream?k=${encodeURIComponent(keyA)}`)).text, 'A')
  host.update([rootB])
  equal('删除根后旧 key 404', (await host.get(`/reel/stream?k=${encodeURIComponent(keyA)}`)).status, 404)
  equal('旧位置型 key 拒绝解析', (await host.get('/reel/stream?k=r0%2Fsame.jpg')).status, 404)
  const restarted = await boot({ roots: [rootB, rootA] })
  equal('重启与重排后 ID 不变', (await restarted.get(`/reel/stream?k=${encodeURIComponent(keyB)}`)).text, 'B')

  symlinkSync(rootB, alias, process.platform === 'win32' ? 'junction' : 'dir')
  check('junction/软链根可解析合法文件', (await resolveInside(alias, 'same.jpg'))?.abs.endsWith('same.jpg'))
  const aliasHost = await boot({ roots: [alias] })
  equal('junction 根 HTTP 流可用', (await aliasHost.get(`/reel/stream?k=${encodeURIComponent(mediaKeyOf(alias, 'same.jpg'))}`)).text, 'B')
  symlinkSync(rootA, join(rootB, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  equal('真实路径检查仍拦截根外软链', await resolveInside(alias, 'escape/same.jpg'), null)
  equal('真实路径检查仍拦截 ..', await resolveInside(alias, '../A/same.jpg'), null)
  const volumeRoot = parse(rootB).root
  check('文件系统根目录也能解析子文件', (await resolveInside(volumeRoot, relative(volumeRoot, join(rootB, 'same.jpg'))))?.abs.endsWith('same.jpg'))
  if (process.platform === 'win32') equal('Windows 大小写不改变稳定 ID', mediaKeyOf(rootB.toUpperCase()), mediaKeyOf(rootB))

  writeFileSync(join(rootB, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.bad=1</script><rect width="1" height="1"/></svg>')
  for (const endpoint of ['stream', 'download']) {
    const response = await host.get(`/reel/${endpoint}?k=${encodeURIComponent(mediaKeyOf(rootB, 'active.svg'))}`)
    equal(`${endpoint} SVG 保留正确类型`, response.headers.get('content-type'), 'image/svg+xml')
    check(`${endpoint} SVG 强制沙箱`, response.headers.get('content-security-policy').includes('sandbox'))
    check(`${endpoint} SVG 禁止脚本`, response.headers.get('content-security-policy').includes("script-src 'none'"))
  }

  writeFileSync(join(rootB, 'movie.mp4'), 'video')
  const before = (await host.get(`/reel/api/list?k=${mediaKeyOf(rootB)}`)).json()
  equal('首次无字幕', before.files.find((item) => item.name === 'movie.mp4').subtitles, undefined)
  const oldTimes = statSync(rootB)
  writeFileSync(join(rootB, 'movie.zh.srt'), '1\n00:00:01,000 --> 00:00:02,000\n字幕\n')
  utimesSync(rootB, oldTimes.atime, oldTimes.mtime)
  const refreshed = (await host.get(`/reel/api/list?k=${mediaKeyOf(rootB)}`)).json()
  equal('刷新立即发现新增字幕', refreshed.files.find((item) => item.name === 'movie.mp4').subtitles[0].name, 'movie.zh.srt')
  rmSync(join(rootB, 'movie.zh.srt'))
  const removed = (await host.get(`/reel/api/stat?k=${encodeURIComponent(mediaKeyOf(rootB, 'movie.mp4'))}`)).json()
  equal('字幕删除会使索引失效', removed.entry.subtitles, undefined)

  equal('Config 默认信任检查 true', Config({}).requireTrustedRequest, true)
  equal('显式 false 仍可关闭检查', Config({ requireTrustedRequest: false }).requireTrustedRequest, false)
  const denied = new ResponseStub()
  await host.routes.get('/reel/api/session')({ method: 'GET', url: '/reel/api/session', headers: { host: 'x' }, socket: { remoteAddress: '192.168.1.8' } }, denied)
  equal('省略配置的非回环请求被拒绝', denied.statusCode, 403)

  const large = join(workspace, 'large')
  mkdirSync(large)
  for (let index = 0; index < 3000; index += 1) writeFileSync(join(large, `a${String(index).padStart(4, '0')}.jpg`), 'x')
  writeFileSync(join(large, 'zz-latest.jpg'), 'latest')
  utimesSync(join(large, 'zz-latest.jpg'), new Date(), new Date(Date.now() + 10000))
  const largeHost = await boot({ roots: [large] })
  const all = [], cursors = []
  let cursor = null, last
  do {
    const response = await largeHost.get(`/reel/api/scan?k=lib&kinds=image&limit=3000&depth=32${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    equal('递归分页请求成功', response.status, 200)
    last = response.json()
    check('每页媒体数不超过 3000', last.items.length <= 3000)
    all.push(...last.items)
    cursor = last.nextCursor
    if (cursor) cursors.push(cursor)
  } while (cursor)
  equal('分页收齐 3001 个文件', all.length, 3001)
  equal('分页边界没有重复文件', new Set(all.map((item) => item.key)).size, 3001)
  equal('最终页不再报告截断', last.truncated, false)
  equal('所有页统一排序可找到最新文件', all.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].name, 'zz-latest.jpg')
  equal('消费过的游标不能重复使用', (await largeHost.get(`/reel/api/scan?k=lib&kinds=image&depth=32&cursor=${cursors[0]}`)).status, 410)
  const first = (await largeHost.get('/reel/api/scan?k=lib&kinds=image&limit=1&depth=32')).json()
  largeHost.update([large])
  equal('配置变化拒绝旧游标', (await largeHost.get(`/reel/api/scan?k=lib&kinds=image&depth=32&cursor=${first.nextCursor}`)).status, 409)

  const pool = createScanPool({ describe: async (root, rel) => ({ key: mediaKeyOf(root.path, rel), mtimeMs: 0 }), pageBudget: () => 2, maxSessions: 1, ttlMs: 20 })
  cleanups.push(() => pool.dispose())
  const scope = { library: true, entries: [{ root: { index: 1, path: large }, abs: large, rel: '' }] }
  const page = await pool.page(scope, { kinds: ['image'] }, 0)
  equal('目录工作预算产生可续扫页面', page.items.length, 2)
  check('工作预算到达后仍有游标', typeof page.nextCursor === 'string')
  await assert.rejects(pool.page(scope, { kinds: ['image'] }, 0), { status: 503 }); passes += 1
  await sleep(35)
  await assert.rejects(pool.page(scope, { kinds: ['image'], cursor: page.nextCursor }, 0), { status: 410 }); passes += 1
  const expiredReplacement = await pool.page(scope, { kinds: ['image'] }, 0)
  check('游标过期释放扫描容量', typeof expiredReplacement.nextCursor === 'string')
  pool.dispose()
  await tick()

  const abortedPool = createScanPool({ describe: async () => { await tick(); return { key: 'file', mtimeMs: 0 } }, pageBudget: () => 3000, maxSessions: 1 })
  cleanups.push(() => abortedPool.dispose())
  const controller = new AbortController()
  const scanning = abortedPool.page(scope, { kinds: ['image'], signal: controller.signal }, 0)
  controller.abort()
  await assert.rejects(scanning, { name: 'AbortError' }); passes += 1
  const afterAbort = await abortedPool.page(scope, { kinds: ['image'], limit: 1 }, 0)
  check('取消请求释放扫描容量', afterAbort.nextCursor !== null)

  const fake = fakeSpawn()
  const transcoder = createTranscoder({ spawnProcess: fake.spawnProcess })
  const responseA = new ResponseStub(), responseB = new ResponseStub()
  const activeA = transcoder.stream(responseA, 'ffmpeg', 'a.avi', 0, { 'content-type': 'video/mp4' })
  const activeB = transcoder.stream(responseB, 'ffmpeg', 'b.avi', 3, {})
  const busy = new ResponseStub()
  await transcoder.stream(busy, 'ffmpeg', 'c.avi', 0, {})
  equal('转码超限返回 503', busy.statusCode, 503)
  equal('转码超限给出重试时间', busy.headers['retry-after'], '2')
  equal('超限请求没有启动进程', fake.children.length, 2)
  check('编码和解码均有线程上限', fake.children[0].args.filter((arg) => arg === '-threads').length === 2)
  equal('FFmpeg 后台启动', fake.children[0].options.windowsHide, true)
  check('定位参数保留', fake.children[1].args.includes('3.000'))
  responseA.destroy()
  await activeA
  check('断开连接终止进程', fake.children[0].child.kills.includes('SIGKILL'))
  const stillBusy = new ResponseStub()
  await transcoder.stream(stillBusy, 'ffmpeg', 'c.avi', 0, {})
  equal('进程未退出时不提前释放槽位', stillBusy.statusCode, 503)
  fake.children[0].child.emit('close', -1)
  const responseC = new ResponseStub()
  const activeC = transcoder.stream(responseC, 'ffmpeg', 'c.avi', 0, {})
  equal('退出后可以启动新进程', fake.children.length, 3)
  responseB.backpressure = true
  fake.children[1].child.stdout.emit('data', Buffer.from('mp4'))
  equal('转码输出触发背压暂停', fake.children[1].child.paused, 1)
  responseB.emit('drain')
  equal('响应 drain 恢复转码输出', fake.children[1].child.resumed, 1)
  fake.children[1].child.emit('close', 0)
  await activeB
  equal('正常转码完成结束响应', responseB.writableEnded, true)
  transcoder.dispose()
  await activeC
  check('卸载终止所有活动转码', fake.children[2].child.kills.includes('SIGKILL') && responseC.destroyed)
  fake.children[2].child.emit('close', -1)

  const timeoutFake = fakeSpawn(true)
  const timed = createTranscoder({ spawnProcess: timeoutFake.spawnProcess, startupTimeoutMs: 15, stallTimeoutMs: 15 })
  const noOutput = new ResponseStub()
  await timed.stream(noOutput, 'ffmpeg', 'hung.avi', 0, {})
  equal('启动超时返回 503', noOutput.statusCode, 503)
  check('启动超时终止进程', timeoutFake.children[0].child.kills.includes('SIGKILL'))
  const stalled = new ResponseStub()
  const stalledJob = timed.stream(stalled, 'ffmpeg', 'stalled.avi', 0, {})
  timeoutFake.children[1].child.stdout.emit('data', Buffer.from('mp4'))
  await stalledJob
  check('开始输出后卡死会终止进程和响应', timeoutFake.children[1].child.kills.includes('SIGKILL') && stalled.destroyed)
  timed.dispose()

  console.log(`设计回归通过 ${passes} 项 ✓`)
} finally {
  for (const cleanup of cleanups.reverse()) await cleanup()
  await tick()
  const target = resolve(workspace)
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('reel-design-test-')) throw new Error('unexpected cleanup target')
  rmSync(target, { recursive: true, force: true })
}
