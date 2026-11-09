import { spawn } from 'node:child_process'

/** A per-plugin budget for live encoders, including paused/terminating jobs. */
export function createTranscoder({
  spawnProcess = spawn,
  maxConcurrent = 2,
  threads = 2,
  startupTimeoutMs = 25000,
  stallTimeoutMs = 30000,
} = {}) {
  const active = new Set()
  let disposed = false

  const fail = (res, message, retry = false) => {
    if (res.destroyed || res.writableEnded) return
    const body = Buffer.from(JSON.stringify({ error: message }))
    if (retry) res.setHeader('retry-after', '2')
    res.writeHead(503, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    res.end(body)
  }

  return {
    stream(res, binary, abs, start, headers) {
      if (disposed || active.size >= maxConcurrent) {
        fail(res, 'transcoder busy; retry shortly', true)
        return Promise.resolve()
      }
      if (res.destroyed || res.writableEnded) return Promise.resolve()
      return new Promise((settle) => {
        let child
        try {
          child = spawnProcess(binary, [
            '-hide_banner', '-loglevel', 'error',
            '-threads', String(threads), '-filter_threads', '1',
            ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
            '-i', abs,
            '-map', '0:v:0?', '-map', '0:a:0?',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
            '-threads', String(threads), '-pix_fmt', 'yuv420p',
            '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
            '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-f', 'mp4', 'pipe:1',
          ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
        } catch {
          fail(res, 'could not start the transcoder')
          settle()
          return
        }
        let started = false
        let finished = false
        let stallTimer
        const stop = () => {
          try { child.kill('SIGKILL') } catch { /* already gone */ }
        }
        const job = { cancel: () => { stop(); res.destroy() } }
        active.add(job)
        const finish = (message, failed = false) => {
          if (finished) return
          finished = true
          clearTimeout(startupTimer)
          clearTimeout(stallTimer)
          res.off('drain', drain)
          res.off('close', disconnected)
          if (!res.destroyed && !res.writableEnded) {
            if (!started) fail(res, message)
            else if (failed) res.destroy()
            else res.end()
          }
          settle()
        }
        const armStall = () => {
          clearTimeout(stallTimer)
          stallTimer = setTimeout(() => {
            stop()
            finish('transcoder stalled', true)
          }, stallTimeoutMs)
          stallTimer.unref?.()
        }
        const drain = () => {
          if (finished) return
          armStall()
          child.stdout.resume()
        }
        const disconnected = () => {
          if (!res.writableEnded) {
            stop()
            finish('request disconnected', true)
          }
        }
        const startupTimer = setTimeout(() => {
          stop()
          finish('transcoder startup timed out', true)
        }, startupTimeoutMs)
        startupTimer.unref?.()
        res.on('close', disconnected)
        res.on('drain', drain)
        child.stdout.on('data', (chunk) => {
          if (finished) return
          if (res.destroyed || res.writableEnded) { stop(); finish('request disconnected', true); return }
          if (!started) {
            started = true
            clearTimeout(startupTimer)
            res.writeHead(200, headers)
          }
          armStall()
          if (res.write(chunk) === false) {
            child.stdout.pause()
            // Backpressure from a slow browser is not an encoder stall.
            clearTimeout(stallTimer)
          }
        })
        child.stdout.on('error', () => { stop(); finish('conversion failed', true) })
        child.on('error', () => finish('could not start the transcoder', true))
        child.on('close', (code) => {
          // Do not release a slot until the process has actually exited.
          active.delete(job)
          finish(code === 0 ? 'nothing to convert' : 'conversion failed', code !== 0)
        })
      })
    },
    dispose() {
      disposed = true
      for (const job of active) job.cancel()
    },
  }
}
