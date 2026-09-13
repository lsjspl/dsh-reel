/**
 * 「库」节点的端到端验证：真实浏览器 + 假 dsh（两个配置目录）。
 *
 * 覆盖服务端与 vm 测试够不着的部分：树只有「库」一个顶层节点、各配置目录嵌
 * 在它下面（三角能收起整棵树）、点库会切到 k=lib 并把内容模式升到「全部」、
 * 右侧列出**所有**配置目录的媒体、搜索跨目录生效，点回某个根之后一切复原。
 *
 * 用法：node tests/library.mjs
 * Chrome 路径默认取 verify-ui 的同一条；可用 CHROME_PATH 覆盖。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config } from '../lib/reel.js'

const failures = []
let passes = 0
const check = (label, ok, detail) => {
  if (ok) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
if (!existsSync(CHROME)) {
  console.log(`未找到 Chrome（${CHROME}），跳过库的端到端验证。用 CHROME_PATH 指定路径后重跑。`)
  process.exit(0)
}

// ── 两个媒体根 ─────────────────────────────────────────────────────────────

const workspace = mkdtempSync(join(tmpdir(), 'mv-lib-'))
const rootA = join(workspace, 'A 盘')
const rootB = join(workspace, 'B 盘')
mkdirSync(join(rootA, '照片'), { recursive: true })
mkdirSync(join(rootB, '视频'), { recursive: true })
writeFileSync(join(rootA, 'alpha.jpg'), Buffer.alloc(200, 1))
writeFileSync(join(rootA, '照片', 'beta.jpg'), Buffer.alloc(200, 1))
writeFileSync(join(rootB, 'gamma.mp4'), Buffer.alloc(300, 1))
writeFileSync(join(rootB, '视频', 'delta.mp4'), Buffer.alloc(300, 1))

/** 最小 cordis 替身：只实现插件真正用到的那部分（同 run.mjs）。 */
function fakeContext() {
  const routes = { exact: new Map(), prefix: new Map() }
  const webServer = {
    port: 0,
    register(route) {
      const table = route.kind === 'exact' ? routes.exact : routes.prefix
      table.set(route.path, route.handler)
      return () => table.delete(route.path)
    },
  }
  const ctx = {
    webServer,
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : []
      if (!names.every((dep) => ctx.get(dep) !== undefined)) return { then: () => {} }
      const injected = { ...ctx }
      for (const name of names) injected[name] = ctx.get(name)
      callback(injected)
      return { then: () => {} }
    },
    effect: (execute) => {
      execute()
      return () => {}
    },
    on: () => () => {},
  }
  return { ctx, routes }
}

/** 按 webserver 的匹配顺序派发：精确表 → 最长前缀 → 404。 */
function dispatch(routes) {
  return (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/'
    const exact = routes.exact.get(pathname)
    if (exact !== undefined) return void exact(req, res)
    let best = null
    for (const [prefix, handler] of routes.prefix) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (best === null || prefix.length > best[0].length) best = [prefix, handler]
      }
    }
    if (best !== null) return void best[1](req, res)
    res.statusCode = 404
    res.end()
  }
}

const harness = fakeContext()
apply(harness.ctx, Config['~standard'].validate({ roots: [rootA, rootB], requireTrustedRequest: true }).value)
const server = createServer(dispatch(harness.routes))
await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
const origin = `http://127.0.0.1:${server.address().port}`

// ── Chrome ─────────────────────────────────────────────────────────────────

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-lib-ui-'))
const port = 9345
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
)
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break
  } catch {}
  await sleep(250)
}
const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const socket = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
const errors = []
socket.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(`${m.params.exceptionDetails?.text ?? ''} :: ${(m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]}`)
  }
  if (m.id === undefined) return
  const e = pending.get(m.id)
  if (e === undefined) return
  pending.delete(m.id)
  m.error ? e.fail(new Error(m.error.message)) : e.settle(m.result)
})
const send = (method, params = {}) =>
  new Promise((settle, fail) => {
    id += 1
    pending.set(id, { settle, fail })
    socket.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.text} :: ${(r.exceptionDetails.exception?.description ?? '').split('\n').slice(0, 2).join(' | ')}`)
  }
  return r.result.value
}
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await ev(expression)) === true) return true
    await sleep(250)
  }
  return false
}

/** 页面上所有卡片的目录键。 */
const cardKeys = '[...document.querySelectorAll(".card[data-key]")].map((n) => n.dataset.key)'

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/reel?k=r0` })
  check('首屏出现卡片', await waitFor('document.querySelectorAll(".card[data-key]").length > 0'))

  const treeProbe = await ev(`(() => {
    const depthOf = (node) => {
      let depth = 0
      for (let parent = node.parentElement; parent !== null && parent.id !== 'tree'; parent = parent.parentElement) {
        if (parent.classList.contains('tree-children')) depth += 1
      }
      return depth
    }
    return {
      library: document.querySelector('.tree-library-name')?.querySelector('.label')?.textContent ?? null,
      topLevel: [...document.getElementById('tree').children].map((n) => n.className),
      nestedRoots: document.querySelectorAll('#tree .tree-library .tree-children > .tree-root').length,
      roots: document.querySelectorAll('#tree .tree-root').length,
      rootDepths: [...document.querySelectorAll('#tree .tree-root-name')].map(depthOf),
      outline: [...document.querySelectorAll('#tree .tree-library-name, #tree .tree-root-name, #tree .tree-folder')]
        .map((node) => [depthOf(node), node.querySelector('.label').textContent]),
      keys: ${cardKeys},
    }
  })()`)
  console.log('树轮廓:', JSON.stringify(treeProbe.outline))
  check('树顶有「库」节点', treeProbe.library === '库', JSON.stringify(treeProbe))
  check('库是树唯一的顶层节点', treeProbe.topLevel.join('|') === 'tree-library', treeProbe.topLevel.join('|'))
  check('库在最外层', treeProbe.outline[0].join(':') === '0:库', JSON.stringify(treeProbe.outline[0]))
  check('配置目录在库的下一层', treeProbe.rootDepths.join(',') === '1,1', treeProbe.rootDepths.join(','))
  check('各配置目录都嵌在库下面', treeProbe.roots === 2 && treeProbe.nestedRoots === 2, `根 ${treeProbe.roots} / 嵌在库下 ${treeProbe.nestedRoots}`)
  check('首个根只列出自己的文件', treeProbe.keys.join(',') === 'r0/alpha.jpg', treeProbe.keys.join(','))

  // 库和其它节点一样：三角管折展，且折展的是整棵目录树。
  const collapse = await ev(`(async () => {
    const twisty = document.querySelector('.tree-library-name .twisty')
    const host = document.querySelector('.tree-library > .tree-children')
    const read = () => ({ open: host.dataset.open, hidden: host.hidden, twisty: twisty.textContent })
    twisty.click()
    await new Promise((r) => setTimeout(r, 400))
    const collapsed = read()
    twisty.click()
    await new Promise((r) => setTimeout(r, 400))
    return { collapsed, expanded: read() }
  })()`)
  check('库的三角收起整棵目录树', collapse.collapsed.hidden === true && collapse.collapsed.twisty === '▸', JSON.stringify(collapse.collapsed))
  check('再点三角把目录树展开', collapse.expanded.hidden === false && collapse.expanded.twisty === '▾', JSON.stringify(collapse.expanded))

  // 库收起时点某个目录：库要自动展开——「我进了这个目录」必须看得见自己在哪。
  const autoExpand = await ev(`(async () => {
    const twisty = document.querySelector('.tree-library-name .twisty')
    if (document.querySelector('.tree-library > .tree-children').hidden === false) {
      twisty.click()
      await new Promise((r) => setTimeout(r, 400))
    }
    document.querySelectorAll('#tree .tree-root-name')[1].click()
    await new Promise((r) => setTimeout(r, 1800))
    return {
      hidden: document.querySelector('.tree-library > .tree-children').hidden,
      twisty: document.querySelector('.tree-library-name .twisty').textContent,
      k: new URLSearchParams(location.search).get('k'),
    }
  })()`)
  check('库收起时点目录会重新展开库', autoExpand.hidden === false && autoExpand.twisty === '▾', JSON.stringify(autoExpand))
  check('点第二个目录会切到它', autoExpand.k === 'r1', autoExpand.k)

  const libClick = await ev(`(async () => {
    document.querySelector('.tree-library-name').click()
    await new Promise((r) => setTimeout(r, 1800))
    return {
      k: new URLSearchParams(location.search).get('k'),
      active: document.querySelector('.tree-library-name').classList.contains('is-active'),
      content: [...document.querySelectorAll('[data-content-btn]')].filter((n) => n.classList.contains('is-active')).map((n) => n.dataset.contentBtn),
      placeholder: document.getElementById('searchInput').placeholder,
      crumb: document.getElementById('crumbs').textContent,
      upDisabled: document.getElementById('crumbUp').disabled,
      keys: ${cardKeys},
      summary: document.getElementById('summary').textContent,
    }
  })()`)
  console.log('库视图:', JSON.stringify(libClick))
  check('点「库」后地址是 k=lib', libClick.k === 'lib', libClick.k)
  check('库行高亮', libClick.active === true)
  check('库默认切到「全部」', libClick.content.join(',') === 'all', libClick.content.join(','))
  check('搜索提示改为整个库', libClick.placeholder.includes('整个库'), libClick.placeholder)
  check('路径行是「库」', libClick.crumb.includes('库'), libClick.crumb)
  check('库里「返回上一级」不可用', libClick.upDisabled === true)
  check('库列出两个根的全部媒体', libClick.keys.length === 4, libClick.keys.join(','))
  check(
    '库里两种根的文件都在',
    ['r0/alpha.jpg', 'r0/%E7%85%A7%E7%89%87/beta.jpg', 'r1/gamma.mp4', 'r1/%E8%A7%86%E9%A2%91/delta.mp4'].every((key) => libClick.keys.includes(key)),
    libClick.keys.join(','),
  )

  const search = await ev(`(async () => {
    const input = document.getElementById('searchInput')
    input.value = 'beta'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 600))
    return { keys: ${cardKeys}, summary: document.getElementById('summary').textContent }
  })()`)
  console.log('库内搜索:', JSON.stringify(search))
  check('库里的搜索跨所有目录', search.keys.length === 1 && search.keys[0].includes('beta'), search.keys.join(','))

  const backToRoot = await ev(`(async () => {
    const input = document.getElementById('searchInput')
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    document.querySelectorAll('#tree .tree-root-name')[0].click()
    await new Promise((r) => setTimeout(r, 1800))
    return {
      k: new URLSearchParams(location.search).get('k'),
      placeholder: document.getElementById('searchInput').placeholder,
    }
  })()`)
  console.log('回到根目录:', JSON.stringify(backToRoot))
  check('点回第一个根目录', backToRoot.k === 'r0', backToRoot.k)
  check('根目录下搜索提示回到当前目录', backToRoot.placeholder.includes('当前目录'), backToRoot.placeholder)

  check('控制台没有异常', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {})
  chrome.kill('SIGKILL')
  await sleep(600)
  server.close()
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 交给系统清理临时目录 */
  }
  rmSync(workspace, { recursive: true, force: true })
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('库的端到端验证通过 ✓')
