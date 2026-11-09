import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import { kindOf, resolveInside } from './media.js'
import { mediaKeyOf } from './addressing.js'

const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase()
const nameOrder = new Intl.Collator('zh-Hans-CN', { numeric: true })
const orders = {
  new: (a, b) => b.mtimeMs - a.mtimeMs || a.key.localeCompare(b.key),
  old: (a, b) => a.mtimeMs - b.mtimeMs || a.key.localeCompare(b.key),
  name: (a, b) => nameOrder.compare(a.name, b.name) || a.key.localeCompare(b.key),
  size: (a, b) => b.size - a.size || a.key.localeCompare(b.key),
  kind: (a, b) => a.kind.localeCompare(b.kind) || nameOrder.compare(a.name, b.name),
}

/** One shared, lightweight filesystem index. Searches never start their own walks
 * or ffprobe processes. Files are described only when returned to the browser.
 * Roots are walked independently so one disk doesn't monopolize the library.
 */
export function createCatalog({ maxEntries = 500000, refreshMs = 60000 } = {}) {
  let roots = [], stamp = '', generation = 0, disposed = false, job = null, epoch = 0, refreshPending = false
  let files = new Map(), updatedAt = 0, indexing = false, truncated = false, unreadable = 0
  const queryCache = new Map()
  const state = () => ({ generation, indexed: files.size, indexing, truncated, unreadable, updatedAt })

  async function rebuild(token, snapshot) {
    // Publish complete directory batches. During refresh, keep the previous index
    // until the replacement is ready; the first build becomes searchable at once.
    const cold = files.size === 0
    const next = new Map()
    if (cold) { files = next; generation += 1; queryCache.clear() }
    let cursor = 0, count = 0, failures = 0, limited = false
    let publishedAt = 0
    const publish = () => {
      if (cold && token === epoch && !disposed && Date.now() - publishedAt >= 250) {
        generation += 1; queryCache.clear(); publishedAt = Date.now()
      }
    }
    async function walk(root) {
      const queue = [{ abs: root.path, rel: '', depth: 0 }]
      for (let head = 0; head < queue.length; head += 1) {
        if (disposed || token !== epoch || count >= maxEntries) { if (count >= maxEntries) limited = true; return }
        const folder = queue[head]
        queue[head] = null
        let directory
        try { directory = await opendir(folder.abs) } catch { failures += 1; continue }
        let batch = []
        const drain = async () => {
          await Promise.all(batch.map(async (row) => {
            if (count >= maxEntries) { limited = true; return }
            const rel = folder.rel ? `${folder.rel}/${row.name}` : row.name
            const info = await stat(join(folder.abs, row.name)).catch(() => null)
            if (!info?.isFile() || disposed || token !== epoch) return
            if (count >= maxEntries) { limited = true; return }
            const file = { key: mediaKeyOf(root.path, rel), name: row.name, rel, root: root.index, rootLabel: root.label, kind: kindOf(row.name), size: info.size, mtimeMs: info.mtimeMs }
            next.set(file.key, { ...file, searchText: normalize(`${root.label}/${rel}`) }); count += 1
          }))
          batch = []
          publish()
          await yieldTurn()
        }
        try {
          for await (const row of directory) {
            if (disposed || token !== epoch || count >= maxEntries) break
            if (row.isDirectory()) {
              if (folder.depth >= 64) { limited = true; continue }
              const rel = folder.rel ? `${folder.rel}/${row.name}` : row.name
              const contained = await resolveInside(root.path, rel)
              if (contained) queue.push({ ...contained, depth: folder.depth + 1 })
            } else if (row.isFile() && ['video', 'image', 'audio'].includes(kindOf(row.name))) {
              batch.push(row)
              if (batch.length >= 8) await drain()
            }
          }
          if (batch.length) await drain()
        } catch { failures += 1 }
        publish()
        // Release visited directory references on very large trees.
        if (head >= 1024) { queue.splice(0, head + 1); head = -1 }
      }
    }
    async function worker() {
      while (cursor < snapshot.length && !disposed && token === epoch) await walk(snapshot[cursor++])
    }
    await Promise.all([worker(), worker()])
    if (disposed || token !== epoch) return
    files = next; truncated = limited; unreadable = failures
    updatedAt = Date.now(); indexing = false; generation += 1; queryCache.clear()
  }

  function start() {
    if (job || disposed) return job
    indexing = true
    const token = epoch
    const pending = rebuild(token, roots.slice()).catch(() => { if (token === epoch) { indexing = false; unreadable += 1 } })
    job = pending
    void pending.finally(() => {
      if (job !== pending) return
      job = null
      if (refreshPending && !disposed) { refreshPending = false; void start() }
    })
    return pending
  }

  return {
    ensure(nextRoots, revision = 0, refresh = false) {
      const nextStamp = `${revision}:${nextRoots.map(root => `${root.index}:${root.path}`).sort().join('|')}`
      if (nextStamp !== stamp) {
        epoch += 1; refreshPending = false
        stamp = nextStamp; roots = nextRoots.slice(); files = new Map(); updatedAt = 0
        generation += 1; queryCache.clear(); job = null; truncated = false; unreadable = 0
      }
      if (refresh && job) refreshPending = true
      if (refresh || !updatedAt || Date.now() - updatedAt >= refreshMs) void start()
      return state()
    },
    async query({ q = '', root, rel = '', recursive = true, kinds = 'all', sort = 'new', offset = 0, limit = 120 } = {}) {
      const version = generation
      const tokens = normalize(q).trim().split(/\s+/).filter(Boolean)
      const prefix = rel ? `${rel}/` : ''
      const key = JSON.stringify([version, tokens, root, rel, recursive, kinds, sort])
      let matches = queryCache.get(key)
      if (!matches) {
        matches = []
        let visited = 0
        // Snapshot references keep a query consistent while an indexing batch arrives.
        for (const file of [...files.values()]) {
          if (++visited % 2048 === 0) await yieldTurn()
          if (root !== undefined && file.root !== root) continue
          if (!file.rel.startsWith(prefix)) continue
          if (!recursive && file.rel.slice(prefix.length).includes('/')) continue
          if (kinds !== 'all' && file.kind !== kinds) continue
          if (tokens.every(token => file.searchText.includes(token))) matches.push(file)
        }
        matches.sort(orders[sort] ?? orders.new)
        if (generation === version) {
          // Bound retained references as well as query count: 32 full-library
          // searches must not retain 32 copies of a half-million-row result.
          let cachedRows = [...queryCache.values()].reduce((sum, rows) => sum + rows.length, 0)
          while (queryCache.size && (queryCache.size >= 32 || cachedRows + matches.length > 1000000)) {
            const oldest = queryCache.keys().next().value
            cachedRows -= queryCache.get(oldest).length; queryCache.delete(oldest)
          }
          queryCache.set(key, matches)
        }
      }
      const start = Math.max(0, Math.floor(Number(offset) || 0))
      const size = Math.max(1, Math.min(200, Math.floor(Number(limit) || 120)))
      const items = matches.slice(start, start + size).map(({ searchText, ...file }) => file)
      return { ...state(), generation: version, items, total: matches.length, nextOffset: start + items.length < matches.length ? start + items.length : null }
    },
    state,
    async ready() { while (job) await job },
    dispose() { disposed = true; epoch += 1; files.clear(); queryCache.clear() },
  }
}
