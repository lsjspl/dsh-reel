import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createCatalog } from '../lib/catalog.js'
import { rootIdOf } from '../lib/addressing.js'

let passes = 0
const check = (name, value) => { assert.ok(value, name); passes += 1 }
const equal = (name, actual, expected) => { assert.deepEqual(actual, expected, name); passes += 1 }
const workspace = await mkdtemp(join(tmpdir(), 'reel-catalog-test-'))
const a = join(workspace, 'Disk A'), b = join(workspace, 'Disk B')
await Promise.all([mkdir(join(a, '旅行'), { recursive: true }), mkdir(join(b, '归档'), { recursive: true })])
const roots = [a, b].map(path => ({ index: rootIdOf(path), path, label: basename(path) }))
const catalog = createCatalog({ refreshMs: 60000 })
try {
  await Promise.all([
    writeFile(join(a, '直接.mp4'), 'a'), writeFile(join(a, '旅行', 'Summer 10.mp4'), 'video10'),
    writeFile(join(a, '旅行', 'Summer 2.mp4'), 'video2'), writeFile(join(b, '归档', 'SUMMER 3.jpg'), 'image3'),
    writeFile(join(b, 'ignore.txt'), 'not media'),
  ])
  catalog.ensure(roots)
  check('cold indexing exposes status without waiting', catalog.state().indexing)
  await catalog.ready()
  equal('both disk roots share one index; unrelated files are excluded', catalog.state().indexed, 4)
  let page = await catalog.query({ q: 'Ｓｕｍｍｅｒ', sort: 'name', limit: 2 })
  equal('Unicode normalization, case and numeric filename ordering', page.items.map(item => item.name), ['Summer 2.mp4', 'SUMMER 3.jpg'])
  equal('results expose the complete count before pagination', page.total, 3)
  equal('first page carries a resumable offset', page.nextOffset, 2)
  page = await catalog.query({ q: 'summer', sort: 'name', offset: 2, limit: 2 })
  equal('next page has no duplicate or omitted files', page.items.map(item => item.name), ['Summer 10.mp4'])
  equal('last page terminates pagination', page.nextOffset, null)
  equal('search includes disk labels and paths, with AND tokens', (await catalog.query({ q: 'disk b 归档 summer' })).total, 1)
  equal('scope can stay in the immediate directory', (await catalog.query({ root: roots[0].index, recursive: false })).total, 1)
  equal('scope can include subdirectories on only one disk', (await catalog.query({ root: roots[0].index, rel: '旅行' })).total, 2)
  equal('video filter excludes matching pictures', (await catalog.query({ q: 'summer', kinds: 'video' })).total, 2)
  equal('size sorting is independent of disk traversal order', (await catalog.query({ sort: 'size' })).items[0].name, 'Summer 10.mp4')
  const generation = catalog.state().generation
  catalog.ensure(roots.slice().reverse())
  equal('root order changes reuse stable identifiers and the shared index', catalog.state().generation, generation)
  await unlink(join(a, '旅行', 'Summer 2.mp4'))
  catalog.ensure(roots, 0, true)
  equal('refresh retains the usable previous index while walking', (await catalog.query({ q: 'summer' })).total, 3)
  await catalog.ready()
  equal('completed refresh removes deleted files', (await catalog.query({ q: 'summer' })).total, 2)
  await mkdir(join(a, '.private'))
  await writeFile(join(a, '.private', 'hidden.mp4'), 'hidden')
  catalog.ensure(roots, 0, true); await catalog.ready()
  equal('explicitly configured libraries include media in dot-prefixed directories', (await catalog.query({ q: '.private hidden' })).total, 1)
  await unlink(join(a, '.private', 'hidden.mp4'))
  catalog.ensure([roots[1]], 1)
  await catalog.ready()
  equal('removed disks leave no stale search results', (await catalog.query()).items.map(item => item.root), [roots[1].index])

  // Exercise real filesystem traversal plus repeated warm searches, rather than
  // timing a hand-built array that bypasses the production index.
  const bulk = join(a, 'bulk')
  await mkdir(bulk)
  for (let start = 0; start < 6000; start += 64) {
    await Promise.all(Array.from({ length: Math.min(64, 6000 - start) }, (_, i) => writeFile(join(bulk, `clip-${start + i}.mp4`), 'x')))
  }
  const began = performance.now()
  catalog.ensure(roots, 2); await catalog.ready()
  const indexedMs = performance.now() - began
  equal('large libraries remain searchable across roots', catalog.state().indexed, 6003)
  const times = []
  for (let i = 0; i < 20; i += 1) {
    const at = performance.now()
    page = await catalog.query({ q: `clip-${i * 11}`, limit: 120 })
    times.push(performance.now() - at)
    check('warm query matches complete filenames', page.items.every(item => item.name.includes(`clip-${i * 11}`)))
  }
  const cacheAt = performance.now()
  await catalog.query({ q: 'clip-209', limit: 120 })
  const cachedMs = performance.now() - cacheAt
  console.log(`索引测量：${catalog.state().indexed} 个文件，首次扫描 ${indexedMs.toFixed(0)}ms，20 次热搜索最慢 ${Math.max(...times).toFixed(1)}ms，缓存查询 ${cachedMs.toFixed(1)}ms`)
  const capped = createCatalog({ maxEntries: 15 })
  capped.ensure(roots); await capped.ready()
  equal('entry limits are enforced across workers', capped.state().indexed, 15)
  check('entry limits are visible to clients', capped.state().truncated)
  capped.dispose()
  const beforeRefresh = catalog.state().generation
  catalog.ensure(roots, 3)
  catalog.ensure(roots, 3, true)
  await catalog.ready()
  check('refresh requested during a scan schedules a complete follow-up scan', catalog.state().generation >= beforeRefresh + 3)
  equal('follow-up refresh retains all files from both roots', catalog.state().indexed, 6003)
  const interrupted = createCatalog()
  interrupted.ensure(roots); interrupted.ensure([roots[1]], 4); await interrupted.ready()
  equal('superseded builds cannot publish results from removed roots', interrupted.state().indexed, 1)
  interrupted.dispose()
} finally {
  catalog.dispose()
  if (dirname(resolve(workspace)) === resolve(tmpdir()) && basename(workspace).startsWith('reel-catalog-test-')) await rm(workspace, { recursive: true, force: true })
}
console.log(`媒体索引回归通过 ${passes} 项 ✓`)
