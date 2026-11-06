/**
 * 浏览页绝对地址（`/reel/api/session` 的 `url`）的取值测试。
 *
 * 为什么单独测：设置卡片的「在浏览器里打开」必须拿到**绝对 http 地址**。桌面端的
 * 页面 origin 是 `dsh-app://app`，相对路径会被外壳当成 `dsh-app:` 协议直接拒绝，
 * 只有绝对 http/https 才会转交系统浏览器（GitHub 链接能开就是这个原因）。
 *
 * 地址来自请求自己的 Host 头，Host 缺失时才回退到绑定地址。两条路都要锁住。
 *
 * 用法：node tests/viewer-url.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { apply, Config } from '../lib/reel.js'

const failures = []
let passes = 0
const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const checkEqual = (label, actual, expected) => {
  check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const workspace = mkdtempSync(join(tmpdir(), 'reel-url-'))
const mediaRoot = join(workspace, '媒体')
mkdirSync(mediaRoot, { recursive: true })
writeFileSync(join(mediaRoot, 'a.jpg'), Buffer.alloc(64, 1))

/**
 * 用一个假 webServer 起插件，并跑真正的一个 http 服务来派发。
 *
 * @param {object} options - `host` / `port` 决定假 webServer 报告的绑定地址。
 * @returns {Promise<object>} origin、close，以及该 harness 的日志。
 */
async function boot({ host, port }) {
  const routes = { exact: new Map(), prefix: new Map() }
  const webServer = {
    host,
    port,
    register(route) {
      const table = route.kind === 'exact' ? routes.exact : routes.prefix
      table.set(route.path, route.handler)
      return () => table.delete(route.path)
    },
  }
  const ctx = {
    fiber: { id: 'reel-url-fiber' },
    root: { loader: { await: async () => {} } },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : []
      if (!names.every((dep) => ctx.get(dep) !== undefined)) return { then: () => {} }
      const injected = { ...ctx }
      for (const name of names) injected[name] = ctx.get(name)
      callback(injected)
      return { then: () => {} }
    },
    effect: (execute) => { execute(); return () => {} },
    on: () => () => {},
  }
  apply(ctx, Config['~standard'].validate({ roots: [mediaRoot] }).value)

  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/'
    const handler = routes.exact.get(pathname)
    if (handler === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end() })
  })
  await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
  webServer.port = server.address().port
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    // fetch 用的是 keep-alive 连接，不先掐断会让 close() 一直等下去（Windows 上
    // 还会在进程退出时撞到 libuv 的 handle closing 断言）。
    close: () => new Promise((settle) => {
      server.closeAllConnections()
      server.close(settle)
    }),
  }
}

/**
 * 发一条裸 HTTP/1.0 请求并解析 JSON 响应。
 *
 * `fetch` 会强制补上真实的 Host（Host 是 forbidden header，伪造无效），所以要
 * 覆盖「Host 由外部决定」和「没有 Host」两条分支都只能走裸 socket。
 *
 * @param {number} port - 目标端口。
 * @param {string} [hostHeader] - 要发的 Host 头值；省略则不发 Host。
 * @returns {Promise<object|null>} 解析出的 JSON，解析失败为 null。
 */
async function rawSession(port, hostHeader) {
  const lines = [`GET /reel/api/session HTTP/1.0`]
  if (hostHeader !== undefined) lines.push(`Host: ${hostHeader}`)
  const raw = await new Promise((resolve, reject) => {
    const client = net.connect(port, '127.0.0.1', () => {
      client.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    let data = ''
    client.on('data', (chunk) => { data += chunk })
    client.on('end', () => resolve(data))
    client.on('error', reject)
  })
  const body = raw.slice(raw.indexOf('\r\n\r\n') + 4)
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ── 1. 有 Host 头：用 Host 头（这是两条运行路径的实际情形） ────────────────
{
  const h = await boot({ host: '127.0.0.1', port: 0 })
  const payload = await (await fetch(`${h.origin}/reel/api/session`)).json()
  checkEqual('用请求的 Host 组成绝对地址', payload.url, `${h.origin}/reel`)
  check('地址是绝对 http', payload.url.startsWith('http://'))
  check('地址以 /reel 结尾', payload.url.endsWith('/reel'))
  await h.close()
}

// ── 2. 伪造 Host（桌面端拿到的就是这个形状）→ 原样采用 ─────────────────────
//
// 桌面壳的 forwardWebRequest 删掉 Host 头后重新 fetch，node 会按目标 URL 补上
// `127.0.0.1:19387`。这里直接用那个 Host 断言结果（fetch 不许伪造 Host，走裸
// socket）。
{
  const h = await boot({ host: '127.0.0.1', port: 0 })
  const payload = await rawSession(h.port, '127.0.0.1:19387')
  checkEqual('桌面端形状的 Host 得到 19387 的绝对地址', payload?.url, 'http://127.0.0.1:19387/reel')
  await h.close()
}

// ── 3. 没有 Host 头：回退到绑定地址 ────────────────────────────────────────
{
  const h = await boot({ host: '127.0.0.1', port: 0 })
  // 直接发一条不带 Host 的 HTTP/1.0 请求（node 的 fetch 总会补 Host，所以这里
  // 用裸 socket）。
  const payload = await rawSession(h.port)
  check('无 Host 头时回退到绑定地址',
    payload?.url === `http://127.0.0.1:${h.port}/reel`,
    `实际 ${JSON.stringify(payload?.url)}`)
  await h.close()
}

// ── 4. 通配绑定（0.0.0.0）→ 回退时写成回环，浏览器打不开通配地址 ───────────
{
  const h = await boot({ host: '0.0.0.0', port: 0 })
  const payload = await rawSession(h.port)
  checkEqual('通配绑定回退成回环地址', payload?.url, `http://127.0.0.1:${h.port}/reel`)
  await h.close()
}

rmSync(workspace, { recursive: true, force: true })

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
