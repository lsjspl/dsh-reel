/**
 * 真 cordis 下的载体测试：验证插件用**静态 `inject: ['webServer']`** 时，
 * 路由确实在真 Loader 树上注册成功。
 *
 * 为什么必须有：run.mjs 用的是手写替身，它的 `inject` 是同步假的。静态 inject
 * 的真实语义（等服务就绪才跑 apply、服务缺席则整个 fiber 不启动）只有真 cordis
 * 说得准。历史上这里翻过车：误以为桌面端没有 webServer，于是把 inject 清空、
 * 改成运行时二选一，还写了一整条自建 HTTP 服务的死代码。本用例把
 * 「有 webServer 时路由必被注册」钉死在真实现上。
 *
 * 用宿主里那份 `@deepseek-ai/cordis`（本地已有，无需联网）；找不到就跳过。
 *
 * 用法：node tests/real-cordis.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inject, name } from '../lib/reel.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 在几个已知安装点里找真 cordis。
 *
 * 不写死任何机器路径：从本仓库、`$DSH_HOME`、以及全局 npm 安装里依次探。
 */
async function loadCordis() {
  const dshHome = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
  const anchors = [
    join(root, 'package.json'),
    join(dshHome, 'profiles', 'web', 'package.json'),
    join(dshHome, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ]
  for (const anchor of anchors) {
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/cordis')
      return { module: await import(`file:///${resolved.replace(/\\/g, '/')}`), resolved }
    } catch {
      /* try the next anchor */
    }
  }
  return null
}

const cordis = await loadCordis()
if (cordis === null) {
  console.log('\n（跳过）找不到真 cordis，未做真机载体校验')
  process.exit(0)
}

const failures = []
let passes = 0
const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

console.log(`  用真 cordis：${cordis.resolved}`)
const { Context } = cordis.module

// ── 测试媒体 ───────────────────────────────────────────────────────────────
const workspace = mkdtempSync(join(tmpdir(), 'reel-cordis-'))
const mediaRoot = join(workspace, '媒体')
mkdirSync(mediaRoot, { recursive: true })
writeFileSync(join(mediaRoot, 'a.jpg'), Buffer.alloc(64, 1))

/** 一个最小但真实的 webServer 服务：只实现插件真正用到的那几个成员。 */
function makeWebServer() {
  const exact = new Map()
  const prefix = new Map()
  return {
    port: 45678,
    exact,
    prefix,
    register(route) {
      const table = route.kind === 'exact' ? exact : prefix
      if (table.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      table.set(route.path, route.handler)
      return () => table.delete(route.path)
    },
  }
}

/**
 * 起一棵真 cordis 树：可选地挂一个提供 `webServer` 的插件，再挂 reel。
 *
 * @param {object} options - `withWebServer` 决定组合里是否有那个服务。
 * @returns {Promise<object>} 树、webServer、以及 reel fiber 的状态探针。
 */
async function boot({ withWebServer }) {
  const app = new Context()
  const webServer = makeWebServer()
  // cordis 4 里每个 runtime 的 `fibers` 是可迭代的 DisposableList；fiber.await()
  // 就是「这棵树稳定下来」的信号。
  const settle = async () => {
    const fibers = [...app.registry.values()].flatMap((runtime) => [...runtime.fibers])
    await Promise.allSettled(fibers.map((f) => f.await()))
  }

  if (withWebServer) {
    app.plugin((ctx) => {
      ctx.provide('webServer', webServer)
    })
    await settle()
  }

  // 挂**真实模块**：静态 `inject` 长在模块对象上，用一个包装函数去调 apply 会把
  // 它整个绕过去，那样测的就不是真实语义了。config 直接给原始值，由模块自己的
  // `Config` 校验 —— 和真实宿主给 apply 的东西一致（cordis 的签名是
  // `plugin(plugin, config)`）。
  const plugin = await import('../lib/reel.js')
  app.plugin(plugin, { roots: [mediaRoot] })
  await settle()

  const runtime = app.registry.get(plugin)
  return { app, webServer, plugin, fibers: runtime === undefined ? [] : [...runtime.fibers] }
}

// ── 1. 组合里有 webServer：apply 必须执行，路由必须挂上 ────────────────────
{
  const { app, webServer, fibers } = await boot({ withWebServer: true })
  check('有 webServer 时 reel 的 fiber 跑起来了', fibers.length > 0, `fibers=${fibers.length}`)
  check('路由注册到了 webServer 上', webServer.exact.size > 0 || webServer.prefix.size > 0,
    `exact=${webServer.exact.size} prefix=${webServer.prefix.size}`)
  check('声明了静态 inject', inject.includes('webServer'), JSON.stringify(inject))
  app.fiber.dispose()
}

// ── 2. 路由确实能被派发（不光注册了，handler 是活的） ─────────────────────
{
  const { app, webServer } = await boot({ withWebServer: true })
  const handler = webServer.exact.get('/reel/api/session')
  check('精确路由 /reel/api/session 存在', typeof handler === 'function',
    JSON.stringify([...webServer.exact.keys()].slice(0, 8)))

  if (typeof handler === 'function') {
    const req = { url: '/reel/api/session', method: 'GET', headers: { host: '127.0.0.1:45678' } }
    let body = ''
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader() {},
      end(chunk) { body += chunk === undefined ? '' : String(chunk) },
      destroy() {},
    }
    const result = handler(req, res)
    if (result !== undefined && typeof result.then === 'function') await result
    check('session 路由返回 200', res.statusCode === 200, `实际 ${res.statusCode}`)
    let parsed = null
    try { parsed = JSON.parse(body) } catch { /* leave null */ }
    check('session 路由返回了本插件的 JSON', parsed?.base === '/reel', body.slice(0, 160))
    // 证明 config 真的从模块的 `Config` 流到了请求路径上：给出的 roots 要出现在
    // 会话里（宿主传的就是 config，不是别的什么）。
    check('会话读到了配置里的 roots', parsed?.roots?.some?.((r) => r.path === mediaRoot),
      JSON.stringify(parsed?.roots))
  }
  app.fiber.dispose()
}

// ── 3. 组合里没有 webServer：apply 不跑，于是没有任何路由（静态 inject 的语义）
//
// 注意判据是「没有路由」，不是「没有 fiber」：cordis 的 `ctx.plugin` 无论如何都
// 会建一个 fiber 记录，只是 inject 未满足时停在等待态、不执行 apply。
{
  const { app, webServer, fibers } = await boot({ withWebServer: false })
  check('没有 webServer 时 apply 不跑：没有注册任何路由',
    webServer.exact.size === 0 && webServer.prefix.size === 0,
    `fibers=${fibers.length} exact=${webServer.exact.size} prefix=${webServer.prefix.size}`)
  app.fiber.dispose()
}

rmSync(workspace, { recursive: true, force: true })

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
