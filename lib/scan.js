import { randomUUID } from 'node:crypto'
import { opendir, stat } from 'node:fs/promises'
import { kindOf, resolveInside } from './media.js'

/** Resumable, bounded directory walks. A cursor is owned by one scope/version. */
export function createScanPool({ describe, pageBudget, ttlMs = 60000, maxSessions = 16 }) {
  const sessions = new Map()
  let disposed = false
  const discard = (token, session) => {
    session.aborted = true
    sessions.delete(token)
    // return() closes the directory iterator, including a walk abandoned by
    // navigation or a disconnected client.
    void session.iterator.return().catch(() => {})
  }
  const expire = () => {
    for (const [token, session] of sessions) {
      if (!session.busy && session.expires <= Date.now()) discard(token, session)
    }
  }
  const timer = setInterval(expire, Math.min(ttlMs, 10000))
  timer.unref?.()

  async function* walk(scope, session) {
    const queue = scope.entries.map((entry) => ({ ...entry, depth: 0 }))
    let head = 0
    while (head < queue.length && !disposed) {
      const current = queue[head]
      queue[head++] = null
      if (head >= 1024) { queue.splice(0, head); head = 0 }
      let directory
      try { directory = await opendir(current.abs) } catch { continue }
      for await (const row of directory) {
        if (disposed || session.aborted) return
        const rel = current.rel === '' ? row.name : `${current.rel}/${row.name}`
        let item = null
        if (row.isDirectory() && !row.name.startsWith('.')) {
          if (current.depth >= session.depth) session.depthTruncated = true
          else {
            const contained = await resolveInside(current.root.path, rel)
            if (contained !== null) queue.push({ root: current.root, ...contained, depth: current.depth + 1 })
          }
        } else if (row.isFile() && session.kinds.has(kindOf(row.name))) {
          const contained = await resolveInside(current.root.path, rel)
          const info = contained === null ? null : await stat(contained.abs).catch(() => null)
          if (info?.isFile()) item = await describe(current.root, contained.rel, info)
        }
        // Every entry consumes the request's work budget, even non-media.
        yield item
      }
    }
  }

  return {
    async page(scope, options, version) {
      expire()
      const scopeKey = scope.library ? 'lib' : `r${scope.entries[0].root.index}/${scope.entries[0].rel}`
      const stamp = `${version}:${scope.entries.map((entry) => `${entry.root.index}:${entry.root.path}`).join('|')}`
      const limit = Math.min(3000, Math.max(1, Math.floor(Number(options.limit) || 400)))
      const depth = Math.min(32, Math.max(1, Math.floor(Number(options.depth) || 8)))
      const kinds = [...new Set(options.kinds ?? ['image', 'video'])].sort()
      let session = options.cursor ? sessions.get(options.cursor) : null
      const error = (status, message) => { throw Object.assign(new Error(message), { status }) }
      if (disposed) error(503, 'scanner unavailable')
      if (options.cursor && !session) error(410, 'scan cursor expired; restart the scan')
      if (session && (session.scopeKey !== scopeKey || session.stamp !== stamp || session.depth !== depth || session.kindKey !== kinds.join(','))) {
        if (session.scopeKey === scopeKey && session.stamp !== stamp) discard(options.cursor, session)
        error(409, 'scan scope or configuration changed; restart the scan')
      }
      if (session?.busy) error(409, 'scan page already in progress')
      if (!session) {
        if (sessions.size >= maxSessions) error(503, 'scanner busy; retry shortly')
        session = { scopeKey, stamp, depth, kinds: new Set(kinds), kindKey: kinds.join(','), scanned: 0, depthTruncated: false, pending: null, busy: false }
        session.iterator = walk(scope, session)
      }
      const workingToken = options.cursor || randomUUID()
      sessions.set(workingToken, session)
      session.busy = true
      const abort = () => {
        session.aborted = true
        discard(workingToken, session)
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      const items = []
      let work = 0, done = false
      try {
        if (options.signal?.aborted) abort()
        const budget = Math.min(200000, Math.max(1, Math.floor(pageBudget())))
        while (work < budget && items.length < limit) {
          if (session.aborted) throw Object.assign(new Error('scan cancelled'), { name: 'AbortError' })
          const next = session.pending ?? await session.iterator.next()
          session.pending = null
          if (next.done) { done = true; break }
          work += 1
          session.scanned += 1
          if (next.value !== null) items.push(next.value)
        }
        if (!done) {
          // One-entry lookahead distinguishes an exact final page from a
          // partial walk without losing a file at the cursor boundary.
          session.pending = await session.iterator.next()
          done = session.pending.done
        }
        if (session.aborted || disposed) throw Object.assign(new Error('scan cancelled'), { name: 'AbortError' })
        sessions.delete(workingToken)
        const nextCursor = done ? null : randomUUID()
        if (nextCursor !== null) {
          session.expires = Date.now() + ttlMs
          sessions.set(nextCursor, session)
        }
        items.sort((left, right) => right.mtimeMs - left.mtimeMs || left.key.localeCompare(right.key))
        return { items, scanned: session.scanned, truncated: !done || session.depthTruncated, nextCursor }
      } catch (error) {
        sessions.delete(workingToken)
        await session.iterator.return().catch(() => {})
        throw error
      } finally {
        options.signal?.removeEventListener('abort', abort)
        session.busy = false
      }
    },
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const [token, session] of sessions) discard(token, session)
    },
  }
}
