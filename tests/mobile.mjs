/**
 * 手机端真机验证：用 Chrome 的 CDP 开一个触摸模拟的窄屏页面，真的去点、
 * 去滑、去拖，然后读回页面状态。
 *
 * 之所以要这么验：触摸手势（捏合、横滑、拖动进度条）在桌面鼠标下全都不会
 * 走到同一条代码路径，光看代码是发现不了 pointercancel 这类问题的。
 *
 * 用法：node tests/mobile.mjs <origin>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:3091'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const failures = []
let passes = 0

const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))

// ── 启动 headless Chrome ───────────────────────────────────────────────────

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-chrome-'))
const port = 9333
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-gpu',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

/** 等 DevTools 端点起来。 */
async function waitForDevTools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) return await response.json()
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Chrome DevTools endpoint never came up')
}

const version = await waitForDevTools()
check('Chrome 已启动', typeof version.webSocketDebuggerUrl === 'string')

/** 打开一个新标签页并连上它。 */
async function openTarget() {
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((settle, fail) => {
    socket.addEventListener('open', settle, { once: true })
    socket.addEventListener('error', fail, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.fail(new Error(`${entry.method}: ${message.error.message}`))
    else entry.settle(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((settle, fail) => {
      nextId += 1
      pending.set(nextId, { settle, fail, method })
      socket.send(JSON.stringify({ id: nextId, method, params }))
    })
  return { send, socket, targetId: created.id }
}

const { send, socket, targetId } = await openTarget()

await send('Page.enable')
await send('Runtime.enable')
await send('Network.enable')
// iPhone 12/13 的逻辑视口 + 触摸 + 移动 UA，一次到位。
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 390,
  screenHeight: 844,
})
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await send('Emulation.setUserAgentOverride', {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
})

/** 在页面里求值。 */
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    // CDP 的 text 常常只是 "Uncaught"，真正的信息在 exception.description 里；
    // 只报 text 会让失败看起来毫无线索。
    const details = result.exceptionDetails
    const detail = details.exception?.description ?? details.text ?? 'evaluate failed'
    throw new Error(detail.split('\n').slice(0, 3).join(' | '))
  }
  return result.result.value
}

/** 收集控制台错误（带堆栈，便于定位）。 */
const consoleErrors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    consoleErrors.push(`${details.text} :: ${(details.exception?.description ?? '').split('\n').slice(0, 3).join(' | ')}`)
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '))
  }
})

/** 用 CDP 派发一次真实的触摸拖动。 */
const touchDrag = async (from, to, steps = 12) => {
  const point = (x, y) => [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from.x, from.y) })
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: point(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio),
    })
    await sleep(12)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** 点击一个点。 */
const tap = async (x, y) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }] })
  await sleep(40)
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * 双指捏合：两根手指同时在屏幕上移动。
 *
 * 必须用 CDP 的真实多点触摸，而不是页面里合成的 PointerEvent —— 浏览器
 * 只有走自己的命中测试才会在 touch-action 生效时发 pointercancel，而那正
 * 是触摸端最容易漏掉的路径。
 */
const pinch = async (finger1From, finger2From, finger1To, finger2To, steps = 10) => {
  const points = (a, b) => [
    { x: a.x, y: a.y, radiusX: 8, radiusY: 8, force: 1, id: 1 },
    { x: b.x, y: b.y, radiusX: 8, radiusY: 8, force: 1, id: 2 },
  ]
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(finger1From, finger2From) })
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps
    const lerp = (from, to) => ({ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio })
    await send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: points(lerp(finger1From, finger1To), lerp(finger2From, finger2To)),
    })
    await sleep(16)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/**
 * 等一个条件成立，最多等 timeoutMs。
 *
 * 固定 sleep 会在慢机器或大目录上假失败，在快机器上白等；直接等真实信号。
 */
const waitFor = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await evaluate(expression)) === true) return true
    await sleep(200)
  }
  return false
}

try {
  // ── 0. 先问服务端要一个有内容的目录 ─────────────────────────────────────
  //
  // 不能假设根目录里有媒体：真实媒体库里根目录常常只是一层分类目录，而
  // 且图片和视频未必都有。所以先看根目录，没媒体就下沉一层找，再按实际
  // 找到的东西决定后面测什么。
  const api = async (path) => JSON.parse(await (await fetch(`${origin}${path}`)).text())
  const session = await api('/reel/api/session')
  check('服务端有可用的媒体目录', (session.roots ?? []).length > 0, JSON.stringify(session.roots))

  let targetKey = 'r0'
  let mediaCount = 0
  let imageCount = 0
  const rootListing = await api('/reel/api/list?k=r0')
  mediaCount = (rootListing.files ?? []).length
  imageCount = (rootListing.files ?? []).filter((item) => item.kind === 'image').length
  if (mediaCount === 0) {
    // 根目录没有媒体：往下找第一层里有媒体的子目录。
    for (const folder of (rootListing.folders ?? []).slice(0, 12)) {
      const listing = await api(`/reel/api/list?k=${encodeURIComponent(folder.key)}`)
      if ((listing.files ?? []).length > 0) {
        targetKey = folder.key
        mediaCount = listing.files.length
        imageCount = listing.files.filter((item) => item.kind === 'image').length
        break
      }
    }
  }
  check('找到了可用于测试的目录', mediaCount > 0, `目录 ${targetKey} 里有 ${mediaCount} 个媒体文件`)
  console.log(`测试目录：${targetKey}（${mediaCount} 个文件，其中 ${imageCount} 张图片）`)

  // ── 1. 页面在手机视口下的布局 ───────────────────────────────────────────
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(targetKey)}` })
  // 等真的画出卡片，而不是赌一个固定的毫秒数。
  const rendered = await waitFor('document.querySelectorAll(".card").length > 0')
  check('首屏渲染出卡片', rendered === true, `等了 15s 仍然 0 张卡片`)

  const layout = await evaluate(`(() => {
    const scroller = document.querySelector('.feed-scroller')
    return {
      // 移动端模拟下 window.innerWidth 是布局视口，可能比 CSS 视口宽；
      // 判断「手机宽度」要看 visualViewport。
      cssWidth: Math.round(window.visualViewport ? window.visualViewport.width : window.innerWidth),
      innerWidth: window.innerWidth,
      ua: navigator.userAgent.includes('iPhone'),
      sidebarHidden: getComputedStyle(document.getElementById('sidebar')).display === 'none',
      gridColumns: getComputedStyle(document.getElementById('grid')).gridTemplateColumns.split(' ').length,
      hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      viewportMeta: document.querySelector('meta[name="viewport"]')?.content ?? null,
    }
  })()`)

  check('CSS 视口是手机宽度', layout.cssWidth === 390, `实际 ${layout.cssWidth}`)
  check('页面对触摸端不使用固定宽度', layout.hasHorizontalOverflow === false, `scrollWidth 超了 ${layout.innerWidth}`)
  check('声明了 viewport meta', layout.viewportMeta === 'width=device-width, initial-scale=1, viewport-fit=cover', layout.viewportMeta)
  check('触摸 UA 生效', layout.ua === true)
  check('侧边栏在窄屏隐藏', layout.sidebarHidden === true)
  check('网格是多列自适应', layout.gridColumns >= 2, `实际 ${layout.gridColumns} 列`)

  const topbarHeight = await evaluate(`document.querySelector('.topbar').getBoundingClientRect().height`)
  check('顶栏高度收敛', topbarHeight <= 56, `实际 ${topbarHeight}`)

  // ── 2. 触摸目标尺寸 ─────────────────────────────────────────────────────
  const targets = await evaluate(`(() => {
    const ids = ['settingsBtn', 'viewToggle', 'sortToggle', 'refreshBtn']
    return ids.map((id) => {
      const rect = document.getElementById(id).getBoundingClientRect()
      return { id, w: Math.round(rect.width), h: Math.round(rect.height) }
    })
  })()`)
  for (const target of targets) {
    check(`${target.id} 触摸目标 ≥ 32px`, target.w >= 32 && target.h >= 32, `${target.w}×${target.h}`)
  }

  // ── 3. 图片查看器：捏合缩放 + 横滑翻页 ──────────────────────────────────
  //
  // 只在真的有图片时测。真实媒体库里可能全是视频（这个仓库验证时用的那份
  // 就是），此时空手断言「有图片卡片」只会制造假失败。
  const imageCards = await evaluate(`document.querySelectorAll('.card-image').length`)
  if (imageCount === 0) {
    console.log('  该目录没有图片，跳过查看器手势测试')
  } else {
    check('列表里有图片卡片', imageCards > 0, `实际 ${imageCards}`)
  }

  if (imageCards > 0) {
    await evaluate(`document.querySelector('.card-image').click()`)
    await sleep(700)
    const opened = await evaluate(`document.getElementById('viewer').hidden === false`)
    check('点卡片打开查看器', opened === true)

    // 横滑 → 下一张（需要至少两张图）
    if (imageCards > 1) {
      const before = await evaluate(`document.getElementById('viewerMeta').textContent`)
      await touchDrag({ x: 300, y: 420 }, { x: 90, y: 425 })
      await sleep(500)
      const after = await evaluate(`document.getElementById('viewerMeta').textContent`)
      check('横滑翻到下一张', before !== after, `${before} → ${after}`)
      await touchDrag({ x: 90, y: 420 }, { x: 300, y: 425 })
      await sleep(500)
      const back = await evaluate(`document.getElementById('viewerMeta').textContent`)
      check('横滑翻回上一张', back === before, `${after} → ${back}`)
    }

    // 双指捏合 → 缩放变大。用真实的两指触摸序列，才走得到 pointercancel /
    // 指针表这条路径；单指合成事件测不到。
    const scaleOf = () => evaluate(`new DOMMatrixReadOnly(getComputedStyle(document.getElementById('viewerImage')).transform).a`)
    const scaleBefore = await scaleOf()
    await pinch({ x: 130, y: 420 }, { x: 260, y: 420 }, { x: 60, y: 420 }, { x: 330, y: 420 })
    await sleep(300)
    const scaleAfter = await scaleOf()
    check('双指捏合放大', scaleAfter > scaleBefore + 0.2, `${scaleBefore} → ${scaleAfter}`)

    // 再捏回去 → 缩小
    await pinch({ x: 60, y: 420 }, { x: 330, y: 420 }, { x: 150, y: 420 }, { x: 240, y: 420 })
    await sleep(300)
    const scaleBack = await scaleOf()
    check('双指收拢缩小', scaleBack < scaleAfter - 0.1, `${scaleAfter} → ${scaleBack}`)

    await evaluate(`document.getElementById('imageClose').click()`)
    await sleep(300)
  }

  // ── 4. 刷视频模式：滑动吸附 + 横滑翻页 + 点按暂停 ───────────────────────
  await evaluate(`document.querySelector('[data-mode-btn="feed"]').click()`)
  const slidesReady = await waitFor('document.querySelectorAll(".slide").length > 0')
  check('刷视频在 15s 内出内容', slidesReady === true)

  const feedState = await evaluate(`(() => {
    const scroller = document.querySelector('.feed-scroller')
    return {
      slides: document.querySelectorAll('.slide').length,
      scrollerHeight: scroller === null ? -1 : Math.round(scroller.getBoundingClientRect().height),
      scrollHeight: scroller === null ? -1 : scroller.scrollHeight,
      snapType: scroller === null ? '(缺元素)' : getComputedStyle(scroller).scrollSnapType,
      feedPaneHidden: document.getElementById('feedPane')?.hidden ?? '(缺元素)',
      feedEmptyHidden: document.getElementById('feedEmpty')?.hidden ?? '(缺元素)',
      toasts: document.getElementById('toasts')?.textContent ?? '',
    }
  })()`)
  check('刷视频有内容', feedState.slides > 0, JSON.stringify(feedState))
  check('滚动容器占满视口', feedState.scrollerHeight >= 700, `实际 ${feedState.scrollerHeight}`)
  check('开启了纵向吸附', feedState.snapType.includes('y'), feedState.snapType)

  // 纵向滑动 → 到第二条
  const firstTop = await evaluate(`Math.round(document.querySelector('.slide').getBoundingClientRect().top)`)
  await touchDrag({ x: 195, y: 640 }, { x: 195, y: 200 }, 14)
  await sleep(900)
  const secondTop = await evaluate(`Math.round(document.querySelector('.slide').getBoundingClientRect().top)`)
  check('上滑切到下一条', secondTop < firstTop - 100, `${firstTop} → ${secondTop}`)

  const scrolled = await evaluate(`Math.round(document.querySelector('.feed-scroller').scrollTop)`)
  check('scroller 真的滚动了', scrolled > 100, `实际 ${scrolled}`)

  // 点按画面 → 暂停/播放切换（当前条是图片时不适用，所以只验证不报错）
  await tap(195, 420)
  await sleep(400)

  // 横向滑动也不应该把页面搞坏
  await touchDrag({ x: 320, y: 420 }, { x: 80, y: 425 })
  await sleep(700)
  const stillAlive = await evaluate(`document.querySelectorAll('.slide').length > 0 && document.getElementById('feedPane').hidden === false`)
  check('横滑后刷视频模式仍在', stillAlive === true)

  // ── 5. 控制台必须干净 ───────────────────────────────────────────────────
  check('手机端没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {})
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
console.log('手机端验证通过 ✓')

