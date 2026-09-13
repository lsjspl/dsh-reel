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
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
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
  // 视图切换现在是工具条上「网格 / 列表」两枚按钮（早先是一个 viewToggle 按钮）。
  await evaluate(`document.querySelector('[data-view-btn="list"]').click()`)
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

  // ── 网格大小三档（小 / 中 / 大） ────────────────────────────────────────
  //
  // 以前只有一个尺寸，大屏上永远 5 列。这里钉住三件事：点一下真的换档（瓦片
  // 宽度与列数都变）、非默认档在列表视图里不该出现、选过之后刷新还记得。
  await evaluate(`document.querySelector('[data-view-btn="grid"]').click()`)
  await sleep(800)
  const gridShape = () =>
    evaluate(`(() => {
      const cards = [...document.querySelectorAll('#grid .card')]
      if (cards.length === 0) return null
      const top = Math.round(cards[0].getBoundingClientRect().top)
      const row = cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 2)
      return {
        width: Math.round(cards[0].getBoundingClientRect().width),
        columns: row.length,
        tile: getComputedStyle(document.documentElement).getPropertyValue('--tile').trim(),
        stored: localStorage.getItem('mv.tileSize'),
        active: [...document.querySelectorAll('[data-tile-btn]')].filter((node) => node.classList.contains('is-active')).map((node) => node.dataset.tileBtn),
      }
    })()`)
  const pickTile = async (index) => {
    await evaluate(`document.querySelector('[data-tile-btn="${index}"]').click()`)
    await sleep(700)
    return gridShape()
  }

  // 开箱默认必须是「中」：早先 readTile 用 Number(null) 读出 0，把「没存过」当成
  // 「小」——手机上一屏四列、一张卡 80 多像素，整张卡活像一个大的播放按钮。
  const fresh = await gridShape()
  check('开箱默认是「中」', fresh !== null && fresh.active.join(',') === '1', JSON.stringify(fresh))
  // getComputedStyle 对自定义属性返回的是**解析后**的值，所以这里看到的是 200px。
  check('「中」用设备基准宽（桌面 200px）', fresh !== null && fresh.tile === '200px', String(fresh?.tile))

  const middle = await pickTile(1)
  check('默认是「中」（瓦片按基准宽）', middle !== null && middle.active.join(',') === '1', JSON.stringify(middle))
  const small = await pickTile(0)
  check('点「小」瓦片变小', small !== null && small.width < middle.width - 10, `${middle?.width} → ${small?.width}`)
  check('点「小」一屏列数变多', small !== null && small.columns > middle.columns, `${middle?.columns} → ${small?.columns}`)
  const large = await pickTile(2)
  check('点「大」瓦片变大', large !== null && large.width > middle.width + 10, `${middle?.width} → ${large?.width}`)
  check('点「大」一屏列数变少', large !== null && large.columns < middle.columns, `${middle?.columns} → ${large?.columns}`)
  check('选中态跟着走', large !== null && large.active.join(',') === '2', JSON.stringify(large))
  check('档位存进 localStorage', large !== null && large.stored === '2', String(large?.stored))

  // 换档之后分块的列数必须和实际列数一致（不然块边界会空出半行）。
  const chunkShape = await evaluate(`(() => {
    const chunks = [...document.querySelectorAll('#grid > .grid-chunk')]
    return chunks.slice(0, 2).map((chunk) => {
      const cards = [...chunk.querySelectorAll('.card')]
      if (cards.length === 0) return 0
      const top = Math.round(cards[0].getBoundingClientRect().top)
      return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 2).length
    })
  })()`)
  check('分块列数与网格列数一致', chunkShape.every((count) => count === large.columns), `${JSON.stringify(chunkShape)} vs ${large?.columns}`)

  // 列表视图里那组按钮该藏起来（瓦片宽度对列表没用）。
  await evaluate(`document.querySelector('[data-view-btn="list"]').click()`)
  await sleep(600)
  const tileGroupInList = await evaluate(`getComputedStyle(document.getElementById('tileGroup')).display`)
  check('列表视图里藏起网格大小', tileGroupInList === 'none', tileGroupInList)

  // 刷新之后仍然是「大」。
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(key)}` })
  await sleep(2500)
  const afterReload = await gridShape()
  check('刷新后记住选的那一档', afterReload !== null && afterReload.active.join(',') === '2' && afterReload.stored === '2', JSON.stringify(afterReload))
  // 收尾回到默认，别把状态留给后面的人。
  await pickTile(1)

  // ── 「看视频」：一键随机 + 铺满这一页 ────────────────────────────────────
  //
  // 桌面上播放器默认是窗口形态，这个按钮要的是**页内全屏**；顺序必须是随机，
  // 而且 ⇄ 那枚要跟着点亮（用户看到的和按钮亮的是同一件事）。
  const watch = await evaluate(`(async () => {
    const button = document.getElementById('watchRandomBtn')
    if (button === null) return { ok: false, reason: '没有看视频按钮' }
    const box = button.getBoundingClientRect()
    button.click()
    const deadline = Date.now() + 12000
    while (Date.now() < deadline && document.getElementById('player').hidden) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 2500))
    return {
      ok: true,
      buttonVisible: box.width > 0 && box.height >= 28,
      open: document.getElementById('player').hidden === false,
      pageFull: document.getElementById('player').classList.contains('is-page-full'),
      gap: Math.round(document.getElementById('playerWindow').getBoundingClientRect().left),
      orderOn: document.getElementById('btnOrder').classList.contains('is-on'),
      stored: localStorage.getItem('mv.order'),
      playing: document.getElementById('video').paused === false,
      name: document.getElementById('playerName').textContent,
    }
  })()`)
  console.log('看视频:', JSON.stringify(watch))
  check('顶栏有「看视频」按钮', watch.ok === true && watch.buttonVisible === true, JSON.stringify(watch))
  check('点开就是铺满这一页（桌面也一样）', watch.pageFull === true && watch.gap === 0, JSON.stringify(watch))
  check('打开就是随机播放', watch.orderOn === true && String(watch.stored).includes('random'), JSON.stringify(watch))
  check('确实在放，而且放的是列表里的一条', watch.playing === true && String(watch.name).length > 0, JSON.stringify(watch))
  await evaluate('document.getElementById("btnClose").click()')
  await sleep(500)
  // 收尾：顺序切回去，别把「随机」留给后面的人。
  await evaluate(`(() => { const button = document.getElementById('btnOrder'); if (button !== null) button.click() })()`)
  await sleep(300)

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
