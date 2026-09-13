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
// 真机的媒体特性也要模拟：只改视口的话 `(hover: none)` / `(pointer: coarse)`
// 这些规则一条都不会命中，而它们正是触摸端专属的那部分（比如卡片上的播放圈）。
await send('Emulation.setEmulatedMedia', {
  media: '',
  features: [
    { name: 'hover', value: 'none' },
    { name: 'pointer', value: 'coarse' },
    { name: 'any-hover', value: 'none' },
    { name: 'any-pointer', value: 'coarse' },
  ],
})
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

  // 横向溢出的第一现场是**内容区**（`#content` 自己就是滚动容器），不是 document：
  // 早先工具条右侧那排按钮是 flex: none + nowrap，给内容区钉了一条 432px 的底宽，
  // 于是窄屏上只有内容区能横向滚、document 宽度却正常——只查 document 的断言
  // 一条都发现不了。这里同时量内容区，并且再压一档 320px。
  const narrowProbe = `(() => {
    const content = document.getElementById('content')
    const side = document.querySelector('.toolbar-side')
    return {
      innerWidth: window.innerWidth,
      contentClientW: content.clientWidth,
      contentScrollW: content.scrollWidth,
      contentPadLeft: parseFloat(getComputedStyle(content).paddingLeft),
      sideRight: Math.round(side.getBoundingClientRect().right),
      sideWrap: getComputedStyle(side).flexWrap,
      firstButtonLeft: Math.round(side.firstElementChild.getBoundingClientRect().left),
      stickyPosition: getComputedStyle(document.getElementById('toolbarSticky')).position,
    }
  })()`
  const wide = await evaluate(narrowProbe)
  check('内容区没有横向溢出（390px）', wide.contentScrollW <= wide.contentClientW + 1, JSON.stringify(wide))
  check('工具条那排按钮没顶出屏幕（390px）', wide.sideRight <= wide.innerWidth + 1, JSON.stringify(wide))
  check('手机上那排按钮靠左排', Math.abs(wide.firstButtonLeft - wide.contentPadLeft) <= 2, JSON.stringify(wide))
  check('手机上工具条不吸顶（跟着内容滚）', wide.stickyPosition === 'static', JSON.stringify(wide))

  await send('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 320,
    screenHeight: 844,
  })
  await sleep(700)
  const narrow = await evaluate(narrowProbe)
  check('320px 窄屏也不横向溢出', narrow.contentScrollW <= narrow.contentClientW + 1, JSON.stringify(narrow))
  check('工具条按钮在窄屏允许换行', narrow.sideWrap === 'wrap', JSON.stringify(narrow))
  check('窄屏下按钮仍在屏幕内', narrow.sideRight <= narrow.innerWidth + 1, JSON.stringify(narrow))
  check('窄屏下按钮也靠左', Math.abs(narrow.firstButtonLeft - narrow.contentPadLeft) <= 2, JSON.stringify(narrow))

  // 恢复 iPhone 视口：后面的手势坐标都按 390 算。
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  })
  await sleep(600)

  // 网格大小三档：手机上「大」必须是一屏一张（最宽那档就该只有一个封面），
  // 「中」是原来那档、开箱默认就是它（readTile 曾把空 localStorage 读成「小」，
  // 手机上一屏四列、一张卡 80 多像素，整张卡活像一个大的播放按钮）。
  const openingTile = await evaluate(`[...document.querySelectorAll('[data-tile-btn]')].filter((node) => node.classList.contains('is-active')).map((node) => node.dataset.tileBtn).join(',')`)
  check('手机上开箱默认是「中」', openingTile === '1', openingTile)
  const tileShape = (index) =>
    evaluate(`(async () => {
      document.querySelector('[data-tile-btn="${index}"]').click()
      await new Promise((r) => setTimeout(r, 700))
      const cards = [...document.querySelectorAll('#grid .card')]
      if (cards.length === 0) return null
      const top = Math.round(cards[0].getBoundingClientRect().top)
      const ring = document.querySelector('.play-overlay .ring')
      return {
        width: Math.round(cards[0].getBoundingClientRect().width),
        columns: cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 2).length,
        ring: ring === null ? 0 : Math.round(ring.getBoundingClientRect().width),
        active: [...document.querySelectorAll('[data-tile-btn]')].filter((node) => node.classList.contains('is-active')).map((node) => node.dataset.tileBtn),
      }
    })()`)
  const tileSmall = await tileShape(0)
  const tileMiddle = await tileShape(1)
  const tileLarge = await tileShape(2)
  console.log('网格三档:', JSON.stringify({ small: tileSmall, middle: tileMiddle, large: tileLarge }))
  check('手机上「小」列数更多', tileSmall !== null && tileSmall.columns > tileMiddle.columns, JSON.stringify({ small: tileSmall, middle: tileMiddle }))
  check('手机上「大」是一屏一张', tileLarge !== null && tileLarge.columns === 1, JSON.stringify(tileLarge))
  check('手机上「大」比「中」大一半以上', tileLarge !== null && tileLarge.width > tileMiddle.width * 1.5, `${tileMiddle?.width} → ${tileLarge?.width}`)
  check('触摸端小瓦片上也没有播放圈', tileSmall !== null && tileSmall.ring === 0, JSON.stringify(tileSmall))
  await tileShape(1)

  const topbarHeight = await evaluate(`document.querySelector('.topbar').getBoundingClientRect().height`)
  check('顶栏高度收敛', topbarHeight <= 56, `实际 ${topbarHeight}`)

  // 触摸端每张封面上不该再压一个播放圈：一屏十几张卡全是按钮。视频的身份由
  // 左上角「▶ 视频」角标表达，点开就是播放。（鼠标端仍然是悬停才出现。）
  const cardOverlay = await evaluate(`(() => {
    const card = [...document.querySelectorAll('.card-video')].find((node) => node.querySelector('.play-overlay') !== null)
    if (card === undefined) return null
    const overlay = card.querySelector('.play-overlay')
    return {
      coarse: window.matchMedia('(pointer: coarse)').matches,
      noHover: window.matchMedia('(hover: none)').matches,
      overlayDisplay: getComputedStyle(overlay).display,
      kindBadge: card.querySelector('.kind-badge')?.textContent ?? '',
    }
  })()`)
  check('触摸端卡片上不再压播放圈', cardOverlay !== null && cardOverlay.overlayDisplay === 'none', JSON.stringify(cardOverlay))
  check('「视频」身份仍由角标说明', cardOverlay !== null && cardOverlay.kindBadge.includes('视频'), JSON.stringify(cardOverlay))
  check('模拟的是触摸端媒体特性', cardOverlay !== null && cardOverlay.coarse === true && cardOverlay.noHover === true, JSON.stringify(cardOverlay))

  // ── 2. 触摸目标尺寸 ─────────────────────────────────────────────────────
  //
  // 早先这里还量 settingsBtn / viewToggle：设置抽屉和「视图切换」按钮都已经从
  // 页面上拿掉（目录改在 dsh 的插件配置里加，视图改由工具条上那两枚按钮承担），
  // 所以只量还在的那两个——点已经不存在的 id 只会把整轮测试打断。
  const targets = await evaluate(`(() => {
    const ids = ['sortToggle', 'refreshBtn']
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

  // ── 4. 播放器就是手机上的「刷」：整页打开 + 上下滑换条 + 顺序 / 随机 ─────
  //
  // 独立的刷视频面板已经拿掉：点开一条视频，播放器直接铺满这一页，手指往上一推
  // 就是下一条。这一段钉住三件事：打开即整页、上下滑换条、顺序 / 随机。
  const playerOpen = await evaluate(`(async () => {
    const card = [...document.querySelectorAll('.card[data-key]')].find((node) => node.classList.contains('card-video'))
    if (card === undefined) return { ok: false, reason: '这个目录里没有视频卡片' }
    card.click()
    const deadline = Date.now() + 12000
    while (Date.now() < deadline && document.getElementById('player').hidden) await new Promise((r) => setTimeout(r, 200))
    return { ok: true, key: card.dataset.key, hidden: document.getElementById('player').hidden }
  })()`)
  console.log('播放器打开:', JSON.stringify(playerOpen))

  if (playerOpen.ok !== true) {
    check('列表里有视频卡片（手机端的刷视频要在播放器里验证）', false, JSON.stringify(playerOpen))
  } else {
    await sleep(1200)
    const style = await evaluate(`(() => {
      const player = document.getElementById('player')
      const rect = document.getElementById('playerWindow').getBoundingClientRect()
      return {
        pageFull: player.classList.contains('is-page-full'),
        gapX: Math.round(rect.left),
        gapY: Math.round(rect.top),
        width: Math.round(rect.width),
        viewport: window.innerWidth,
        orderButton: document.getElementById('btnOrder') !== null,
      }
    })()`)
    console.log('播放器形态:', JSON.stringify(style))
    check('手机上打开播放器就是整页（不是小窗）', style.pageFull === true && style.gapX === 0 && style.gapY === 0, JSON.stringify(style))
    check('控件条上有顺序 / 随机按钮', style.orderButton === true, JSON.stringify(style))

    const currentName = () => evaluate(`document.getElementById('playerName').textContent`)
    const first = await currentName()

    // 上滑 → 下一条，而且要是**跟着手指滑**的那种：中途画面必须有位移、底下要
    // 露出下一条的封面，松手之后才真的换条。这里手工发触摸序列，在松手前取样。
    const dragPoint = (y) => [{ x: 195, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }]
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: dragPoint(700) })
    for (const y of [660, 600, 520, 440]) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: dragPoint(y) })
      await sleep(16)
    }
    const midDrag = await evaluate(`(() => {
      const video = document.getElementById('video')
      const peek = document.getElementById('playerPeek')
      return {
        transform: getComputedStyle(video).transform,
        peekVisible: peek.hidden === false,
        peekPoster: (peek.style.backgroundImage || '').includes('/reel/thumb'),
        peekName: document.getElementById('playerPeekName').textContent,
        name: document.getElementById('playerName').textContent,
      }
    })()`)
    console.log('拖动中:', JSON.stringify(midDrag))
    check('拖动时画面跟着手指走', midDrag.transform !== 'none' && midDrag.transform !== '', midDrag.transform)
    check('拖动时露出邻居的封面', midDrag.peekVisible === true && (midDrag.peekPoster || midDrag.peekName !== ''), JSON.stringify(midDrag))
    check('拖动时还没换条', midDrag.name === first, `${first} → ${midDrag.name}`)

    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(2200)
    const second = await currentName()
    check('松手滑到下一条', second !== first && second !== '', `${first} → ${second}`)
    const settled = await evaluate(`(() => ({
      transform: document.getElementById('video').style.transform,
      peekHidden: document.getElementById('playerPeek').hidden,
    }))()`)
    check('滑完把位移和衬底收干净', settled.transform === '' && settled.peekHidden === true, JSON.stringify(settled))

    // 慢慢拖一点点（距离和速度都没过阈值）松手：应该弹回来，不换条。
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: dragPoint(600) })
    for (const y of [585, 570, 555]) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: dragPoint(y) })
      await sleep(80)
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await sleep(800)
    const snapped = await evaluate(`(() => ({
      name: document.getElementById('playerName').textContent,
      transform: document.getElementById('video').style.transform,
      peekHidden: document.getElementById('playerPeek').hidden,
    }))()`)
    check('没滑过一半会弹回来、不换条', snapped.name === second && snapped.transform === '' && snapped.peekHidden === true, JSON.stringify(snapped))

    // 下滑 → 回到上一条（快手一甩也算数，所以用连续的拖动）。
    await touchDrag({ x: 195, y: 220 }, { x: 195, y: 700 }, 14)
    await sleep(2200)
    const back = await currentName()
    check('下滑回上一条', back === first, `${second} → ${back}`)

    // 顺序 / 随机：点一下切档，当前这条不能跟着乱跳（只是它后面的次序变了）。
    const order = await evaluate(`(async () => {
      const button = document.getElementById('btnOrder')
      const snap = () => ({
        on: button.classList.contains('is-on'),
        title: button.title,
        stored: localStorage.getItem('mv.order'),
        name: document.getElementById('playerName').textContent,
      })
      const before = snap()
      button.click()
      await new Promise((r) => setTimeout(r, 300))
      const after = snap()
      // 收尾：切回顺序，后面的用例不该被这一段改掉的顺序影响。
      button.click()
      await new Promise((r) => setTimeout(r, 300))
      return { before, after, restored: localStorage.getItem('mv.order') }
    })()`)
    console.log('顺序 / 随机:', JSON.stringify(order))
    check('点一下切到随机', order.before.on === false && order.after.on === true, JSON.stringify(order))
    check('随机的状态记住了', String(order.after.stored).includes('random'), String(order.after.stored))
    check('切顺序时当前这条不动', order.before.name === order.after.name, JSON.stringify(order))
    check('收尾切回顺序', String(order.restored).includes('seq'), String(order.restored))

    await evaluate('document.getElementById("btnClose").click()')
    await sleep(500)
    const closed = await evaluate(`document.getElementById('player').hidden === true && document.getElementById('player').classList.contains('is-page-full') === false`)
    check('关掉播放器回到列表（并收回整页）', closed === true)

    // 面板声明了 touch-action: none（为了接住上下滑），顺手钉住「音量条还能拖」：
    // 这两件事在触摸端是互相牵制的，回归时最先坏的就是它。
    await evaluate(`(() => {
      const card = [...document.querySelectorAll('.card[data-key]')].find((node) => node.classList.contains('card-video'))
      card.click()
    })()`)
    await sleep(1500)
    const slider = await evaluate(`(() => {
      const rect = document.getElementById('volumeRange').getBoundingClientRect()
      return { left: Math.round(rect.left), right: Math.round(rect.right), y: Math.round(rect.top + rect.height / 2), value: Number(document.getElementById('volumeRange').value) }
    })()`)
    await touchDrag({ x: slider.right - 6, y: slider.y }, { x: slider.left + 6, y: slider.y }, 8)
    await sleep(400)
    const dragged = await evaluate('Number(document.getElementById("volumeRange").value)')
    check('音量条在手机上仍能拖', dragged < slider.value, `${slider.value} → ${dragged}`)
    await evaluate('document.getElementById("btnClose").click()')
    await sleep(300)
  }

  // ── 5. 控制台必须干净 ───────────────────────────────────────────────────
  check('手机端没有控制台错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {})
  chrome.kill('SIGKILL')
  await sleep(300)
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* Chrome 有时还攥着 profile 目录，删不掉不该让测试结果变成崩栈 */
  }
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('手机端验证通过 ✓')

