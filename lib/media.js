/**
 * Path resolution, media typing, and byte-range plumbing for dsh-reel.
 *
 * Everything in here is deliberately dependency-free Node built-ins: the
 * plugin must load inside the dsh host process without adding a single package
 * to the profile's dependency tree.
 *
 * @module dsh-reel/lib/media
 */
import { createReadStream } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Image extensions the browser can render directly. */
const IMAGE_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.jpe', 'image/jpeg'],
  ['.jfif', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.apng', 'image/apng'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.ico', 'image/x-icon'],
  ['.svg', 'image/svg+xml'],
  ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.jxl', 'image/jxl'],
])

/**
 * Video extensions. The MIME value is what the host advertises; whether a
 * given browser can decode it is the client's business, and the viewer probes
 * with `canPlayType`/`MediaSource` before offering a `<video>` element.
 */
const VIDEO_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mp4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
  ['.wmv', 'video/x-ms-wmv'],
  ['.flv', 'video/x-flv'],
  ['.ts', 'video/mp2t'],
  ['.m2ts', 'video/mp2t'],
  ['.mts', 'video/mp2t'],
  ['.mpg', 'video/mpeg'],
  ['.mpeg', 'video/mpeg'],
  ['.m2v', 'video/mpeg'],
  ['.3gp', 'video/3gpp'],
  ['.3g2', 'video/3gpp2'],
  ['.ogv', 'video/ogg'],
  ['.rmvb', 'application/vnd.rn-realmedia-vbr'],
  ['.vob', 'video/dvd'],
  ['.mxf', 'application/mxf'],
])

/** Audio extensions, playable in the feed next to images and videos. */
const AUDIO_TYPES = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.wma', 'audio/x-ms-wma'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
])

/** Subtitle sidecars, converted to WebVTT by the host on request. */
const SUBTITLE_TYPES = new Map([
  ['.vtt', 'text/vtt'],
  ['.srt', 'application/x-subrip'],
  ['.ass', 'text/x-ssa'],
  ['.ssa', 'text/x-ssa'],
  ['.sub', 'text/plain'],
])

/** Extensions whose text form the viewer shows inline instead of a download. */
const TEXT_TYPES = new Map([
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.nfo', 'text/plain; charset=utf-8'],
])

/**
 * Classify one file by extension.
 *
 * @param {string} name - file name or path.
 * @returns {'image'|'video'|'audio'|'subtitle'|'text'|'other'} the media family.
 */
export function kindOf(name) {
  const ext = extname(name).toLowerCase()
  if (IMAGE_TYPES.has(ext)) return 'image'
  if (VIDEO_TYPES.has(ext)) return 'video'
  if (AUDIO_TYPES.has(ext)) return 'audio'
  if (SUBTITLE_TYPES.has(ext)) return 'subtitle'
  if (TEXT_TYPES.has(ext)) return 'text'
  return 'other'
}

/**
 * Resolve the Content-Type for a file name.
 *
 * @param {string} name - file name or path.
 * @returns {string} the response media type (octet-stream when unknown).
 */
export function contentTypeOf(name) {
  const ext = extname(name).toLowerCase()
  return (
    IMAGE_TYPES.get(ext) ??
    VIDEO_TYPES.get(ext) ??
    AUDIO_TYPES.get(ext) ??
    SUBTITLE_TYPES.get(ext) ??
    TEXT_TYPES.get(ext) ??
    'application/octet-stream'
  )
}

/** Characters that force a download rather than an inline render. */
const UNSAFE_INLINE = /[^\x20-\x7e]|["\\]/

/**
 * Build a `Content-Disposition` value that survives non-ASCII file names.
 *
 * @param {string} name - the file's base name.
 * @param {boolean} attachment - true to force a download.
 * @returns {string} the header value.
 */
export function contentDisposition(name, attachment = false) {
  const base = name.split(/[\\/]/).pop() ?? 'file'
  const safe = base.replace(/[\r\n]/g, '')
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_')
  const fallback = UNSAFE_INLINE.test(safe) ? ascii : safe
  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * Parse one `Range` request header.
 *
 * Only single ranges are honoured; a multi-range request is answered with the
 * whole entity (200), which is legal and is what browsers fall back to anyway.
 *
 * @param {string|undefined} header - the raw header value.
 * @param {number} size - the entity's length in bytes.
 * @returns {{start: number, end: number}|'unsatisfiable'|null} the inclusive
 *   byte window, `'unsatisfiable'` for a syntactically valid but out-of-bounds
 *   range, or null when there is no usable range request.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null
  const match = /^bytes=(.*)$/i.exec(header.trim())
  if (match === null) return null
  const spec = match[1].trim()
  if (spec.includes(',')) return null
  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (parts === null) return null
  const [, rawStart, rawEnd] = parts
  if (rawStart === '' && rawEnd === '') return null
  if (size <= 0) return 'unsatisfiable'

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'
  if (rawEnd === '') return { start, end: size - 1 }
  const end = Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, size - 1) }
}

/**
 * Quote an entity tag from size and modification time.
 *
 * @param {number} size - file size in bytes.
 * @param {number} mtimeMs - modification time in milliseconds.
 * @returns {string} a strong-looking ETag literal.
 */
export function etagOf(size, mtimeMs) {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`
}

/**
 * Assert that a caller-supplied relative path cannot escape a root.
 *
 * @param {unknown} value - the candidate relative path.
 * @returns {string} the normalized relative path ('' for the root itself).
 * @throws {TypeError} when the value is not a safe relative path.
 */
export function assertRelative(value) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw new TypeError('path must be a string')
  if (value.includes('\0')) throw new TypeError('path must not contain NUL')
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '')
  const parts = normalized.split('/').filter((part) => part !== '' && part !== '.')
  if (parts.some((part) => part === '..')) throw new TypeError('path must not contain ".."')
  return parts.join('/')
}

/**
 * Resolve one entry inside a root and prove the result is contained by it.
 *
 * `realpath` on both sides is what makes this a real containment check rather
 * than a string prefix test: a symlink pointing outside the root resolves to
 * its target and is refused.
 *
 * @param {string} root - the absolute, already-resolved root directory.
 * @param {string} relPath - a relative path from {@link assertRelative}.
 * @returns {Promise<{abs: string, rel: string}|null>} the absolute path plus
 *   its POSIX-style path relative to the root, or null when it escapes.
 */
export async function resolveInside(root, relPath) {
  const abs = relPath === '' ? root : resolve(root, relPath)
  let real
  try {
    real = await realpath(abs)
  } catch {
    return null
  }
  if (real !== root && !real.startsWith(root + sep)) return null
  return { abs: real, rel: relative(root, real).split(sep).join('/') }
}

/**
 * Count a directory's direct media entries without stat-ing anything.
 *
 * readDirectory is exact but pays one stat per entry; that is the right price
 * for the directory being listed and too high for *every subfolder* of it,
 * which only needs a "is this folder worth showing" number. A directory that
 * cannot be read reports `media: null` — unknown, not empty.
 *
 * @param {string} absDir - the absolute directory to peek into.
 * @returns {Promise<{media: number|null}>} direct media-file count, or null when unreadable.
 */
export async function countMediaEntries(absDir) {
  let dirents
  try {
    dirents = await readdir(absDir, { withFileTypes: true })
  } catch {
    return { media: null }
  }
  let media = 0
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue
    const kind = kindOf(dirent.name)
    if (kind === 'image' || kind === 'video' || kind === 'audio') media += 1
  }
  return { media }
}

/**
 * Read one directory level, split into folders and media files.
 *
 * Only directories and the three media families come back: the viewer exists
 * to browse images, videos, and audio, so a stray `.txt`, `.srt`, or archive
 * in the same folder is noise. Subtitle sidecars are not lost — they are
 * discovered per media file by {@link sidecarSubtitles}.
 *
 * @param {string} absDir - the absolute directory to read.
 * @returns {Promise<{name: string, size: number, mtimeMs: number, kind: string, isDirectory: boolean, hidden: boolean}[]>}
 *   raw entries; sorting and paging belong to the caller.
 */
export async function readDirectory(absDir) {
  const dirents = await readdir(absDir, { withFileTypes: true })
  const rows = []
  for (const dirent of dirents) {
    if (dirent.isDirectory()) {
      rows.push({ name: dirent.name, kind: 'directory', isDirectory: true, hidden: dirent.name.startsWith('.') })
      continue
    }
    if (!dirent.isFile()) continue
    const kind = kindOf(dirent.name)
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') continue
    rows.push({ name: dirent.name, kind, isDirectory: false, hidden: dirent.name.startsWith('.') })
  }
  const withStats = await Promise.all(
    rows.map(async (row) => {
      try {
        const info = await stat(join(absDir, row.name))
        return { ...row, size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return null
      }
    }),
  )
  return withStats.filter((row) => row !== null)
}

/**
 * Open a file for streaming and reject anything that is not a regular file.
 *
 * @param {string} abs - the absolute path to open.
 * @returns {Promise<import('node:fs/promises').FileHandle|null>} an open handle, or null.
 */
export async function openRegularFile(abs) {
  let handle
  try {
    handle = await open(abs, 'r')
  } catch {
    return null
  }
  const info = await handle.stat()
  if (!info.isFile()) {
    await handle.close()
    return null
  }
  return handle
}

/**
 * Create a read stream over an inclusive byte window.
 *
 * @param {string} abs - the absolute file path.
 * @param {number} start - first byte offset.
 * @param {number} end - last byte offset, inclusive.
 * @returns {import('node:fs').ReadStream} the stream; the caller owns errors.
 */
export function streamRange(abs, start, end) {
  // A highWaterMark that is a multiple of 64 KiB keeps the socket fed without
  // holding a whole GOP in memory; range responses are what make seeking
  // instant, so the reader must never lag behind a seek-and-play burst.
  return createReadStream(abs, { start, end, highWaterMark: 1 << 18 })
}

/**
 * Normalize a user-supplied directory into an absolute path.
 *
 * @param {unknown} value - the raw configured value.
 * @param {string} [cwd] - base for relative values.
 * @returns {string|null} the absolute path, or null when unusable.
 */
export function normalizeRoot(value, cwd = process.cwd()) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/^"+|"+$/g, '')
  if (trimmed === '' || trimmed.includes('\0')) return null
  const expanded = trimmed.startsWith('~')
    ? join(process.env.USERPROFILE ?? process.env.HOME ?? '', trimmed.slice(1))
    : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
}

/**
 * Convert an SRT or SSA/ASS subtitle body to WebVTT.
 *
 * Browsers only take WebVTT through a `<track>` element, and sidecar
 * subtitles next to a downloaded video are usually SRT, so the host converts
 * rather than making the user's player fail silently.
 *
 * @param {string} text - the raw subtitle file.
 * @param {string} name - the file name, used to pick the syntax.
 * @returns {string} a WebVTT document.
 */
export function toWebVtt(text, name) {
  const ext = extname(name).toLowerCase()
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues = ext === '.ass' || ext === '.ssa' ? fromAss(body) : fromSrt(body)
  if (cues.length === 0) return 'WEBVTT\n\n'
  return `WEBVTT\n\n${cues.join('\n\n')}\n`
}

/**
 * Extract cues from an SRT document.
 *
 * @param {string} body - normalized SRT text.
 * @returns {string[]} WebVTT cue blocks.
 */
function fromSrt(body) {
  const blocks = body.split(/\n{2,}/)
  const cues = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    if (lines.length === 0) continue
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex === -1) continue
    const [rawStart, rawEnd] = lines[timeIndex].split('-->')
    const start = srtTime(rawStart)
    const end = srtTime(rawEnd)
    if (start === null || end === null) continue
    const text = lines.slice(timeIndex + 1).join('\n')
    if (text.trim() === '') continue
    cues.push(`${start} --> ${end}\n${text}`)
  }
  return cues
}

/**
 * Normalize one SRT timestamp into WebVTT form.
 *
 * @param {string} raw - e.g. `00:01:02,500` possibly with position settings.
 * @returns {string|null} `00:01:02.500`, or null when unparseable.
 */
function srtTime(raw) {
  const match = /(\d+):(\d{1,2}):(\d{1,2})[,.](\d{1,3})/.exec(raw ?? '')
  if (match === null) return null
  const [, h, m, s, ms] = match
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms.padEnd(3, '0')}`
}

/**
 * Extract cues from an SSA/ASS document, flattening override tags.
 *
 * @param {string} body - normalized ASS text.
 * @returns {string[]} WebVTT cue blocks.
 */
function fromAss(body) {
  const lines = body.split('\n')
  let inEvents = false
  let fields = []
  const cues = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^\[/.test(trimmed)) {
      inEvents = /^\[events\]/i.test(trimmed)
      continue
    }
    if (!inEvents) continue
    if (/^format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(':') + 1)
        .split(',')
        .map((field) => field.trim().toLowerCase())
      continue
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue
    const header = fields.length > 0 ? fields : ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    const values = trimmed.slice(trimmed.indexOf(':') + 1).split(',')
    const startIndex = header.indexOf('start')
    const endIndex = header.indexOf('end')
    const textIndex = header.indexOf('text')
    if (startIndex === -1 || endIndex === -1 || textIndex === -1) continue
    const start = assTime(values[startIndex])
    const end = assTime(values[endIndex])
    if (start === null || end === null) continue
    const text = values
      .slice(textIndex)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, '\n')
      .trim()
    if (text === '') continue
    cues.push(`${start} --> ${end}\n${text}`)
  }
  return cues
}

/**
 * Normalize one ASS timestamp (`0:00:01.50`) into WebVTT form.
 *
 * @param {string} raw - the raw timestamp field.
 * @returns {string|null} `00:00:01.500`, or null when unparseable.
 */
function assTime(raw) {
  const match = /(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})/.exec((raw ?? '').trim())
  if (match === null) return null
  const [, h, m, s, cs] = match
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${cs.padEnd(2, '0')}0`
}

/**
 * List the sidecar subtitle files that sit next to one media file.
 *
 * @param {string} absMedia - the media file's absolute path.
 * @returns {Promise<{name: string, size: number}[]>} matching subtitle siblings.
 */
export async function sidecarSubtitles(absMedia) {
  const dir = absMedia.slice(0, Math.max(absMedia.lastIndexOf('/'), absMedia.lastIndexOf('\\')))
  const base = absMedia.slice(dir.length + 1).replace(/\.[^.]+$/, '').toLowerCase()
  if (dir === '' || base === '') return []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!SUBTITLE_TYPES.has(ext)) continue
    const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase()
    // `movie.srt`, `movie.zh.srt`, `movie.zh-CN.srt` all belong to `movie.*`.
    if (stem === base || stem.startsWith(`${base}.`) || stem.startsWith(`${base}_`) || stem.startsWith(`${base}-`)) {
      try {
        const info = await stat(join(dir, entry.name))
        found.push({ name: entry.name, size: info.size })
      } catch {
        /* the file vanished between readdir and stat */
      }
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name))
}
