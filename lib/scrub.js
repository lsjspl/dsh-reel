import { spawn } from 'node:child_process'

/** Small, cancellable frame reads. Never restart the full playback encoder to scrub. */
export function createScrubFrames({ spawnProcess = spawn, maxConcurrent = 2, maxBytes = 8 * 1024 * 1024, timeoutMs = 5000 } = {}) {
  const active = new Set(), cache = new Map()
  let disposed = false, bytesHeld = 0
  const failure = (message, status = 503) => Object.assign(new Error(message), { status })
  return {
    async frame(binary, abs, revision, seconds, signal) {
      if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      if (disposed) throw failure('frame reader unavailable')
      const at = Math.max(0, Math.round(seconds * 2) / 2)
      const key = JSON.stringify([abs, revision, at])
      const cached = cache.get(key)
      if (cached) { cache.delete(key); cache.set(key, cached); return cached }
      // No queue of old pointer positions: clients keep only their latest target.
      if (active.size >= maxConcurrent) throw failure('frame reader busy')
      return new Promise((resolve, reject) => {
        let child, timer, settled = false, size = 0
        const chunks = []
        const finish = (error, bytes) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve(bytes)
        }
        const stop = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
        const abort = () => { stop(); finish(Object.assign(new Error('cancelled'), { name: 'AbortError' })) }
        try {
          child = spawnProcess(binary, [
            '-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1',
            '-ss', at.toFixed(3), '-i', abs, '-map', '0:v:0', '-frames:v', '1', '-an',
            '-vf', 'scale=640:640:force_original_aspect_ratio=decrease:force_divisible_by=2',
            '-threads', '2', '-q:v', '6', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        } catch { finish(failure('could not read video frame')); return }
        const job = { cancel: abort }
        active.add(job)
        timer = setTimeout(() => { stop(); finish(failure('frame read timed out')) }, timeoutMs)
        timer.unref?.()
        signal?.addEventListener('abort', abort, { once: true })
        child.stdout.on('data', chunk => {
          if (settled) return
          size += chunk.length
          if (size > 512 * 1024) { stop(); finish(failure('video frame too large')); return }
          chunks.push(chunk)
        })
        child.stdout.on('error', () => { stop(); finish(failure('could not read video frame')) })
        child.on('error', () => { active.delete(job); finish(failure('could not read video frame')) })
        child.on('close', code => {
          active.delete(job)
          if (settled) return
          if (code !== 0 || size < 4) { finish(failure('no video frame available')); return }
          const bytes = Buffer.concat(chunks)
          while (cache.size && (bytesHeld + size > maxBytes || cache.size >= 128)) {
            const oldest = cache.keys().next().value
            bytesHeld -= cache.get(oldest).length; cache.delete(oldest)
          }
          if (size <= maxBytes) { if (cache.has(key)) bytesHeld -= cache.get(key).length; cache.set(key, bytes); bytesHeld += size }
          finish(null, bytes)
        })
        if (signal?.aborted) abort()
      })
    },
    dispose() { disposed = true; for (const job of active) job.cancel(); cache.clear(); bytesHeld = 0 },
  }
}
