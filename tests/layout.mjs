/**
 * 桌面布局验证：目录栏宽度、拖动调整、记忆、列表视图各列宽度。
 *
 * 为什么要单独一套：这些是纯几何断言，靠读代码看不出问题。真实的翻车是
 * 「侧边栏 268px 装不下上百字符的目录名，每个名字都被省略成没用的几个字」，
 * 而当时的测试只断言了侧边栏 display 不是 none。
 *
 * 用法：node tests/layout.mjs <origin> [key]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const key = process.argv[3] ?? 'r0'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const failures = []
let passes = 0

const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-layout-'))
const port = 9339
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
)

/** 等 DevTools 端点。 */
async function waitForDevTools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

await waitForDevTools()
const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
const socket = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((settle) => socket.addEventListener('open', settle, { once: true }))

let nextId = 0
const pending = new Map()
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(message.params.exceptionDetails?.text ?? 'exception')
  }
  if (message.id === undefined) return
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  message.error ? entry.fail(new Error(message.error.message)) : entry.settle(message.result)
})
const send = (method, params = {}) =>
  new Promise((settle, fail) => {
    nextId += 1
    pending.set(nextId, { settle, fail })
    socket.send(JSON.stringify({ id: nextId, method, params }))
  })

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
  return result.result.value
}

/** 目录栏实测宽度。 */
const sidebarWidth = () => evaluate('Math.round(document.getElementById("sidebar").getBoundingClientRect().width)')

/** 分隔条中心点（宽度变了它也会移位，每次都要重量）。 */
const resizerCenter = () =>
  evaluate(`(() => {
    const r = document.getElementById('sidebarResizer').getBoundingClientRect()
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  })()`)

/** 用真实鼠标事件拖动分隔条。 */
const dragResizer = async (toX) => {
  const from = await resizerCenter()
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 })
  const steps = 6
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((toX - from.x) * step) / steps)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: from.y, button: 'left', buttons: 1 })
    await sleep(30)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: from.y, button: 'left', clickCount: 1 })
  await sleep(300)
}

/** 双击分隔条（必须发两次完整点击，CDP 才会合成 dblclick）。 */
const doubleClickResizer = async () => {
  const at = await resizerCenter()
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 })
  await sleep(60)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 2 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 2 })
  await sleep(600)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(key)}` })
  await sleep(2500)

  // ── 目录栏 ────────────────────────────────────────────────────────────
  const defaultWidth = await sidebarWidth()
  check('目录栏默认宽度 ≥ 300px', defaultWidth >= 300, `实际 ${defaultWidth}`)
  check('分隔条存在且可交互', (await evaluate('getComputedStyle(document.getElementById("sidebarResizer")).cursor')) === 'col-resize')

  // 布局用 flex 而不是栅格轨道：收窄/隐藏侧栏时栅格会算错内容列（踩过），
  // 所以这里断言的是 flex 契约，以及内容区确实拿到了剩余宽度。
  const layoutContract = await evaluate(`(() => {
    const browse = getComputedStyle(document.getElementById('browsePane'))
    const sidebar = getComputedStyle(document.getElementById('sidebar'))
    const content = getComputedStyle(document.getElementById('content'))
    return {
      browseDisplay: browse.display,
      sidebarFlex: sidebar.flexBasis,
      sidebarShrink: sidebar.flexShrink,
      contentGrow: content.flexGrow,
      contentMinWidth: content.minWidth,
      contentWidth: Math.round(document.getElementById('content').getBoundingClientRect().width),
      resizerPosition: getComputedStyle(document.getElementById('sidebarResizer')).position,
    }
  })()`)
  check('外层用 flex 布局', layoutContract.browseDisplay === 'flex', layoutContract.browseDisplay)
  check('目录栏宽度由 flex-basis 决定', layoutContract.sidebarFlex !== 'auto', layoutContract.sidebarFlex)
  check('目录栏不参与收缩', layoutContract.sidebarShrink === '0', layoutContract.sidebarShrink)
  check('内容区吃满剩余宽度', layoutContract.contentGrow === '1' && layoutContract.contentWidth > 800, JSON.stringify(layoutContract))
  check('内容区有 min-width:0（允许在窄屏收缩）', layoutContract.contentMinWidth === '0px', layoutContract.contentMinWidth)
  check('分隔条绝对定位、不占布局轨道', layoutContract.resizerPosition === 'absolute', layoutContract.resizerPosition)

  // 目录名再长也不能把行撑高：单行省略。
  const rowsSingleLine = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.tree-root-name, .tree-library-name, .tree-folder')]
    if (rows.length === 0) return true
    return rows.every((row) => row.getBoundingClientRect().height < 40)
  })()`)
  check('超长目录名不换行撑高', rowsSingleLine === true)

  // ── 拖动调整宽度 ──────────────────────────────────────────────────────
  await dragResizer(460)
  const dragged = await sidebarWidth()
  check('拖动后宽度跟着变', Math.abs(dragged - 460) <= 8, `实际 ${dragged}`)
  check('宽度写进了 localStorage', (await evaluate('localStorage.getItem("mv.sidebarW")')) !== null)

  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(key)}` })
  await sleep(2200)
  check('刷新后记住宽度', Math.abs((await sidebarWidth()) - dragged) <= 8, `实际 ${await sidebarWidth()}`)

  // ── 双击回默认 ────────────────────────────────────────────────────────
  await doubleClickResizer()
  const reset = await sidebarWidth()
  check('双击恢复默认宽度', reset < dragged - 40, `${dragged} → ${reset}`)

  // ── 下限保护 ──────────────────────────────────────────────────────────
  await dragResizer(20)
  const clamped = await sidebarWidth()
  check('拖到极窄时被下限拦住', clamped >= 190, `实际 ${clamped}`)

  // ── 列表视图各列 ──────────────────────────────────────────────────────
  await evaluate('document.getElementById("viewToggle").click()')
  await sleep(800)
  check('切到列表视图', (await evaluate('document.body.dataset.view')) === 'list')
  const columns = await evaluate(`(() => {
    const card = document.querySelector('.card')
    if (card === null) return null
    return [...card.children].map((child) => Math.round(child.getBoundingClientRect().width))
  })()`)
  check('列表里有卡片', columns !== null)
  if (columns !== null) {
    check('缩略图列够看（≥ 80px）', columns[0] >= 80, `实际 ${columns[0]}`)
    check('名字列拿到主要空间（≥ 400px）', columns[1] >= 400, `实际 ${columns[1]}`)
    const truncated = await evaluate(`(() => {
      const name = document.querySelector('.card-name')
      return name === null ? false : name.scrollWidth > name.clientWidth + 1
    })()`)
    check('短文件名不被截断', truncated === false)
  }

  // ── 桌面端不该误命中移动端规则 ────────────────────────────────────────
  check('1440px 不命中 720px 断点', (await evaluate('window.matchMedia("(max-width: 720px)").matches')) === false)
  check('没有控制台异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {})
  chrome.kill('SIGKILL')
  await sleep(300)
  rmSync(userDataDir, { recursive: true, force: true })
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('桌面布局验证通过 ✓')
