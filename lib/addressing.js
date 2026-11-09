import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Keep numeric root keys so the viewer's existing directory grammar still
// works. Reserve the upper half of safe integers; old positional r0/r1 keys
// must fail closed rather than silently acquire a different meaning.
export function rootIdOf(path) {
  const absolute = resolve(path)
  const identity = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  return 2 ** 52 + Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 13), 16)
}

export function mediaKeyOf(path, rel = '') {
  return `r${rootIdOf(path)}${rel === '' ? '' : `/${rel.split('/').map(encodeURIComponent).join('/')}`}`
}
