/**
 * 在「真实的 profile」里做一次完整启动演练：按 bin.js 的路径组合 profile、
 * boot 整棵树、确认 reel 的行真的激活并注册了路由、真打一次请求，
 * 然后立刻 dispose。
 *
 * 为什么值得这么麻烦：改动 profile 的 bundle 列表会直接决定用户下一次启动
 * 能不能起来。在让他们重启之前先证明树装得起来、拆得掉，比事后救火便宜。
 *
 * 默认让 web app 监听 3089（一个空闲端口），只用于验证；不需要的话传 --no-listen。
 *
 * 用法（要放在 profile 目录里跑，否则解析不到 @deepseek-ai/*）：
 *   node boot-check.mjs web
 */
import { pathToFileURL } from 'node:url'
import {
  boot,
  installFailLoud,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  loadOverlayPatches,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'

const NAME = 'dsh'
const INSTALL_ANCHOR = 'C:/Users/lsj/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json'
const profileName = process.argv[2] ?? 'web'
const listen = process.argv.includes('--no-listen') === false
const port = 3089

const profileDir = resolveProfileDir(profileName)
const profile = loadProfile(NAME, profileName, INSTALL_ANCHOR, undefined, { userLayer: true })
const bundlePatches = profile.layers.flatMap((layer) => layer.patches)
const userPatches = loadOptionalPatches(NAME, profile.patchPath) ?? []
const overlayPatches = loadOverlayPatches(NAME, `${profileDir}/cordis.yml`) ?? []

console.log('profile      :', profileDir)
console.log('bundles      :', profile.layers.map((layer) => layer.packageName).join(', '))
console.log('user patches :', userPatches.length)

installFailLoud(NAME, process)
const ctx = await boot(
  NAME,
  `${profileDir}/cordis.yml`,
  structuredClone([...bundlePatches, ...userPatches, ...overlayPatches]),
  // 和 bin.js 一样先注入启动环境与命令行参数：web app 的一串行都挂在
  // cmdlineArgs → webStartup → webServer 这条依赖链上，少给一个，Web 那一
  // 半就整片 pending，连 webServer 都不会出现。
  (hostCtx) => {
    // 必须是 launcher 真正给的那个环境快照对象，不能是自造的字面量：
    // open-in-app / directory-picker 这些行会调它的 getFrom。
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, loadLayeredEnv(NAME))
    provideCmdline(hostCtx, {
      args: listen ? ['--no-open', '--port', String(port)] : ['--help'],
      exit: () => {},
    })
  },
  undefined,
)

const loader = ctx.get('loader')
const entries = [...(loader?.entries?.() ?? [])]
const media = entries.find((entry) => entry.options.id === 'reel')
console.log('总行数           :', entries.length)
console.log('reel 行  :', media === undefined ? '缺失 ✗' : `存在，fiber 状态 ${media.fiber?.state}（2=active）`)

const webServer = ctx.get('webServer')
console.log('webServer        :', webServer === undefined ? '缺失 ✗' : `监听端口 ${webServer.port}`)

const probes = [
  '/reel',
  '/reel/app.css',
  '/reel/api/session',
  '/reel/api/list',
  '/reel/api/scan',
  '/reel/api/config',
  '/reel/stream',
  '/reel/download',
  '/reel/thumb',
  '/reel/subtitle',
]
const missing = probes.filter((path) => webServer?.match?.(path) === undefined)
console.log('路由             :', missing.length === 0 ? `全部 ${probes.length} 条已注册 ✓` : `缺 ${missing.join(', ')} ✗`)

// 真打一次 session：证明拿得到根目录与设置状态。
if (webServer !== undefined) {
  const body = await new Promise((settle) => {
    // match() 返回的是路由描述（kind/path/handler），不是裸 handler。
    const matched = webServer.match('/reel/api/session')
    const res = {
      statusCode: 0,
      setHeader() {},
      removeHeader() {},
      end(chunk) {
        settle(chunk === undefined ? '' : chunk.toString())
      },
      destroy() {
        settle('')
      },
    }
    matched.handler(
      { method: 'GET', url: '/reel/api/session', headers: { host: `127.0.0.1:${webServer.port}` }, socket: { remoteAddress: '127.0.0.1' } },
      res,
    )
  })
  const parsed = JSON.parse(body)
  console.log('session 响应     : %s, roots=%d, 可写=%s, ffmpeg=%s', parsed.error === undefined ? 'HTTP 200' : `错误 ${parsed.error}`, parsed.roots?.length ?? 0, parsed.writable, parsed.capabilities?.ffmpeg)
  console.log('可用目录         :', (parsed.roots ?? []).map((root) => root.path).join(', ') || '(未配置，打开页面即可添加)')
}

await ctx.fiber.dispose()
console.log('\n演练完成：树装得起来、媒体路由全部就位、也能干净拆掉。')
void pathToFileURL
void missing
