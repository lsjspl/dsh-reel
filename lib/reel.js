/**
 * dsh-reel — the host half.
 *
 * A function plugin for the dsh web composition. It contributes exactly one
 * thing to the running host: a handful of named routes on the composition's
 * existing `webServer`. That is the whole reason the viewer lives on the dsh
 * port — no second process, no second port, no build step, nothing injected
 * into the dsh GUI.
 *
 * Design constraints, in order of importance:
 *
 * 1. **No dependencies.** Node built-ins plus the cordis context the host
 *    already handed us. Installing this package adds one Loader row and
 *    nothing to the dependency graph.
 * 2. **Read-only over the user's files.** The only filesystem operations are
 *    `readdir`, `stat`, `open`, and `readFile`. Nothing is ever written inside
 *    a configured directory; generated poster frames are cached outside the
 *    media roots — in the OS temp directory by default, or the configured
 *    `cacheDir` — keyed by path + mtime + size.
 * 3. **Containment is proved, not assumed.** Every request path is resolved
 *    with `realpath` on both sides, so neither `..` nor a symlink can walk out
 *    of a configured root.
 *
 * @module dsh-reel
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertRelative,
  contentDisposition,
  contentTypeOf,
  countMediaEntries,
  etagOf,
  kindOf,
  parseRange,
  readDirectory,
  resolveInside,
  streamRange,
  toWebVtt,
} from './media.js'

/** Cordis function-plugin name. */
export const name = 'reel'

/** The one service this plugin cannot work without. */
export const inject = ['webServer']

/**
 * Composition config. Every field is optional so a hand-written row can name
 * only what it cares about. Validation is a plain Standard Schema object, so
 * the row works on any host that runs cordis, with or without schemastery.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-reel',
    validate(value) {
      const raw = value === undefined || value === null ? {} : value
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'reel config must be an object', path: [] }] }
      }
      const issues = []
      const out = {}
      if (raw.roots !== undefined) {
        if (!Array.isArray(raw.roots) || raw.roots.some((item) => typeof item !== 'string')) {
          issues.push({ message: 'roots must be an array of directory paths', path: ['roots'] })
        } else {
          out.roots = raw.roots.map((item) => item.trim()).filter((item) => item !== '')
        }
      }
      if (raw.cacheDir !== undefined) {
        if (typeof raw.cacheDir !== 'string') issues.push({ message: 'cacheDir must be a string', path: ['cacheDir'] })
        else if (raw.cacheDir.trim() !== '') out.cacheDir = raw.cacheDir.trim()
      }
      if (raw.ffmpegPath !== undefined) {
        if (typeof raw.ffmpegPath !== 'string') issues.push({ message: 'ffmpegPath must be a string', path: ['ffmpegPath'] })
        else if (raw.ffmpegPath.trim() !== '') out.ffmpegPath = raw.ffmpegPath.trim()
      }
      if (raw.requireTrustedRequest !== undefined) {
        if (typeof raw.requireTrustedRequest !== 'boolean') {
          issues.push({ message: 'requireTrustedRequest must be a boolean', path: ['requireTrustedRequest'] })
        } else {
          out.requireTrustedRequest = raw.requireTrustedRequest
        }
      }
      if (raw.maxScanEntries !== undefined) {
        if (!Number.isInteger(raw.maxScanEntries) || raw.maxScanEntries < 50 || raw.maxScanEntries > 200000) {
          issues.push({ message: 'maxScanEntries must be an integer in 50..200000', path: ['maxScanEntries'] })
        } else {
          out.maxScanEntries = raw.maxScanEntries
        }
      }
      if (issues.length > 0) return { issues }
      return { value: out }
    },
  },
}

/** Settings namespace the user layer resolves through. */
const NAMESPACE = 'reel'
/** Route prefix owned by this plugin; nothing else in dsh registers under it. */
const BASE = '/reel'
/**
 * Asset directory: plain files, never bundled. `fileURLToPath` rather than a
 * hand-rolled `%20` decode, so a checkout path with spaces, `#`, or non-ASCII
 * characters still resolves.
 */
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), 'assets')
/** Default recursive-scan ceiling: enough for a phone dump, bounded anyway. */
const DEFAULT_MAX_SCAN = 20000
/** Children returned per listing page. */
const LIST_PAGE = 400
/** Cache home when no cacheDir is configured: the OS temp dir, never a configured root. */
const DEFAULT_THUMB_DIR = join(tmpdir(), 'dsh-reel-thumbs')
/** Subtitle sidecar extensions, matched by the per-directory subtitle index. */
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub'])
/** Poster width in pixels; height follows the source aspect ratio. */
const THUMB_WIDTH = 480
/** How many ffmpeg decodes may run at once. */
const THUMB_CONCURRENCY = 3
/** Deadline for one poster render. */
const FFMPEG_TIMEOUT_MS = 25000
/** How long a failed render is remembered before it may be retried. */
const MISS_TTL_MS = 6 * 60 * 60 * 1000
/** Hover animation: length in seconds, width in pixels, and frame rate. */
const PREVIEW_SECONDS = 4
const PREVIEW_WIDTH = 320
const PREVIEW_FPS = 12
/** How many ffprobe processes may run at once. */
const PROBE_CONCURRENCY = 4
/**
 * Poster/preview render recipe version. Part of the cache key.
 *
 * The key is otherwise (path, size, mtime) — all of which stay the same when the
 * *recipe* changes. So a cache filled by an older recipe keeps serving its
 * frames forever: users on this machine were still seeing opening title cards
 * and FBI warnings as posters long after extraction moved to the middle of the
 * clip. Bump this whenever the ffmpeg arguments below change in a way that
 * should invalidate what is already on disk. `2` = mid-clip frames.
 */
const RENDER_VERSION = 2
/** How many entries one recursive scan may return to the client. */
const SCAN_HARD_LIMIT = 3000

// ── small HTTP helpers ─────────────────────────────────────────────────────

/** JSON response: no store, no sniffing, correct length. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('content-length', String(body.byteLength))
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/** JSON failure with a message the viewer can show. */
function sendError(res, status, message) {
  sendJson(res, status, { error: message })
}

/** 405 with this route's supported methods. */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.setHeader('content-length', '0')
  res.end()
}

/** Read a bounded request body as UTF-8 text. */
async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      return undefined
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Read a bounded request body as parsed JSON. */
async function readJsonBody(req, limit = 256 * 1024) {
  const text = await readBody(req, limit)
  if (text === undefined || text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Loopback literals plus their IPv4-mapped forms. */
function isLoopback(address) {
  if (typeof address !== 'string' || address === '') return true
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** `decodeURIComponent` that returns its input instead of throwing. */
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Compare two paths for equality under the platform's rules. */
function samePath(left, right) {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

// ── plugin body ────────────────────────────────────────────────────────────

/**
 * The plugin body.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {object} entry - the validated composition entry config.
 */
export function apply(ctx, entry = {}) {
  const log = ctx.logger('reel')
  trace('apply() entered; entry=%j', entry)

  /**
   * Opt-in startup trace (`REEL_DEBUG=1`). Route registration happens
   * once per process and a composition can swallow a plugin's stderr, so a
   * file-backed trace is the only reliable way to answer "the row is in the
   * tree, why does nothing answer?". Off by default, and free when off.
   *
   * @param {string} message - printf-style message (%s, %j).
   * @param {...unknown} args - values for the placeholders.
   */
  function trace(message, ...args) {
    if (process.env.REEL_DEBUG !== '1') return
    try {
      const line = `${new Date().toISOString()} ${message.replace(/%[jsd]/g, (token) => {
        const value = args.shift()
        return token === '%j' ? JSON.stringify(value) : String(value)
      })}\n`
      appendFileSync(join(tmpdir(), 'dsh-reel-trace.log'), line)
    } catch {
      /* tracing must never break the plugin */
    }
  }

  /** Authoritative configuration source; replaced when a settings provider attaches. */
  let source = () => entry
  /** Owner handle for the `reel` namespace, or null without a provider. */
  let settingsScope = null
  /** Bumped on every external configuration change so the page can re-read. */
  let settingsRevision = 0

  /**
   * The effective configuration: the composition entry with the resolved
   * settings section layered over it.
   *
   * @returns {object} the live configuration.
   */
  const config = () => {
    const layer = source()
    const raw = layer === undefined || layer === null ? {} : layer
    return {
      ...entry,
      ...raw,
      roots: Array.isArray(raw.roots) ? raw.roots.filter((item) => typeof item === 'string') : entry.roots ?? [],
    }
  }

  /** The recursive-scan entry ceiling for this deployment. */
  const maxScan = () => config().maxScanEntries ?? DEFAULT_MAX_SCAN

  /**
   * The directory poster frames and hover previews cache into. An empty or
   * unusable configured value falls back to the OS temp dir. Cache files are
   * content-hash keyed, so relocating the directory costs one regeneration.
   */
  const cacheDir = () => {
    const raw = config().cacheDir
    if (typeof raw === 'string' && raw.trim() !== '') {
      const abs = absolutize(raw)
      if (abs !== null) return abs
    }
    return DEFAULT_THUMB_DIR
  }

  /**
   * Notice once when the cache dir sits inside a configured root: the gallery
   * would list its hash-named cache files alongside the user's media. Nothing
   * is forbidden — the user may have a reason — but it should not be silent.
   */
  let cacheOverlapWarned = false
  const warnCacheInsideRoot = () => {
    const dir = cacheDir().toLowerCase().replace(/[\\/]+$/, '')
    const hit = roots().some((root) => {
      const base = root.path.toLowerCase().replace(/[\\/]+$/, '')
      return dir === base || dir.startsWith(base + sep.toLowerCase())
    })
    if (!hit) {
      cacheOverlapWarned = false
      return
    }
    if (cacheOverlapWarned) return
    cacheOverlapWarned = true
    log.warn('cacheDir %s is inside a configured root; its cache files will show up in the gallery', cacheDir())
  }

  // ── configuration values ─────────────────────────────────────────────────

  /** `$DSH_HOME`, or the conventional location when the host did not set it. */
  const dshHome = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')

  /**
   * Turn one configured value into an absolute directory path.
   *
   * @param {string} value - the raw value.
   * @returns {string|null} the absolute path, or null when unusable.
   */
  const absolutize = (value) => {
    let text = String(value).trim().replace(/^"|"$/g, '')
    if (text === '' || text.includes('\0')) return null
    if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) {
      text = join(process.env.USERPROFILE ?? homedir(), text.slice(1))
    }
    text = text.replace(/\$\{?DSH_HOME\}?/g, dshHome())
    try {
      return resolve(text)
    } catch {
      return null
    }
  }

  /** `REEL_ROOTS`: a delimiter-separated list of directories. */
  const envRoots = () => {
    const raw = process.env.REEL_ROOTS
    if (typeof raw !== 'string' || raw.trim() === '') return []
    return raw
      .split(process.platform === 'win32' ? /[;|]/ : /[:;]/)
      .map((part) => part.trim())
      .filter((part) => part !== '')
  }

  /**
   * The directories the viewer offers, in order.
   *
   * Resolution order: the settings user layer, then the composition row, then
   * `REEL_ROOTS`, then `$DSH_HOME/media`. A directory that does not
   * exist is dropped rather than offered, so the viewer never lists a root it
   * cannot open.
   *
   * @returns {{index: number, path: string, label: string}[]} usable roots.
   */
  const roots = () => {
    const configured = (config().roots ?? []).map((item) => String(item).trim()).filter((item) => item !== '')
    const fallback = envRoots()
    const candidates =
      configured.length > 0 ? configured : fallback.length > 0 ? fallback : [join(dshHome(), 'media')]
    const out = []
    for (const candidate of candidates) {
      const abs = absolutize(candidate)
      if (abs === null) continue
      if (out.some((root) => samePath(root.path, abs))) continue
      let info = null
      try {
        // Synchronous on purpose: `roots()` is read on the request path and by
        // the settings resolver, and a stat of a handful of directories costs
        // less than the promise churn.
        info = statSync(abs)
      } catch {
        info = null
      }
      if (info === null || !info.isDirectory()) continue
      out.push({ index: out.length, path: abs, label: basename(abs) === '' ? abs : basename(abs) })
    }
    return out
  }

  // ── entry addressing ─────────────────────────────────────────────────────

  /**
   * Normalize a client-supplied key.
   *
   * An absent or empty key means "the first configured root" — that is what the
   * page sends before it has navigated anywhere. The default lives here, on the
   * server, rather than in the page: a hand-written `/api/list?k=` then behaves
   * exactly like the page's first load, and every endpoint gets the same rule.
   *
   * @param {unknown} raw - the raw key from a query string or body.
   * @returns {string} a key {@link resolveKey} can read.
   */
  const normalizeKey = (raw) => (typeof raw === 'string' && raw.trim() !== '' ? raw : 'r0')

  /**
   * Resolve one client-supplied entry key into a contained absolute path.
   *
   * Key grammar: `r<rootIndex>/<percent-encoded relative path>`; an empty
   * relative path addresses the root directory itself.
   *
   * @param {unknown} key - the key from a query string or body.
   * @returns {Promise<{root: object, abs: string, rel: string}|null>} the entry, or null.
   */
  const resolveKey = async (key) => {
    if (typeof key !== 'string') return null
    const match = /^r(\d+)(?:\/(.*))?$/.exec(key)
    if (match === null) return null
    const root = roots()[Number(match[1])]
    if (root === undefined) return null
    let rel
    try {
      rel = assertRelative((match[2] ?? '').split('/').map(safeDecode).join('/'))
    } catch {
      return null
    }
    const contained = await resolveInside(root.path, rel)
    if (contained === null) return null
    return { root, abs: contained.abs, rel: contained.rel }
  }

  /** Build a key from a root index and a relative path. */
  const keyFor = (rootIndex, rel) =>
    `r${rootIndex}${rel === '' ? '' : `/${rel.split('/').map(encodeURIComponent).join('/')}`}`

  // ── entry metadata ───────────────────────────────────────────────────────

  /**
   * Subtitle sidecars found so far, keyed by directory.
   *
   * Without this, describing one media file would `readdir` its directory, so a
   * 143-video scan would read the same directories 143 times — measured at
   * 3.3 seconds for one page of a real library, which the user feels as "刷视频
   * 半天不出来". The cache is dropped when the configuration changes and
   * bounded so a huge tree cannot retain unbounded entries.
   */
  const subtitleIndex = new Map()

  /**
   * Build (or reuse) the subtitle sidecar index for one directory.
   *
   * @param {string} dir - the absolute directory.
   * @returns {Promise<Map<string, {name: string}[]>>} media stem (lowercase) → tracks.
   */
  const subtitlesIn = async (dir) => {
    const cached = subtitleIndex.get(dir)
    if (cached !== undefined) return cached
    const index = new Map()
    let entries = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = extname(entry.name).toLowerCase()
      if (!SUBTITLE_EXTENSIONS.has(ext)) continue
      // `movie.srt` 挂在 `movie` 上；`movie.zh-CN.srt` 也挂在 `movie` 上。
      const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase()
      const base = stem.split(/[._-]/)[0]
      for (const key of new Set([stem, base])) {
        const list = index.get(key) ?? []
        list.push({ name: entry.name })
        index.set(key, list)
      }
    }
    for (const list of index.values()) list.sort((left, right) => left.name.localeCompare(right.name))
    // 上限保护：目录数量大的媒体库不至于把索引无限撑大。
    if (subtitleIndex.size > 512) subtitleIndex.clear()
    subtitleIndex.set(dir, index)
    return index
  }

  /**
   * Describe one file for the browser.
   *
   * @param {object} root - the owning root record.
   * @param {string} rel - the path relative to that root.
   * @param {{size: number, mtimeMs: number}} info - the file's stats.
   * @returns {Promise<object>} the client-facing entry.
   */
  const fileEntry = async (root, rel, info) => {
    const key = keyFor(root.index, rel)
    const kind = kindOf(rel)
    const out = {
      key,
      name: rel.split('/').pop() ?? rel,
      rel,
      root: root.index,
      kind,
      size: info.size,
      mtimeMs: info.mtimeMs,
      etag: etagOf(info.size, info.mtimeMs),
    }
    if (kind === 'video' || kind === 'audio') {
      out.streamUrl = `${BASE}/stream?k=${encodeURIComponent(key)}`
      const stem = (rel.split('/').pop() ?? '').replace(/\.[^.]+$/, '').toLowerCase()
      const index = await subtitlesIn(dirname(join(root.path, rel)))
      const tracks = index.get(stem) ?? index.get(stem.split(/[._-]/)[0]) ?? []
      if (tracks.length > 0) {
        const parentRel = rel.split('/').slice(0, -1).join('/')
        out.subtitles = tracks.map((track) => ({
          name: track.name,
          label: track.name.replace(/\.[^.]+$/, '').replace(/^[^.]*\.?/, '') || track.name,
          url: `${BASE}/subtitle?k=${encodeURIComponent(keyFor(root.index, parentRel === '' ? track.name : `${parentRel}/${track.name}`))}`,
        }))
      }
      if (ffmpegPath() !== null) {
        // 缓存后缀必须同时带上「文件改没改」和「生成配方改没改」。
        // 只用 mtime 时，改了取帧算法之后 URL 一个字都不变，而这条路由带
        // 24 小时浏览器缓存——浏览器不会重新请求，服务端重新生成也没人看得到。
        out.thumbUrl = `${BASE}/thumb?k=${encodeURIComponent(key)}&v=${RENDER_VERSION}-${Math.floor(info.mtimeMs)}`
      }
    } else if (kind === 'image' && ffmpegPath() !== null) {
      // 图片的缩略图走同一条 /thumb 路由（服务端缩小，网格不再直接吃原图）。
      out.thumbUrl = `${BASE}/thumb?k=${encodeURIComponent(key)}&v=${RENDER_VERSION}-${Math.floor(info.mtimeMs)}`
    }
    return out
  }

  // ── listing ──────────────────────────────────────────────────────────────

  /**
   * List one directory: subdirectories plus its media files, media newest first.
   *
   * @param {object} entryPoint - a resolved key.
   * @param {number} offset - page offset into the file list.
   * @returns {Promise<object>} the listing payload.
   */
  const listingOf = async (entryPoint, offset) => {
    const { root, abs, rel } = entryPoint
    const rows = await readDirectory(abs)
    const folders = rows.filter((row) => row.isDirectory)
    const files = rows.filter((row) => !row.isDirectory)
    folders.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }))
    files.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name))

    const folderEntries = folders.map((row) => ({
      key: keyFor(root.index, rel === '' ? row.name : `${rel}/${row.name}`),
      name: row.name,
      kind: 'directory',
      mtimeMs: row.mtimeMs,
      hidden: row.hidden,
    }))
    // 每个子文件夹的直接媒体数：分组视图用它跳过空文件夹，免得用户滚过
    // 一串「没有文件」的空卡。只 readdir 不 stat，一屏几十个文件夹也就几毫秒；
    // 子文件夹多到不正常（>400）时放弃计数，客户端保守地照常显示。
    if (folderEntries.length > 0 && folderEntries.length <= 400) {
      const tallies = await Promise.all(
        folderEntries.map((entry) => countMediaEntries(join(root.path, rel === '' ? entry.name : `${rel}/${entry.name}`))),
      )
      folderEntries.forEach((entry, index) => { entry.mediaCount = tallies[index].media })
    }
    const page = files.slice(offset, offset + LIST_PAGE)
    const fileEntries = []
    for (const row of page) {
      fileEntries.push(await fileEntry(root, rel === '' ? row.name : `${rel}/${row.name}`, row))
    }
    return {
      root: { index: root.index, path: root.path, label: root.label },
      rel,
      key: keyFor(root.index, rel),
      parent: rel === '' ? null : keyFor(root.index, rel.split('/').slice(0, -1).join('/')),
      // 面包屑的契约恒定：crumbs[0] 是根、最后一级是当前目录，任何层都不少于一级。
      crumbs: breadcrumbTrail(root, rel),
      folders: folderEntries,
      files: fileEntries,
      offset,
      nextOffset: offset + page.length < files.length ? offset + page.length : null,
      fileCount: files.length,
    }
  }

  /**
   * Breadcrumb trail from a root down to one directory.
   *
   * 恒以根开头、当前目录收尾——根自己（rel 为空）就是只有根一枚。rel 的
   * `split('/')` 在空串上会给出 `['']`，直接循环会多出一枚空名字的重复 crumb。
   *
   * @param {object} root - the root record.
   * @param {string} rel - the directory's relative path.
   * @returns {{key: string, name: string}[]} one crumb per level, root first.
   */
  const breadcrumbTrail = (root, rel) => {
    const crumbs = [{ key: keyFor(root.index, ''), name: root.label }]
    if (rel === '') return crumbs
    const parts = rel.split('/')
    for (let depth = 0; depth < parts.length; depth += 1) {
      crumbs.push({ key: keyFor(root.index, parts.slice(0, depth + 1).join('/')), name: parts[depth] })
    }
    return crumbs
  }

  /**
   * Recursively collect media for the swipe feed.
   *
   * Breadth-first under a hard entry ceiling, so a pathological tree yields a
   * truncated answer rather than an unbounded one.
   *
   * @param {object} entryPoint - a resolved key.
   * @param {{kinds?: string[], limit?: number, depth?: number}} options - scan bounds.
   * @returns {Promise<object>} the feed payload.
   */
  const scanOf = async (entryPoint, options) => {
    const { root, abs, rel } = entryPoint
    const startedAt = Date.now()
    const phase = { readdir: 0, entry: 0, dirs: 0 }
    const kinds = new Set(options.kinds ?? ['image', 'video'])
    const limit = Math.min(Math.max(options.limit ?? 400, 1), SCAN_HARD_LIMIT)
    const depthLimit = Math.min(Math.max(options.depth ?? 8, 1), 32)
    const ceiling = maxScan()
    const items = []
    const queue = [{ abs, rel, depth: 0 }]
    let scanned = 0
    /** Set when a bound stopped the walk before the tree was exhausted. */
    let truncated = false

    while (queue.length > 0) {
      const current = queue.shift()
      if (current.depth > depthLimit) continue
      let rows
      const readStart = Date.now()
      try {
        rows = await readDirectory(current.abs)
      } catch {
        continue
      }
      phase.readdir += Date.now() - readStart
      phase.dirs += 1
      for (const row of rows) {
        scanned += 1
        if (scanned > ceiling || items.length >= limit) {
          truncated = true
          break
        }
        const rowRel = current.rel === '' ? row.name : `${current.rel}/${row.name}`
        if (row.isDirectory) {
          if (!row.hidden) queue.push({ abs: join(current.abs, row.name), rel: rowRel, depth: current.depth + 1 })
          continue
        }
        if (!kinds.has(row.kind)) continue
        const entryStart = Date.now()
        items.push(await fileEntry(root, rowRel, { size: row.size, mtimeMs: row.mtimeMs }))
        phase.entry += Date.now() - entryStart
      }
      if (truncated) break
    }
    trace(
      'scanOf: total=%dms readdir=%dms(%d dirs) fileEntry=%dms(%d items) other=%dms',
      Date.now() - startedAt,
      phase.readdir,
      phase.dirs,
      phase.entry,
      items.length,
      Date.now() - startedAt - phase.readdir - phase.entry,
    )

    // Newest first gives the feed something worth watching at the top.
    items.sort((left, right) => right.mtimeMs - left.mtimeMs)
    return {
      root: { index: root.index, path: root.path, label: root.label },
      rel,
      key: keyFor(root.index, rel),
      items,
      scanned,
      truncated,
    }
  }

  /** The media files sharing one entry's directory, for feed navigation. */
  const siblingMedia = async (entryPoint) => {
    let rows
    try {
      rows = await readDirectory(dirname(entryPoint.abs))
    } catch {
      return []
    }
    const parentRel = entryPoint.rel.split('/').slice(0, -1).join('/')
    const out = []
    for (const row of rows) {
      if (row.isDirectory) continue
      if (row.kind !== 'image' && row.kind !== 'video' && row.kind !== 'audio') continue
      out.push(await fileEntry(entryPoint.root, parentRel === '' ? row.name : `${parentRel}/${row.name}`, row))
    }
    return out.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }))
  }

  // ── streaming ────────────────────────────────────────────────────────────

  /**
   * Answer one media request with full byte-range semantics.
   *
   * `206` plus an exact `Content-Range` is what makes seeking instant: the
   * browser names the byte window it needs and playback resumes there instead
   * of re-fetching the file from byte zero.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {object} entryPoint - a resolved key.
   * @param {boolean} download - true to force a download disposition.
   */
  const streamEntry = async (req, res, entryPoint, download) => {
    let info
    try {
      info = await stat(entryPoint.abs)
    } catch {
      sendError(res, 404, 'file not found')
      return
    }
    if (!info.isFile()) {
      sendError(res, 404, 'not a file')
      return
    }

    const etag = etagOf(info.size, info.mtimeMs)
    const lastModifiedMs = Math.floor(info.mtimeMs / 1000) * 1000
    res.setHeader('accept-ranges', 'bytes')
    res.setHeader('etag', etag)
    res.setHeader('last-modified', new Date(info.mtimeMs).toUTCString())
    res.setHeader('content-type', contentTypeOf(entryPoint.abs))
    res.setHeader('content-disposition', contentDisposition(basename(entryPoint.abs), download))
    res.setHeader('x-content-type-options', 'nosniff')
    // Revalidate, then answer 304: a replaced or re-encoded file is picked up
    // immediately, while a replay costs one empty round trip.
    res.setHeader('cache-control', 'private, max-age=0, must-revalidate')

    const ifNoneMatch = req.headers['if-none-match']
    const ifModifiedSince = req.headers['if-modified-since']
    const fresh =
      ifNoneMatch === etag ||
      (ifNoneMatch === undefined &&
        typeof ifModifiedSince === 'string' &&
        Number.isNaN(Date.parse(ifModifiedSince)) === false &&
        Date.parse(ifModifiedSince) >= lastModifiedMs)
    if (fresh) {
      res.statusCode = 304
      res.removeHeader('content-type')
      res.removeHeader('content-disposition')
      res.removeHeader('content-length')
      res.end()
      return
    }

    // A range request is honoured only while its validator still matches, which
    // is what stops a resumed download from stitching two file versions.
    const ifRange = req.headers['if-range']
    const rangeUsable =
      ifRange === undefined ||
      (typeof ifRange === 'string' &&
        (ifRange === etag || (Number.isNaN(Date.parse(ifRange)) === false && Date.parse(ifRange) >= lastModifiedMs)))

    const range = rangeUsable ? parseRange(req.headers.range, info.size) : null
    if (range === 'unsatisfiable') {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${info.size}`)
      res.setHeader('content-length', '0')
      res.end()
      return
    }

    const head = req.method === 'HEAD'
    if (range === null) {
      res.statusCode = 200
      res.setHeader('content-length', String(info.size))
      if (head || info.size === 0) {
        res.end()
        return
      }
      pipeRange(res, entryPoint.abs, 0, info.size - 1)
      return
    }

    res.statusCode = 206
    res.setHeader('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
    res.setHeader('content-length', String(range.end - range.start + 1))
    if (head) {
      res.end()
      return
    }
    pipeRange(res, entryPoint.abs, range.start, range.end)
  }

  /**
   * Pipe one byte window into the response with backpressure and abort handling.
   *
   * @param {import('node:http').ServerResponse} res - the response.
   * @param {string} abs - the absolute file path.
   * @param {number} start - the first byte.
   * @param {number} end - the last byte, inclusive.
   */
  const pipeRange = (res, abs, start, end) => {
    const stream = streamRange(abs, start, end)
    const cleanup = () => stream.destroy()
    res.on('close', cleanup)
    stream.on('error', (error) => {
      log.warn('stream failed for %s: %s', abs, error.message)
      stream.destroy()
      res.destroy()
    })
    res.on('finish', () => res.off('close', cleanup))
    // `pipe` honours the socket's write buffer, so a slow client throttles the
    // file read instead of the whole video landing in memory.
    stream.pipe(res)
  }

  // ── poster frames ────────────────────────────────────────────────────────

  /**
   * Cached answer to "is there an ffmpeg on this host?".
   *
   * `undefined` = not probed yet. The probe walks every PATH entry, which costs
   * ~20ms on a machine with a large PATH — and `fileEntry` asks this question
   * once per media file, so a 143-file scan was spending 3 of its 3.1 seconds
   * re-answering it. It only has to be answered once per process (or once after
   * the configuration changes, since the answer can be configured).
   */
  let ffmpegProbe

  /** Configured ffmpeg, or `ffmpeg` when it is on PATH; otherwise no posters. */
  const ffmpegPath = () => {
    const configured = config().ffmpegPath
    if (configured !== undefined) return configured
    if (ffmpegProbe === undefined) ffmpegProbe = findFfmpeg()
    return ffmpegProbe
  }

  /** In-flight render jobs, keyed by cache file. */
  const thumbJobs = new Map()

  /**
   * Where the middle of a file is, in seconds.
   *
   * Shared by the poster and the hover animation. Both must land in the middle:
   * the opening seconds of a clip are very often black, a logo, or a title
   * card, which would make every tile look identical. Falls back to 0 when
   * ffprobe cannot answer (a live stream, or no ffprobe installed).
   *
   * @param {string} abs - the media file.
   * @returns {Promise<number>} seconds to seek to before reading.
   */
  const middleOffset = async (abs) => {
    const meta = await probeMedia(abs)
    const duration = meta?.duration
    return Number.isFinite(duration) && duration > 2 ? duration / 2 : 0
  }
  /** How many ffmpeg processes are decoding right now. */
  let thumbsRunning = 0
  /** Render requests waiting for a free slot, oldest first. */
  const thumbQueue = []

  /**
   * Find an ffmpeg executable.
   *
   * PATH alone is not enough on Windows: `winget install ffmpeg` puts a shim in
   * `%LOCALAPPDATA%\Microsoft\WinGet\Links` (and the real binary under
   * `WinGet\Packages\...`), and that Links directory is frequently missing from
   * a process's PATH — which is exactly the machine this was written on. Scoop
   * and Chocolatey layouts are checked for the same reason. The answer is
   * cached per process because probing is not cheap.
   *
   * @returns {string|null} the executable to run, or null when none is found.
   */
  function findFfmpeg() {
    if (hasOnPath('ffmpeg')) return 'ffmpeg'
    if (process.platform !== 'win32') {
      for (const candidate of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
        try {
          if (statSync(candidate).isFile()) return candidate
        } catch {
          /* not there */
        }
      }
      return null
    }
    const local = process.env.LOCALAPPDATA ?? ''
    const roaming = process.env.APPDATA ?? ''
    const home = process.env.USERPROFILE ?? ''
    const direct = [
      join(local, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(roaming, '..', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(home, 'scoop', 'shims', 'ffmpeg.exe'),
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin', 'ffmpeg.exe'),
      join(local, 'Programs', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    ]
    for (const candidate of direct) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch {
        /* not there */
      }
    }
    // WinGet 把真实二进制放在 Packages 下一层带哈希的目录里，版本号会变，
    // 所以扫一层而不是写死路径。
    try {
      const packages = join(local, 'Microsoft', 'WinGet', 'Packages')
      for (const entry of readdirSync(packages)) {
        if (!entry.toLowerCase().includes('ffmpeg')) continue
        const bin = join(packages, entry)
        for (const inner of readdirSync(bin)) {
          const candidate = join(bin, inner, 'bin', 'ffmpeg.exe')
          try {
            if (statSync(candidate).isFile()) return candidate
          } catch {
            /* keep looking */
          }
        }
      }
    } catch {
      /* no WinGet packages directory */
    }
    return null
  }

  /** Probe whether one executable resolves on this host's PATH. */
  function hasOnPath(binary) {
    const pathValue = process.env.PATH ?? ''
    const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
    for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
      if (dir === '') continue
      for (const ext of exts) {
        try {
          if (existsSync(join(dir, binary + ext))) return true
        } catch {
          /* unreadable PATH entry */
        }
      }
    }
    return false
  }

  // ── metadata probe ───────────────────────────────────────────────────────

  /**
   * The ffprobe next to the resolved ffmpeg, when there is one.
   *
   * ffmpeg ships the pair, so the sibling path is the reliable answer; only if
   * that is missing do we go looking on PATH.
   *
   * @returns {string|null} the executable, or null.
   */
  const ffprobePath = () => {
    const ffmpeg = ffmpegPath()
    if (ffmpeg === null) return null
    if (ffmpeg !== 'ffmpeg') {
      const sibling = join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
      try {
        if (statSync(sibling).isFile()) return sibling
      } catch {
        /* fall through to PATH */
      }
    }
    return hasOnPath('ffprobe') ? 'ffprobe' : null
  }

  /** Probe results, keyed by path + size + mtime. */
  const probeCache = new Map()
  /** How many ffprobe processes are running. */
  let probesRunning = 0
  /** Probe requests waiting for a free slot. */
  const probeQueue = []

  /**
   * Read duration and dimensions with ffprobe.
   *
   * The browser can report these too, but only for containers it can open —
   * an MKV gives nothing — and asking ffprobe is one short read of the header
   * rather than a range request per file. Results are cached for the life of
   * the process, keyed by size + mtime so an edited file re-probes.
   *
   * @param {string} abs - the media file's absolute path.
   * @returns {Promise<{duration?: number, width?: number, height?: number}|null>} the metadata.
   */
  const probeMedia = async (abs) => {
    const binary = ffprobePath()
    if (binary === null) return null
    let info
    try {
      info = await stat(abs)
    } catch {
      return null
    }
    const cacheKey = `${abs}\0${info.size}\0${info.mtimeMs}`
    const cached = probeCache.get(cacheKey)
    if (cached !== undefined) return cached
    const run = () =>
      new Promise((settle) => {
        const child = spawn(
          binary,
          ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'json', abs],
          { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
        )
        let out = ''
        const done = (value) => {
          clearTimeout(timer)
          settle(value)
        }
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          done(null)
        }, FFMPEG_TIMEOUT_MS)
        child.stdout?.on('data', (chunk) => {
          out += chunk
          if (out.length > 1 << 20) child.kill('SIGKILL')
        })
        child.on('error', () => done(null))
        child.on('close', () => {
          try {
            const parsed = JSON.parse(out)
            const stream = parsed.streams?.[0] ?? {}
            const duration = Number(parsed.format?.duration)
            const result = {
              ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
              ...(Number.isFinite(stream.width) && stream.width > 0 ? { width: stream.width, height: stream.height } : {}),
            }
            done(Object.keys(result).length === 0 ? null : result)
          } catch {
            done(null)
          }
        })
      })
    // 和缩略图同样的理由：ffprobe 要打开文件，并发太多会让磁盘成为瓶颈。
    const result = await new Promise((settle) => {
      const start = () => {
        probesRunning += 1
        run()
          .then(settle, () => settle(null))
          .finally(() => {
            probesRunning -= 1
            const next = probeQueue.shift()
            if (next !== undefined) next()
          })
      }
      if (probesRunning < PROBE_CONCURRENCY) start()
      else probeQueue.push(start)
    })
    // 上限保护，媒体库很大时不至于把结果无限留存在内存里。
    if (probeCache.size > 4000) probeCache.clear()
    probeCache.set(cacheKey, result)
    return result
  }

  /**
   * Run one render job once a slot frees up.
   *
   * A grid can ask for a hundred posters at once; ffmpeg is CPU-heavy and each
   * process decodes video, so unbounded parallelism would peg every core and
   * make the page slower, not faster. Three at a time keeps the queue moving
   * while leaving the machine usable.
   *
   * @param {() => Promise<Buffer|null>} job - the render.
   * @returns {Promise<Buffer|null>} the render's result.
   */
  const withThumbSlot = (job) => {
    if (thumbsRunning < THUMB_CONCURRENCY) {
      thumbsRunning += 1
      return job().finally(() => {
        thumbsRunning -= 1
        const next = thumbQueue.shift()
        if (next !== undefined) next()
      })
    }
    return new Promise((settle) => {
      thumbQueue.push(() => {
        thumbsRunning += 1
        job()
          .then(settle, () => settle(null))
          .finally(() => {
            thumbsRunning -= 1
            const next = thumbQueue.shift()
            if (next !== undefined) next()
          })
      })
    })
  }

  /**
   * Render (or reuse) a poster frame for one video.
   *
   * The frame is taken from the MIDDLE of the video (`thumbnail` filter), not
   * from the first second: the opening frame of a clip is very often black, a
   * logo, or a title card, which makes every tile in the grid look the same.
   * One frame per file also keeps the cost flat regardless of duration.
   *
   * Cached by absolute path + mtime + size under the OS temp directory, so a
   * second look is one `readFile` and the user's media tree is never written to.
   *
   * @param {object} entryPoint - a resolved key.
   * @returns {Promise<Buffer|null>} JPEG bytes, or null when unavailable.
   */
  const thumbnailFor = async (entryPoint) => {
    const binary = ffmpegPath()
    if (binary === null) return null
    let info
    try {
      info = await stat(entryPoint.abs)
    } catch {
      return null
    }
    if (!info.isFile()) return null
    const hash = createHash('sha1').update(`${RENDER_VERSION}\0${entryPoint.abs}\0${info.size}\0${info.mtimeMs}`).digest('hex')
    const dir = cacheDir()
    const cacheFile = join(dir, `${hash}.jpg`)
    const missFile = join(dir, `${hash}.miss`)
    try {
      return await readFile(cacheFile)
    } catch {
      /* not cached yet */
    }
    // 失败也记一笔：一个解不开的文件不该在每次滚动时反复重试 20 秒。
    try {
      const miss = statSync(missFile)
      if (Date.now() - miss.mtimeMs < MISS_TTL_MS) return null
    } catch {
      /* 没失败过 */
    }
    const pending = thumbJobs.get(cacheFile)
    if (pending !== undefined) return pending
    const job = withThumbSlot(async () => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        return null
      }
      const scratch = join(dir, `${hash}.${process.pid}.part.jpg`)
      const offset = await middleOffset(entryPoint.abs)
      const ok = await runFfmpeg(binary, [
        '-hide_banner',
        '-loglevel', 'error',
        // 输入侧快速定位到中间附近（不解码前面的内容），再由 `thumbnail`
        // 在附近挑最有代表性的一帧。两者都不落在开头——开头的黑屏/台标/
        // 标题卡会让整个网格长得一模一样。
        ...(offset > 0 ? ['-ss', offset.toFixed(2)] : []),
        '-i', entryPoint.abs,
        '-vf', `thumbnail,scale=${THUMB_WIDTH}:-2:flags=bilinear`,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'image2',
        '-y', scratch,
      ])
      if (!ok) {
        rmSync(scratch, { force: true })
        try {
          writeFileSync(missFile, '')
        } catch {
          /* 记不住就算了 */
        }
        return null
      }
      try {
        const bytes = await readFile(scratch)
        await writeFile(cacheFile, bytes)
        rmSync(missFile, { force: true })
        return bytes
      } catch {
        return null
      } finally {
        rmSync(scratch, { force: true })
      }
    })
    thumbJobs.set(cacheFile, job)
    return job.finally(() => thumbJobs.delete(cacheFile))
  }

  /**
   * Downscale one IMAGE file to a poster JPEG — the image twin of
   * {@link thumbnailFor}, sharing its cache directory, concurrency slot, and
   * miss bookkeeping. The hash carries an `img` prefix so an image and a video
   * at the same path can never collide in the cache.
   *
   * Small images are never upscaled (`min(480,iw)`); EXIF rotation is applied
   * by ffmpeg itself (autorotate defaults on).
   *
   * @param {object} entryPoint - a resolved key.
   * @returns {Promise<Buffer|null>} JPEG bytes, or null when unavailable.
   */
  const imageThumbFor = async (entryPoint) => {
    const binary = ffmpegPath()
    if (binary === null) return null
    let info
    try {
      info = await stat(entryPoint.abs)
    } catch {
      return null
    }
    if (!info.isFile()) return null
    const hash = createHash('sha1').update(`img\0${RENDER_VERSION}\0${entryPoint.abs}\0${info.size}\0${info.mtimeMs}`).digest('hex')
    const dir = cacheDir()
    const cacheFile = join(dir, `${hash}.jpg`)
    const missFile = join(dir, `${hash}.miss`)
    try {
      return await readFile(cacheFile)
    } catch {
      /* not cached yet */
    }
    try {
      const miss = statSync(missFile)
      if (Date.now() - miss.mtimeMs < MISS_TTL_MS) return null
    } catch {
      /* 没失败过 */
    }
    const pending = thumbJobs.get(cacheFile)
    if (pending !== undefined) return pending
    const job = withThumbSlot(async () => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        return null
      }
      const scratch = join(dir, `${hash}.${process.pid}.part.jpg`)
      const ok = await runFfmpeg(binary, [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', entryPoint.abs,
        // 小图不放大：目标宽取 480 和原图宽的较小者。
        '-vf', `scale='min(${THUMB_WIDTH},iw)':-2:flags=bilinear`,
        '-frames:v', '1',
        '-q:v', '4',
        '-f', 'image2',
        '-y', scratch,
      ])
      if (!ok) {
        rmSync(scratch, { force: true })
        try {
          writeFileSync(missFile, '')
        } catch {
          /* 记不住就算了 */
        }
        return null
      }
      try {
        const bytes = await readFile(scratch)
        await writeFile(cacheFile, bytes)
        rmSync(missFile, { force: true })
        return bytes
      } catch {
        return null
      } finally {
        rmSync(scratch, { force: true })
      }
    })
    thumbJobs.set(cacheFile, job)
    return job.finally(() => thumbJobs.delete(cacheFile))
  }

  /** In-flight hover-animation jobs, keyed by cache file. */
  const previewJobs = new Map()

  /**
   * Render (or reuse) a short silent clip from the MIDDLE of a video.
   *
   * This is what plays when the pointer rests on a tile. A few seconds of
   * motion tells you what a video is far better than any single frame, and
   * because it starts in the middle it never shows the opening title card.
   *
   * Encoded as VP9/WebM: no audio track at all (so there is nothing to mute and
   * nothing to download), and the codec plays in every current browser. It is
   * generated only when a pointer actually rests on a tile — never during a
   * scan — and shares the poster's queue so a wall of hovers cannot start a
   * wall of ffmpeg processes.
   *
   * @param {object} entryPoint - a resolved key.
   * @returns {Promise<Buffer|null>} WebM bytes, or null when unavailable.
   */
  const previewFor = async (entryPoint) => {
    const binary = ffmpegPath()
    if (binary === null) return null
    let info
    try {
      info = await stat(entryPoint.abs)
    } catch {
      return null
    }
    if (!info.isFile()) return null
    const hash = createHash('sha1').update(`${RENDER_VERSION}\0${entryPoint.abs}\0${info.size}\0${info.mtimeMs}`).digest('hex')
    const dir = cacheDir()
    const cacheFile = join(dir, `${hash}.webm`)
    const missFile = join(dir, `${hash}.preview-miss`)
    try {
      return await readFile(cacheFile)
    } catch {
      /* not cached yet */
    }
    try {
      const miss = statSync(missFile)
      if (Date.now() - miss.mtimeMs < MISS_TTL_MS) return null
    } catch {
      /* 没失败过 */
    }
    const pending = previewJobs.get(cacheFile)
    if (pending !== undefined) return pending
    const job = withThumbSlot(async () => {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        return null
      }
      const scratch = join(dir, `${hash}.${process.pid}.part.webm`)
      const offset = await middleOffset(entryPoint.abs)
      const ok = await runFfmpeg(binary, [
        '-hide_banner',
        '-loglevel', 'error',
        ...(offset > 0 ? ['-ss', offset.toFixed(2)] : []),
        '-i', entryPoint.abs,
        '-t', String(PREVIEW_SECONDS),
        '-an',
        '-vf', `scale=${PREVIEW_WIDTH}:-2:flags=bilinear,fps=${PREVIEW_FPS}`,
        '-c:v', 'libvpx-vp9',
        '-b:v', '0',
        '-crf', '40',
        '-deadline', 'realtime',
        '-cpu-used', '5',
        '-pix_fmt', 'yuv420p',
        '-f', 'webm',
        '-y', scratch,
      ])
      if (!ok) {
        rmSync(scratch, { force: true })
        try {
          writeFileSync(missFile, '')
        } catch {
          /* 记不住就算了 */
        }
        return null
      }
      try {
        const bytes = await readFile(scratch)
        await writeFile(cacheFile, bytes)
        rmSync(missFile, { force: true })
        return bytes
      } catch {
        return null
      } finally {
        rmSync(scratch, { force: true })
      }
    })
    previewJobs.set(cacheFile, job)
    return job.finally(() => previewJobs.delete(cacheFile))
  }

  /**
   * Run ffmpeg under a deadline, discarding its output.
   *
   * @param {string} binary - the executable.
   * @param {string[]} args - its arguments.
   * @returns {Promise<boolean>} whether it exited zero in time.
   */
  const runFfmpeg = (binary, args) =>
    new Promise((settle) => {
      let child
      try {
        child = spawn(binary, args, { stdio: 'ignore', windowsHide: true })
      } catch {
        settle(false)
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(false)
      }, FFMPEG_TIMEOUT_MS)
      child.on('error', () => {
        clearTimeout(timer)
        settle(false)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        settle(code === 0)
      })
    })

  // ── request policy ───────────────────────────────────────────────────────

  /**
   * Screen one request before any filesystem work happens.
   *
   * Loopback is always allowed. A non-loopback browser is allowed only when
   * the composition's own browser-trust fence accepts it — the same fence that
   * guards `/api` — so the viewer cannot become a hole in a LAN-bound dsh.
   * Without that service, a non-loopback request must at least be same-origin,
   * unless the user turned the check off.
   *
   * @param {import('node:http').IncomingMessage} req - the request.
   * @returns {number|undefined} a status to refuse with, or undefined to proceed.
   */
  const rejection = (req) => {
    if (!config().requireTrustedRequest) return undefined
    if (isLoopback(req.socket?.remoteAddress)) return undefined
    const connection = ctx.get('connection')
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        const verdict = connection.requestRejection(req)
        return verdict === undefined || verdict === null ? undefined : verdict
      } catch {
        return 403
      }
    }
    const host = req.headers.host
    if (typeof host === 'string') {
      for (const header of [req.headers.origin, req.headers.referer]) {
        if (typeof header !== 'string') continue
        try {
          if (new URL(header).host === host) return undefined
        } catch {
          /* malformed header */
        }
      }
    }
    return 403
  }

  // ── routes ───────────────────────────────────────────────────────────────

  /**
   * Wrap a handler with the request policy and a contained failure boundary.
   *
   * @param {(req: object, res: object) => Promise<void>} handler - the route body.
   * @returns {(req: object, res: object) => Promise<void>} the guarded handler.
   */
  const guarded = (handler) => async (req, res) => {
    const verdict = rejection(req)
    if (verdict !== undefined) {
      res.statusCode = verdict
      res.setHeader('content-length', '0')
      res.end()
      return
    }
    try {
      await handler(req, res)
    } catch (error) {
      log.warn('route %s failed: %s', req.url, error?.message ?? error)
      if (!res.headersSent) sendError(res, 500, 'internal error')
      else res.destroy()
    }
  }

  /**
   * The HTTP carrier.
   *
   * Read through `ctx.get` rather than the `ctx.webServer` proxy accessor on
   * purpose: this plugin's handlers run inside this body, where the accessor
   * works because `inject` is declared, but a caller that mounted the row
   * without that declaration would otherwise fail at the first request with
   * "cannot get property without inject". `ctx.get` reports absence honestly
   * and lets the composition error below name the real problem.
   */
  const webServer = () => ctx.get('webServer')

  /**
   * Register one route as a fiber effect, so unloading the plugin unregisters it.
   *
   * @param {object} routeSpec - the `webServer.register` argument.
   * @param {string} label - the effect label in cordis diagnostics.
   */
  const route = (routeSpec, label) => {
    ctx.effect(() => webServer().register(routeSpec), `reel: ${label}`)
    trace('route registered: %s', label)
  }

  /** Parse the request URL against the request's own Host. */
  const urlOf = (req) => new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  /** Content type for one asset file name. */
  const assetType = (file) => {
    const ext = extname(file).toLowerCase()
    if (ext === '.js' || ext === '.mjs') return 'text/javascript; charset=utf-8'
    if (ext === '.css') return 'text/css; charset=utf-8'
    if (ext === '.html') return 'text/html; charset=utf-8'
    if (ext === '.svg') return 'image/svg+xml'
    if (ext === '.png') return 'image/png'
    if (ext === '.json') return 'application/json; charset=utf-8'
    if (ext === '.woff2') return 'font/woff2'
    return 'application/octet-stream'
  }

  /** Serve one file out of the plugin's asset directory. */
  const sendAsset = async (req, res, file, type) => {
    let info
    try {
      info = await stat(join(ASSETS, file))
    } catch {
      sendError(res, 404, 'asset not found')
      return
    }
    if (!info.isFile()) {
      sendError(res, 404, 'asset not found')
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', type)
    res.setHeader('content-length', String(info.size))
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('x-content-type-options', 'nosniff')
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    pipeRange(res, join(ASSETS, file), 0, info.size - 1)
  }

  // The viewer page.
  route(
    {
      kind: 'exact',
      path: BASE,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        await sendAsset(req, res, 'index.html', 'text/html; charset=utf-8')
      }),
    },
    `GET ${BASE}`,
  )

  // Static assets. The webserver tries its exact table before the prefix
  // table, so every `/api/...` route below still wins over this one.
  route(
    {
      kind: 'prefix',
      path: BASE,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const rest = urlOf(req).pathname.slice(BASE.length).replace(/^\//, '')
        if (rest === '' || rest.includes('..') || rest.includes('/') || rest.includes('\\')) {
          sendError(res, 404, 'not found')
          return
        }
        await sendAsset(req, res, rest, assetType(rest))
      }),
    },
    `GET ${BASE}/*`,
  )

  // GET /reel/api/session — roots, capabilities, and settings state.
  route(
    {
      kind: 'exact',
      path: `${BASE}/api/session`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        sendJson(res, 200, {
          version: '0.1.0',
          base: BASE,
          roots: roots(),
          writable: settingsScope !== null,
          revision: settingsRevision,
          platform: process.platform,
          home: homedir(),
          dshHome: dshHome(),
          capabilities: {
            thumbnails: ffmpegPath() !== null,
            ffmpeg: ffmpegPath(),
            probing: ffprobePath() !== null,
            previews: ffmpegPath() !== null,
            previewSeconds: PREVIEW_SECONDS,
            // 客户端拿它给帖子/预览的 URL 加版本后缀。必须暴露出去：这两条路由
            // 带 24 小时浏览器缓存，而 URL 里没有版本号时，服务端就算重新生成了
            // 图，浏览器也只会交出自己那份旧副本，**一个请求都不会发**。于是
            // 「清了服务端缓存 + 刷新页面」看不到任何变化。
            renderVersion: RENDER_VERSION,
          },
        })
      }),
    },
    `GET ${BASE}/api/session`,
  )

  // GET /reel/api/list?k=<key>&offset=<n> — one directory level.
  route(
    {
      kind: 'exact',
      path: `${BASE}/api/list`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        const url = urlOf(req)
        const entryPoint = await resolveKey(normalizeKey(url.searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'unknown or unavailable directory')
          return
        }
        const info = await stat(entryPoint.abs).catch(() => null)
        if (info === null || !info.isDirectory()) {
          sendError(res, 404, 'not a directory')
          return
        }
        const offset = Math.max(Number(url.searchParams.get('offset') ?? '0') || 0, 0)
        sendJson(res, 200, await listingOf(entryPoint, offset))
      }),
    },
    `GET ${BASE}/api/list`,
  )

  // GET /reel/api/scan?k=<key>&kinds=&limit=&depth= — recursive media.
  route(
    {
      kind: 'exact',
      path: `${BASE}/api/scan`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        const url = urlOf(req)
        const entryPoint = await resolveKey(normalizeKey(url.searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'unknown or unavailable directory')
          return
        }
        const kinds = (url.searchParams.get('kinds') ?? 'image,video')
          .split(',')
          .map((kind) => kind.trim())
          .filter((kind) => kind === 'image' || kind === 'video' || kind === 'audio')
        sendJson(
          res,
          200,
          await scanOf(entryPoint, {
            kinds,
            limit: Number(url.searchParams.get('limit') ?? '') || undefined,
            depth: Number(url.searchParams.get('depth') ?? '') || undefined,
          }),
        )
      }),
    },
    `GET ${BASE}/api/scan`,
  )

  // POST /reel/api/probe — duration and dimensions for a batch of keys.
  //
  // 客户端只对「正在视野里」的卡片问这一批，所以首屏列表不必为几百个文件
  // 付出 ffprobe 的代价，而需要时又能拿到浏览器给不出的信息（打不开的
  // 容器，例如 MKV）。
  route(
    {
      kind: 'exact',
      path: `${BASE}/api/probe`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'POST') return sendMethodNotAllowed(res, 'POST')
        const body = await readJsonBody(req, 64 * 1024)
        const keys = Array.isArray(body?.keys) ? body.keys.filter((key) => typeof key === 'string').slice(0, 200) : []
        if (keys.length === 0) {
          sendError(res, 400, 'body must be {"keys": ["r0/...", ...]} (max 200)')
          return
        }
        const results = {}
        await Promise.all(
          keys.map(async (key) => {
            const entryPoint = await resolveKey(normalizeKey(key))
            if (entryPoint === null) return
            const kind = kindOf(entryPoint.abs)
            if (kind !== 'video' && kind !== 'audio') return
            const meta = await probeMedia(entryPoint.abs)
            if (meta !== null) results[key] = meta
          }),
        )
        sendJson(res, 200, {
          results,
          probeAvailable: ffprobePath() !== null,
          thumbnailsAvailable: ffmpegPath() !== null,
        })
      }),
    },
    `POST ${BASE}/api/probe`,
  )

  // GET /reel/preview?k=<key> — a short clip from the middle, for hover.
  route(
    {
      kind: 'exact',
      path: `${BASE}/preview`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        const bytes = await previewFor(entryPoint)
        if (bytes === null) {
          sendError(res, 503, 'no hover preview available')
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'video/webm')
        res.setHeader('content-length', String(bytes.byteLength))
        // 体积小且不可变（缓存键含 mtime+size），可以放心让浏览器长期留着。
        res.setHeader('cache-control', 'private, max-age=86400, immutable')
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(bytes)
      }),
    },
    `GET ${BASE}/preview`,
  )

  // GET /reel/api/stat?k=<key> — one file's details plus its siblings.
  route(
    {
      kind: 'exact',
      path: `${BASE}/api/stat`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET') return sendMethodNotAllowed(res, 'GET')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        const info = await stat(entryPoint.abs).catch(() => null)
        if (info === null || !info.isFile()) {
          sendError(res, 404, 'not found')
          return
        }
        sendJson(res, 200, {
          entry: await fileEntry(entryPoint.root, entryPoint.rel, info),
          siblings: await siblingMedia(entryPoint),
        })
      }),
    },
    `GET ${BASE}/api/stat`,
  )

  // GET /reel/stream?k=<key> — the range-streaming media endpoint.
  route(
    {
      kind: 'exact',
      path: `${BASE}/stream`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        await streamEntry(req, res, entryPoint, urlOf(req).searchParams.get('dl') === '1')
      }),
    },
    `GET ${BASE}/stream`,
  )

  // GET /reel/download?k=<key> — the same bytes as an attachment.
  route(
    {
      kind: 'exact',
      path: `${BASE}/download`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        await streamEntry(req, res, entryPoint, true)
      }),
    },
    `GET ${BASE}/download`,
  )

  // GET /reel/thumb?k=<key> — a cached ffmpeg poster frame.
  route(
    {
      kind: 'exact',
      path: `${BASE}/thumb`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        const bytes = kindOf(entryPoint.rel) === 'image'
          ? await imageThumbFor(entryPoint)
          : await thumbnailFor(entryPoint)
        if (bytes === null) {
          sendError(res, 503, 'no poster frame available')
          return
        }
        res.statusCode = 200
        res.setHeader('content-type', 'image/jpeg')
        res.setHeader('content-length', String(bytes.byteLength))
        res.setHeader('cache-control', 'private, max-age=86400')
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(bytes)
      }),
    },
    `GET ${BASE}/thumb`,
  )

  // GET /reel/subtitle?k=<key> — a sidecar track converted to WebVTT.
  route(
    {
      kind: 'exact',
      path: `${BASE}/subtitle`,
      handler: guarded(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendMethodNotAllowed(res, 'GET, HEAD')
        const entryPoint = await resolveKey(normalizeKey(urlOf(req).searchParams.get('k')))
        if (entryPoint === null) {
          sendError(res, 404, 'not found')
          return
        }
        if (kindOf(entryPoint.abs) !== 'subtitle') {
          sendError(res, 415, 'not a subtitle file')
          return
        }
        let body
        try {
          body = toWebVtt(readFileSync(entryPoint.abs, 'utf8'), entryPoint.abs)
        } catch {
          sendError(res, 500, 'cannot read subtitle')
          return
        }
        const buffer = Buffer.from(body, 'utf8')
        res.statusCode = 200
        res.setHeader('content-type', 'text/vtt; charset=utf-8')
        res.setHeader('content-length', String(buffer.byteLength))
        res.setHeader('cache-control', 'no-cache')
        if (req.method === 'HEAD') {
          res.end()
          return
        }
        res.end(buffer)
      }),
    },
    `GET ${BASE}/subtitle`,
  )

  // ── settings attachment ──────────────────────────────────────────────────

  /**
   * Bind the `reel` settings namespace when the composition has a
   * settings provider.
   *
   * `installSection` is the optional-service path, and the composition entry is
   * passed as the section BASE — not as a hand-merged fallback. That ordering is
   * the whole point: `roots` resolves as schema default → this row's config →
   * the user's `settings.yaml` section, so a user who configured directories in
   * `cordis.patch.yml` keeps them, and the in-page editor writes the layer above
   * rather than replacing it. Merging the two by hand would let the namespace's
   * empty default shadow the row and silently ignore a hand-written config.
   *
   * When no provider is present nothing is registered and the plugin runs on
   * its entry config alone, unchanged.
   */
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    /** The composition entry, used as the namespace's base layer and fallback. */
    const entrySection = {
      roots: Array.isArray(entry.roots) ? entry.roots : [],
      ...(typeof entry.cacheDir === 'string' && entry.cacheDir.trim() !== '' ? { cacheDir: entry.cacheDir.trim() } : {}),
    }
    /**
     * The live configuration source. `setSource` hands over a THUNK that
     * re-resolves the namespace on every call, so the plugin must keep the
     * thunk itself — calling it once and caching the result would freeze the
     * configuration at whatever it was during installation and every later
     * edit would appear to do nothing.
     */
    let readSection = () => entrySection
    settings.installSection(settingsCtx, NAMESPACE, rootsSchema(), entrySection, {
      setSource: (next) => {
        readSection = next
        source = () => readSection()
      },
      onChange: () => {
        settingsRevision += 1
        // 配置变了就丢掉派生缓存：字幕索引按目录缓存、ffmpeg 探测结果可能
        // 因为 ffmpegPath 被改而不同。cacheDir 不持有进程内状态（缓存文件按
        // 内容哈希命名，换目录只是下一次重新生成），但落点值得提醒。
        subtitleIndex.clear()
        ffmpegProbe = undefined
        warnCacheInsideRoot()
        const list = readSection()?.roots
        log.info('directories changed: %s', Array.isArray(list) && list.length > 0 ? list.join(', ') : '(none)')
      },
      validate: (value) => {
        if (!Array.isArray(value?.roots)) throw new Error('roots must be an array of directory paths')
        if (value?.cacheDir !== undefined && typeof value.cacheDir !== 'string') throw new Error('cacheDir must be a string')
      },
    })
    settingsScope = {
      update: (patch) => settings.update(NAMESPACE, patch),
      get: () => settings.get(NAMESPACE),
    }
    log.info('settings namespace %s registered; directories are editable from Settings → Plugins', NAMESPACE)
    return () => {
      settingsScope = null
      source = () => entry
    }
  })

  /**
   * The namespace schema, shaped for the settings provider's schema contract:
   * a callable resolver carrying `type`/`dict`/`inner` (what redaction walks)
   * and `toJSON()` (what a configuration surface serializes).
   *
   * Hand-rolling it keeps the plugin dependency-free. The envelope below is
   * byte-for-byte what schemastery emits for
   * `z.object({ roots: z.array(z.string()).default([]), cacheDir: z.string() })`
   * — children referenced by uid NUMBER, because that is the shape the
   * browser-side rehydrate wires back through `refs[uid]`; nested objects here
   * silently degrade instead of erroring.
   *
   * @returns {Function} the schema resolver.
   */
  function rootsSchema() {
    const refs = {
      0: { type: 'string', meta: {} },
      2: { type: 'array', meta: { default: [] }, inner: 0 },
      3: { type: 'string', meta: {} },
      4: { type: 'object', meta: { default: {} }, dict: { roots: 2, cacheDir: 3 } },
    }
    const schema = (value) => {
      const raw = value === undefined || value === null ? {} : value
      const list = raw.roots === undefined ? [] : raw.roots
      if (!Array.isArray(list)) throw new TypeError('$.roots expected an array of directory paths')
      const out = {}
      for (const [key, item] of Object.entries(raw)) {
        if (key === 'roots' || key === 'cacheDir') continue
        out[key] = item
      }
      out.roots = list.map((item) => {
        if (typeof item !== 'string') throw new TypeError('$.roots expected an array of directory paths')
        return item
      })
      if (raw.cacheDir !== undefined && raw.cacheDir !== null) {
        if (typeof raw.cacheDir !== 'string') throw new TypeError('$.cacheDir expected a string')
        if (raw.cacheDir.trim() !== '') out.cacheDir = raw.cacheDir
      }
      return out
    }
    schema.type = 'object'
    schema.dict = { roots: 2, cacheDir: 3 }
    schema.meta = { default: {} }
    schema.toJSON = () => ({ uid: 4, refs })
    return schema
  }

  // ── readiness line ───────────────────────────────────────────────────────

  ctx.on('internal/ready', () => {
    warnCacheInsideRoot()
    const list = roots()
    const port = webServer()?.port ?? 3080
    if (list.length === 0) {
      log.info('ready at http://127.0.0.1:%s%s — no directory configured yet; open it and add one', port, BASE)
      return
    }
    log.info('ready at http://127.0.0.1:%s%s — %s', port, BASE, list.map((root) => root.path).join(', '))
  })
}

export default apply
