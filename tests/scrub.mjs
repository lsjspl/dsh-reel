import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createScrubFrames } from '../lib/scrub.js'

let passes = 0
const equal = (label, actual, expected) => { assert.deepEqual(actual, expected, label); passes++ }
const check = (label, value) => { assert.ok(value, label); passes++ }
function fakeSpawn() {
  const children = []
  return { children, spawnProcess(binary, args, options) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.kills = 0
    child.kill = () => { child.kills++ }
    children.push({ child, args, options })
    return child
  } }
}
const jpg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
const fake = fakeSpawn(), pool = createScrubFrames({ spawnProcess: fake.spawnProcess, maxConcurrent: 1 })
const controller = new AbortController()
const pending = pool.frame('ffmpeg', 'a.avi', 'v1', 12.2, controller.signal)
const rejected = assert.rejects(pending, { name: 'AbortError' })
equal('frame readers run without a visible window', fake.children[0].options.windowsHide, true)
check('frame reads seek before opening the input', fake.children[0].args.indexOf('-ss') < fake.children[0].args.indexOf('-i'))
equal('nearby frame targets share a half-second cache bucket', fake.children[0].args[fake.children[0].args.indexOf('-ss') + 1], '12.000')
await assert.rejects(pool.frame('ffmpeg', 'b.avi', 'v1', 20), { status: 503 }); passes++
equal('over-budget requests are not queued or spawned', fake.children.length, 1)
controller.abort(); await rejected; passes++
equal('cancelling an HTTP consumer kills its frame process', fake.children[0].child.kills, 1)
await assert.rejects(pool.frame('ffmpeg', 'b.avi', 'v1', 20), { status: 503 }); passes++
fake.children[0].child.emit('close', 1)
const first = pool.frame('ffmpeg', 'a.avi', 'v1', 12)
fake.children[1].child.stdout.emit('data', jpg); fake.children[1].child.emit('close', 0)
equal('a completed frame is returned', await first, jpg)
equal('a cached frame returns without another decoder', await pool.frame('ffmpeg', 'a.avi', 'v1', 12.1), jpg)
equal('frame cache eliminates repeated decoder starts', fake.children.length, 2)
const changed = pool.frame('ffmpeg', 'a.avi', 'v2', 12)
equal('source revision invalidates an old frame', fake.children.length, 3)
fake.children[2].child.stdout.emit('data', jpg); fake.children[2].child.emit('close', 0); await changed
const oversized = pool.frame('ffmpeg', 'b.avi', 'v1', 2)
const tooBig = assert.rejects(oversized, { status: 503 })
fake.children[3].child.stdout.emit('data', Buffer.alloc(512 * 1024 + 1)); await tooBig; passes++
equal('unbounded frame output is stopped', fake.children[3].child.kills, 1)
fake.children[3].child.emit('close', 1)
pool.dispose()
await assert.rejects(pool.frame('ffmpeg', 'a.avi', 'v1', 12), { status: 503 }); passes++

const timed = fakeSpawn(), deadline = createScrubFrames({ spawnProcess: timed.spawnProcess, timeoutMs: 20 })
// Keep the event loop alive while testing the unref'ed production deadline.
const keepAlive = setTimeout(() => {}, 1000)
await assert.rejects(deadline.frame('ffmpeg', 'slow.avi', 'v1', 0), { status: 503 }); passes++
clearTimeout(keepAlive)
equal('stalled frame reads are killed', timed.children[0].child.kills, 1)
timed.children[0].child.emit('close', 1); deadline.dispose()

if (process.env.REEL_FFMPEG) {
  const workspace = mkdtempSync(join(tmpdir(), 'reel-scrub-test-')), reader = createScrubFrames()
  try {
    const binary = process.env.REEL_FFMPEG, file = join(workspace, 'sample.avi')
    execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24', '-t', '5', '-an', '-c:v', 'mpeg4', '-threads', '2', '-y', file], { timeout: 20000 })
    const before = performance.now()
    const a = await reader.frame(binary, file, 'v1', 0), b = await reader.frame(binary, file, 'v1', 3)
    check('real AVI frames decode to JPEG', a[0] === 0xff && a[1] === 0xd8 && b[0] === 0xff && b[1] === 0xd8)
    check('dragging to another time produces a different real picture', !a.equals(b))
    equal('real frame cache preserves the decoded picture', await reader.frame(binary, file, 'v1', 3), b)
    execFileSync(binary, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'null', '-'], { input: b, timeout: 10000 })
    passes++
    console.log(`实际 AVI 取帧：两帧 ${Math.round(performance.now() - before)}ms（含 JPEG 验证）`)
  } finally {
    reader.dispose()
    if (dirname(resolve(workspace)) === resolve(tmpdir()) && basename(workspace).startsWith('reel-scrub-test-')) rmSync(workspace, { recursive: true, force: true })
  }
}
console.log(`实时取帧回归通过 ${passes} 项 ✓`)
