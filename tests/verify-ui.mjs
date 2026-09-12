/**
 * 界面结构验证：多根目录、文件夹行、递归模式、封面。
 *
 * 用法：node tests/verify-ui.mjs <origin>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2]
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const failures = []
let passes = 0
const check = (label, ok, detail) => {
  if (ok) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-ui-'))
const port = 9343
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
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
    errors.push(`${m.params.exceptionDetails?.text} :: ${(m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]}`)
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
    const d = r.exceptionDetails
    throw new Error(`${d.text} :: ${(d.exception?.description ?? '').split('\n').slice(0, 2).join(' | ')}`)
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

/**
 * 显式把工具条恢复到一个已知状态。
 *
 * 这个脚本连续做十几段互不相干的检查，而每次点击都会改变 范围/内容/分组。
 * 早期版本靠「上一步留下的状态」接着做，结果一处改动就让后面几条假失败。
 * 现在每段开头先声明自己需要什么状态，而不是猜。
 *
 * @param {{scope?: 'dir'|'all', kinds?: 'all'|'video', group?: 'flat'|'folder'}} want - 目标状态。
 */
const setUiState = async (want) => {
  const clicks = []
  if (want.scope !== undefined) clicks.push(`['data-scope-btn', '${want.scope}']`)
  if (want.kinds !== undefined) clicks.push(`['data-kind-btn', '${want.kinds}']`)
  if (want.group !== undefined) clicks.push(`['data-group-btn', '${want.group}']`)
  await ev(`(() => {
    for (const [attr, value] of [${clicks.join(', ')}]) {
      const node = document.querySelector('[' + attr + '="' + value + '"]')
      if (node !== null && !node.classList.contains('is-active')) node.click()
    }
    return true
  })()`)
  await sleep(1200)
  await waitFor('document.querySelectorAll(".card, .folder-group, .folder-row").length > 0', 25000)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  // 让 app.js 把 renderTree 每次看到几个根打到控制台，由测试读回来。
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__mvDebug = true; window.__mvLogs = []; const __origLog = console.log; console.log = (...a) => { window.__mvLogs.push(a.join(" ")); __origLog(...a); };' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/reel?k=r0` })
  check('首屏出现卡片', await waitFor('document.querySelectorAll(".card").length > 0'))
  const debugLogs = await ev('JSON.stringify(window.__mvLogs ?? [])')
  console.log('renderTree 日志:', debugLogs)

  // 右侧列表刷新时，左侧树**一个节点都不该重建**。
  //
  // 用户的要求原话是「左侧树只需要加载一遍」。所以这里盯着树容器上的 append：
  // 点刷新会让右边重新拉列表，早先这会顺带把树也重画一遍（append 三次根），
  // 看上去就是「树随着右边的列表在加载」。现在树与列表是解耦的，append 必须是 0。
  const spy = await ev(`(async () => {
    const tree = document.getElementById('tree')
    const record = []
    const originalAppend = tree.appendChild.bind(tree)
    tree.appendChild = (node) => {
      const result = originalAppend(node)
      record.push('append ' + (node.className || node.tagName))
      return result
    }
    const before = [...tree.querySelectorAll('.tree-folder')]
    document.getElementById('refreshBtn').click()
    await new Promise((r) => setTimeout(r, 2000))
    tree.appendChild = originalAppend
    const after = [...tree.querySelectorAll('.tree-folder')]
    return {
      record,
      children: tree.children.length,
      classes: [...tree.children].map((c) => c.className),
      foldersBefore: before.length,
      foldersAfter: after.length,
      sameFolderNodes: before.length > 0 && before.every((node, i) => node === after[i]),
    }
  })()`)
  console.log('树重建追踪:', JSON.stringify(spy))
  check('刷新右侧列表不会重建左侧树', spy.record.length === 0, JSON.stringify(spy))
  check('刷新后树里的行还是同一批节点', spy.sameFolderNodes === true, JSON.stringify({ before: spy.foldersBefore, after: spy.foldersAfter }))

  // 侧边栏必须在宽屏下真的可见——「看不到侧边栏」是硬故障，而前面的结构
  // 断言全过也可能发生（节点在 DOM 里，但被 CSS 或折叠类藏起来了）。
  const sidebarProbe = await ev(`(() => {
    const bar = document.getElementById('sidebar')
    const cs = getComputedStyle(bar)
    const rect = bar.getBoundingClientRect()
    return {
      display: cs.display,
      visibility: cs.visibility,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      flex: cs.flex,
      bodyClass: document.body.className,
      collapsed: document.body.classList.contains('sidebar-collapsed'),
      sidebarFlag: localStorage.getItem('mv.sidebar'),
      sidebarWidthVar: getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
      matchesMobile: window.matchMedia('(max-width: 720px)').matches,
      rootCount: document.querySelectorAll('#tree .tree-root').length,
      treeHeight: Math.round(document.getElementById('tree').getBoundingClientRect().height),
    }
  })()`)
  console.log('侧边栏探测:', JSON.stringify(sidebarProbe))
  check('宽屏下侧边栏可见（display）', sidebarProbe.display !== 'none', sidebarProbe.display)
  check('宽屏下侧边栏有宽度', sidebarProbe.width >= 200, `${sidebarProbe.width}px`)
  check('宽屏下侧边栏有高度', sidebarProbe.height > 200, `${sidebarProbe.height}px`)
  check('没有残留的折叠状态', sidebarProbe.collapsed === false, `mv.sidebar=${sidebarProbe.sidebarFlag}`)

  // ── 1. 多根目录：树里必须有每一个根，而不是只有当前那个 ──────────────
  const rootInfo = await ev(`(async () => {
    const session = await fetch('/reel/api/session').then((r) => r.json())
    return {
      apiRoots: session.roots.map((r) => r.index + ':' + r.label),
      treeRoots: [...document.querySelectorAll('#tree .tree-root')].length,
      treeNames: [...document.querySelectorAll('#tree .tree-root-name')].map((n) => n.textContent.trim()),
      treeHTML: document.getElementById('tree').innerHTML.slice(0, 300),
    }
  })()`)
  console.log('API 根:', rootInfo.apiRoots.join(' | '))
  console.log('树里的根:', rootInfo.treeNames.join(' | '))
  console.log('树 HTML:', rootInfo.treeHTML.replace(/\s+/g, ' ').slice(0, 200))
  const session = rootInfo.apiRoots.length
  const treeRoots = rootInfo.treeRoots

  // 手工再画一次树：能画出来说明是时序问题，画不出来说明是循环本身的问题。
  const rootCause = await ev(`(async () => {
    const response = await fetch('/reel/api/session').then((r) => r.json())
    // app.js 是 IIFE，内部状态拿不到；只能从可观察的行为推断。
    // 线索一：API 返回几个根。
    // 线索二：树里画了几个根。
    // 线索三：其它用到 roots 的地方（设置抽屉）认为有几个。
    document.getElementById('settingsBtn').click()
    await new Promise((r) => setTimeout(r, 1200))
    const listedInDrawer = document.querySelectorAll('#rootList .root-item').length
    const drawerText = document.getElementById('rootList').textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)
    document.getElementById('drawerClose').click()
    return { apiRoots: response.roots.length, listedInDrawer, drawerText }
  })()`)
  console.log('API 根数:', rootCause.apiRoots, '| 抽屉里列出:', rootCause.listedInDrawer)
  console.log('抽屉文本:', rootCause.drawerText)
  check(`侧栏列出全部 ${session} 个根目录`, treeRoots === session, `树里有 ${treeRoots} 个`)

  const rootLabels = await ev('[...document.querySelectorAll("#tree .tree-root-name")].map(n=>n.textContent.trim()).join(" | ")')
  check('每个根都显示名字', rootLabels.split('|').length === session, rootLabels)

  // 第二个根默认收起，点它的名字应该展开出子目录（点击 = 切换展开，不导航）
  if (session > 1) {
    const beforeExpand = await ev('document.querySelectorAll("#tree .tree-root:nth-child(2) .tree-folder").length')
    await ev(`document.querySelectorAll('#tree .tree-root-name')[1].click()`)
    await sleep(1800)
    const afterExpand = await ev('document.querySelectorAll("#tree .tree-root:nth-child(2) .tree-folder").length')
    check('第二个根可以展开出子目录', afterExpand > 0, `展开前 ${beforeExpand} 行，展开后 ${afterExpand} 行`)
  }

  // ── 2. 文件夹是一行一个，不是卡片 ─────────────────────────────────────
  // 点名字是切换展开，所以这里用「先确保展开」的方式回到第一个根的内容。
  await ev(`(async () => {
    const wrapper = document.querySelectorAll('#tree .tree-root')[0]
    if (wrapper.querySelector('.tree-children').hidden) wrapper.querySelector('.tree-root-name').click()
    return true
  })()`)
  check('第一个根展开后有数据', await waitFor('document.querySelectorAll(".folder-row").length > 0'))
  const folderRow = await ev(`(() => {
    const row = document.querySelector('.folder-row')
    const rect = row.getBoundingClientRect()
    const cs = getComputedStyle(row)
    return { h: Math.round(rect.height), w: Math.round(rect.width), display: cs.display, hasThumb: row.querySelector('img, video') !== null }
  })()`)
  check('文件夹行是窄条不是大卡片', folderRow.h < 60, `高度 ${folderRow.h}px`)
  check('文件夹行里没有缩略图', folderRow.hasThumb === false)
  const folderCount = await ev('document.querySelectorAll(".folder-row").length')
  const cardCount = await ev('document.querySelectorAll(".card").length')
  check('文件夹与媒体分开渲染', folderCount > 0 && cardCount > 0, `文件夹 ${folderCount} 行 / 媒体 ${cardCount} 张`)

  // ── 3. 递归「全部」模式：不显示文件夹，列出所有层级 ────────────────────
  await setUiState({ scope: 'all', kinds: 'video', group: 'flat' })
  const folderCountBefore = await ev('document.querySelectorAll(".folder-row").length')
  const scopeProbe = await ev(`(async () => {
    const btn = document.querySelector('[data-scope-btn="all"]')
    btn.click()
    await new Promise((r) => setTimeout(r, 2500))
    return {
      buttonFound: btn !== null,
      buttonActive: btn.classList.contains('is-active'),
      scopeInStorage: localStorage.getItem('mv.scope'),
      folders: document.querySelectorAll('.folder-row').length,
      cards: document.querySelectorAll('.card').length,
      summary: document.getElementById('summary').textContent,
      toasts: document.getElementById('toasts').textContent,
    }
  })()`)
  console.log('scope 探测:', JSON.stringify(scopeProbe))
  check('切到递归模式后按钮点亮', scopeProbe.buttonActive === true)
  check('递归模式不显示文件夹', scopeProbe.folders === 0, `还有 ${scopeProbe.folders} 行`)
  check('递归模式列出了所有层级', scopeProbe.cards === 143 || scopeProbe.cards > folderCountBefore, `递归 ${scopeProbe.cards} 张 vs 本层 ${folderCountBefore} 张`)
  check('摘要说明含所有子目录', scopeProbe.summary.includes('含所有子目录'), scopeProbe.summary)
  const allState = await ev(`(() => ({
    crumbs: document.getElementById('crumbs').textContent,
    where: document.querySelectorAll('.card-where').length,
    whereSample: document.querySelector('.card-where')?.textContent ?? '',
  }))()`)
  check('递归模式标出了来源层级', allState.where > 0, `带路径标签的卡片 ${allState.where} 张，例：${allState.whereSample}`)
  check('面包屑是「全部层级」', allState.crumbs.includes('全部层级'), allState.crumbs)

  // 只看视频 / 全部的开关。先显式点一下「只看视频」，不依赖前面留下的状态。
  const videoOnly = await ev(`(async () => {
    document.querySelector('[data-kind-btn="video"]').click()
    await new Promise((r) => setTimeout(r, 800))
    return {
      active: document.querySelector('[data-kind-btn="video"]').classList.contains('is-active'),
      cards: document.querySelectorAll('.card').length,
      images: document.querySelectorAll('.card-image').length,
      videos: document.querySelectorAll('.card-video').length,
    }
  })()`)
  check('「只看视频」按钮被点亮', videoOnly.active === true)
  check('只看视频时不混进图片', videoOnly.images === 0, `图片 ${videoOnly.images} 张`)
  check('只看视频时确实有视频', videoOnly.videos > 0, `视频 ${videoOnly.videos} 张`)

  await ev(`document.querySelector('[data-kind-btn="all"]').click()`)
  await sleep(500)
  const allKinds = await ev(`(() => ({
    cards: document.querySelectorAll('.card').length,
    images: document.querySelectorAll('.card-image').length,
  }))()`)
  check('切到「全部」后数量不少于只看视频', allKinds.cards >= videoOnly.cards, `${videoOnly.cards} → ${allKinds.cards}`)

  // ── 4. 封面：真的取到了图，不是骨架也不是失败兜底 ──────────────────────
  await ev(`document.querySelector('[data-kind-btn="video"]').click()`)
  await sleep(600)
  const poster = await ev(`(async () => {
    const img = [...document.querySelectorAll('.card-video img')].find((node) => node.complete && node.naturalWidth > 0)
      ?? document.querySelector('.card-video img')
    if (img === undefined || img === null) return { state: '没有 img' }
    if (!img.complete) await new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); setTimeout(r, 8000) })
    const media = img.closest('.card-media')
    return {
      src: img.getAttribute('src'),
      natural: img.naturalWidth + 'x' + img.naturalHeight,
      loaded: img.classList.contains('is-loaded'),
      pending: media.classList.contains('is-pending'),
      failed: media.classList.contains('no-poster'),
    }
  })()`)
  check('视频卡片用的是封面接口', String(poster.src).includes('/thumb?'), poster.src)
  check('封面真的解码成功（非骨架/非兜底）', poster.loaded === true && poster.pending === false && poster.failed === false, JSON.stringify(poster))
  check('封面尺寸合理', /^\d+x\d+$/.test(String(poster.natural)) && Number(String(poster.natural).split('x')[0]) >= 200, poster.natural)

  // ── 5. 元数据探测：时长应该被填上 ──────────────────────────────────────
  // 探测是攒批 + 限并发的，所以要等它回来，不能立刻断言。
  const gotDuration = await waitFor(
    `[...document.querySelectorAll('.duration-badge')].some((n) => n.hidden === false && n.textContent.trim() !== '')`,
    25000,
  )
  const duration = await ev(`(() => {
    const badge = [...document.querySelectorAll('.duration-badge')].find((n) => n.hidden === false && n.textContent.trim() !== '')
    return badge === undefined ? '(还没有时长)' : badge.textContent
  })()`)
  check('卡片显示了时长', gotDuration === true, duration)

  // ── 6. 按文件夹分组：一个子文件夹一张卡，卡内照旧平铺 ──────────────────
  await setUiState({ scope: 'dir', kinds: 'all', group: 'folder' })
  check('分组模式渲染出分组卡片', await waitFor('document.querySelectorAll(".folder-group").length > 0'))
  // 分组内容是按需加载的（进入视野才读那一层），所以要等内容真的铺进来。
  check('分组内容按需加载出来', await waitFor('document.querySelectorAll(".folder-group .card").length > 0', 30000))
  // 视口外的分组不会加载，所以断言前把它们滚进视野，再等一轮。
  await ev(`(() => {
    const groups = [...document.querySelectorAll('.folder-group')].slice(0, 4)
    for (const group of groups) group.scrollIntoView({ block: 'center' })
    return true
  })()`)
  await waitFor('document.querySelectorAll(".folder-group .card").length > 0', 15000)

  const grouped = await ev(`(() => {
    const groups = [...document.querySelectorAll('.folder-group')]
    return {
      count: groups.length,
      hasHeader: groups.every((g) => g.querySelector('.group-name') !== null),
      // 每个分组内部是网格，且列宽下限写在 --group-min 上
      innerGrids: groups.filter((g) => getComputedStyle(g.querySelector('.group-body')).display === 'grid').length,
      mins: groups.map((g) => g.querySelector('.group-body').style.getPropertyValue('--group-min')).filter(Boolean).slice(0, 6),
      tallies: groups.map((g) => g.querySelector('.group-tally').textContent).slice(0, 6),
      // 第一张卡内部有多少张媒体
      firstInner: groups[0]?.querySelectorAll('.card').length ?? 0,
      firstInnerCols: groups[0] === undefined ? 0 : getComputedStyle(groups[0].querySelector('.group-body')).gridTemplateColumns.split(' ').length,
    }
  })()`)
  console.log('分组探测:', JSON.stringify(grouped))
  check('分组卡都带标题', grouped.hasHeader === true)
  check('分组内部是平铺网格', grouped.innerGrids === grouped.count, `${grouped.innerGrids}/${grouped.count}`)
  check('分组内容按需加载出来了', grouped.firstInner > 0, `第一组 ${grouped.firstInner} 张`)
  check('分组算出了自适应列宽下限', grouped.mins.length > 0, JSON.stringify(grouped.mins))
  // 平铺 / 分组切换要能来回
  await ev(`document.querySelector('[data-group-btn="flat"]').click()`)
  await sleep(500)
  const backToFlat = await ev(`(() => ({
    groups: document.querySelectorAll('.folder-group').length,
    cards: document.querySelectorAll('#grid > .card').length,
  }))()`)
  check('切回平铺后不再有分组卡', backToFlat.groups === 0, `还有 ${backToFlat.groups} 个`)
  check('切回平铺后媒体直接在网格里', backToFlat.cards > 0, `${backToFlat.cards} 张`)

  // ── 7. 悬停播放小动画 ──────────────────────────────────────────────────
  await ev(`document.querySelector('[data-group-btn="folder"]').click()`)
  await waitFor('document.querySelectorAll(".folder-group .card-video").length > 0', 30000)
  const previewAvailable = await ev(`fetch('/reel/api/session').then((r) => r.json()).then((j) => j.capabilities.previews === true)`)
  if (previewAvailable === true) {
    // 卡片可能在视口下方——先把目标滚进视野，否则鼠标事件打不到它
    // （elementFromPoint 会是 null，pointerenter 永远不会触发）。
    await ev(`(() => {
      const media = document.querySelector('.folder-group .card-video .card-media')
      media.scrollIntoView({ block: 'center' })
      return true
    })()`)
    await sleep(400)
    const box = await ev(`(() => {
      const media = document.querySelector('.folder-group .card-video .card-media')
      const r = media.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
    const hit = await ev(`(() => {
      const el = document.elementFromPoint(${box.x}, ${box.y})
      return el === null ? '(null)' : (el.className || el.tagName)
    })()`)
    check('目标点确实落在卡片上', hit !== '(null)', `点 ${box.x},${box.y} 命中 ${hit}`)
    // 先把指针放到别处，再移进去——要的是真实的 pointerenter。
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    await sleep(150)
    // 记录卡片容器收到过的指针事件，判断到底是没触发还是没生成。
    await ev(`(() => {
      window.__ptr = []
      const media = document.querySelector('.folder-group .card-video .card-media')
      for (const type of ['pointerenter', 'pointerover', 'pointerleave', 'mouseenter']) {
        media.addEventListener(type, (e) => window.__ptr.push(type + ':' + e.pointerType))
      }
      return true
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    const appeared = await waitFor('document.querySelector(".card-preview") !== null', 25000)
    const ptrLog = await ev('JSON.stringify(window.__ptr ?? [])')
    const hoverState = await ev(`(() => {
      const media = document.querySelector('.folder-group .card-video .card-media')
      return {
        boxAtPointer: media === null ? null : (() => { const r = media.getBoundingClientRect(); return Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) })(),
        elementAtPointer: document.elementFromPoint(${box.x}, ${box.y})?.className ?? '(null)',
        hoverMatch: window.matchMedia('(hover: hover)').matches,
        previewsCapability: window.__previewCap ?? '(未读)',
      }
    })()`)
    console.log('悬停探测:', JSON.stringify({ ptrLog, hoverState, point: box }))
    check('悬停后出现预览 video', appeared === true)
    if (appeared) {
      const preview = await ev(`(async () => {
        const node = document.querySelector('.card-preview')
        const started = Date.now()
        while (Date.now() - started < 20000 && node.readyState < 2) await new Promise((r) => setTimeout(r, 200))
        return {
          src: node.getAttribute('src'),
          readyState: node.readyState,
          muted: node.muted,
          loop: node.loop,
          playsInline: node.playsInline,
          visible: node.classList.contains('is-ready'),
          videoWidth: node.videoWidth,
          paused: node.paused,
        }
      })()`)
      check('预览指向 preview 接口', String(preview.src).includes('/preview?'), preview.src)
      check('预览真的解码出画面', preview.readyState >= 2 && preview.videoWidth > 0, JSON.stringify(preview))
      check('预览是静音循环内联播放', preview.muted === true && preview.loop === true && preview.playsInline === true)
      check('预览正在播放', preview.paused === false, `paused=${preview.paused}`)
    }
    // 移开后必须停掉并拆掉，否则会在后台一直解码
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
    const removed = await waitFor('document.querySelector(".card-preview") === null', 4000)
    check('移开指针后预览被拆掉', removed === true)
  } else {
    console.log('  服务端没有 ffmpeg，跳过悬停动画断言')
  }

  // ── 8. 折叠可恢复 + 递归分组 + 静默续页 ────────────────────────────────
  // 收起来之后必须有可点的入口，否则用户看到的现象就是「根本没有侧边栏」。
  await ev(`document.getElementById('collapseSidebar').click()`)
  await sleep(300)
  const collapsed = await ev(`(() => {
    const rail = getComputedStyle(document.getElementById('sidebarRail'))
    return {
      collapsed: document.body.classList.contains('sidebar-collapsed'),
      sidebarDisplay: getComputedStyle(document.getElementById('sidebar')).display,
      railDisplay: rail.display,
      railWidth: Math.round(document.getElementById('sidebarRail').getBoundingClientRect().width),
      storageFlag: localStorage.getItem('mv.sidebar'),
    }
  })()`)
  check('收起后侧栏隐藏', collapsed.collapsed === true && collapsed.sidebarDisplay === 'none')
  check('收起后留下可点的细栏', collapsed.railDisplay === 'flex' && collapsed.railWidth > 20, JSON.stringify(collapsed))
  check('折叠状态不再写进 localStorage', collapsed.storageFlag === null, `mv.sidebar=${collapsed.storageFlag}`)

  await ev(`document.getElementById('sidebarRail').click()`)
  await sleep(300)
  const expanded = await ev(`(() => ({
    collapsed: document.body.classList.contains('sidebar-collapsed'),
    width: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
  }))()`)
  check('点细栏能把目录栏拿回来', expanded.collapsed === false && expanded.width >= 200, JSON.stringify(expanded))

  // 刷新后必须仍然是展开的（折叠不跨会话）。
  await ev(`document.getElementById('collapseSidebar').click()`)
  await send('Page.navigate', { url: `${origin}/reel?k=r0` })
  await waitFor('document.querySelectorAll(".card").length > 0')
  const afterReload = await ev(`(() => ({
    collapsed: document.body.classList.contains('sidebar-collapsed'),
    width: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
  }))()`)
  check('刷新后目录栏默认展开', afterReload.collapsed === false && afterReload.width >= 200, JSON.stringify(afterReload))

  // 递归范围下分组必须也能用（用户点了没反应，就是它被置灰了）。
  await ev(`document.querySelector('[data-scope-btn="all"]').click()`)
  await waitFor('document.querySelectorAll(".card").length > 0')
  check('递归模式下分组按钮可用', (await ev(`document.querySelector('[data-group-btn="folder"]').disabled === false`)) === true)
  await ev(`document.querySelector('[data-group-btn="folder"]').click()`)
  check('递归模式下分组渲染出卡片', (await waitFor('document.querySelectorAll(".folder-group").length > 0', 20000)) === true)
  const groupedAll = await ev(`(() => {
    const groups = [...document.querySelectorAll('.folder-group')]
    return {
      groups: groups.length,
      innerCards: groups.reduce((sum, g) => sum + g.querySelectorAll('.card').length, 0),
      immediate: groups.some((g) => g.querySelectorAll('.card').length > 0),
      nameSample: groups[0]?.querySelector('.group-name')?.textContent ?? '',
    }
  })()`)
  console.log('递归分组:', JSON.stringify(groupedAll))
  check('递归分组立刻铺出内容（无需再请求）', groupedAll.immediate === true, JSON.stringify(groupedAll))
  check('递归分组的卡片数 > 0', groupedAll.innerCards > 0, `${groupedAll.innerCards} 张`)

  // 静默续页：不该再有需要点的按钮（这一层不足一页时，连哨兵都不该有）。
  await ev(`document.querySelector('[data-group-btn="flat"]').click()`)
  await sleep(500)
  const paging = await ev(`(() => {
    const more = document.getElementById('more')
    return {
      buttons: more.querySelectorAll('button').length,
      text: more.textContent.trim(),
      needsPaging: document.getElementById('more').children.length > 0,
      sentinel: more.querySelector('.more-sentinel') !== null,
    }
  })()`)
  check('续页区没有需要点的按钮', paging.buttons === 0, `还有 ${paging.buttons} 个按钮：${paging.text}`)
  // 不足一页时不该有哨兵；需要续页时哨兵必须存在且没有按钮。
  check('不足一页时不显示任何续页 UI', paging.needsPaging === false || paging.sentinel === true, JSON.stringify(paging))

  // ── 9. 树的点击语义：展开 = 浏览，收起 = 不动列表 ──────────────────────
  // 切回「本目录」范围：递归模式下画的是全层级列表，面包屑不反映当前目录，
  // 断言「列表切到了那个目录」就没有意义了。
  await ev(`document.querySelector('[data-scope-btn="dir"]').click()`)
  await waitFor('document.querySelectorAll(".folder-row, .card").length > 0')
  const treeToggle = await ev(`(async () => {
    const read = () => {
      const wrapper = [...document.querySelectorAll('#tree .tree-root')][0]
      if (wrapper === undefined) return { twisty: '(无)', hidden: true, rows: 0 }
      return {
        twisty: wrapper.querySelector('.twisty').textContent,
        hidden: wrapper.querySelector('.tree-children').hidden,
        rows: wrapper.querySelectorAll('.tree-folder').length,
      }
    }
    const marker = () => ({
      crumbs: document.getElementById('crumbs').textContent,
      summary: document.getElementById('summary').textContent,
      cards: document.querySelectorAll('.card, .folder-row').length,
    })
    if (document.querySelectorAll('#tree .tree-root-name').length === 0) return { skipped: true }
    const clickRoot = () => document.querySelectorAll('#tree .tree-root-name')[0].click()
    // 先折起来，拿到一个干净的「收起」起点
    if (read().hidden === false) {
      clickRoot()
      await new Promise((r) => setTimeout(r, 1000))
    }
    const collapsedBefore = read()
    const markerBefore = marker()
    // 展开 → 应当同时把右侧列表载入这个根
    clickRoot()
    await new Promise((r) => setTimeout(r, 2200))
    const afterExpand = read()
    const markerAfter = marker()
    // 收起 → 列表不应变化
    clickRoot()
    await new Promise((r) => setTimeout(r, 1200))
    const afterCollapse = read()
    const markerCollapsed = marker()
    return { skipped: false, collapsedBefore, markerBefore, afterExpand, markerAfter, afterCollapse, markerCollapsed }
  })()`)
  console.log('展开即浏览:', JSON.stringify(treeToggle))
  if (treeToggle.skipped !== true) {
    check('展开会加载该目录的内容', treeToggle.markerAfter.cards > 0, JSON.stringify(treeToggle.markerAfter))
    check('展开后子目录已加载', treeToggle.afterExpand.rows > 0, `${treeToggle.afterExpand.rows} 行`)
    // 已经在当前目录时展开不会改变面包屑（本来就是它），所以这里只要求
    // 「列表确实有内容」；跨目录的浏览由下一段（点子目录行）来验证。
    check('展开后列表有内容', treeToggle.markerAfter.summary.length > 0, JSON.stringify(treeToggle.markerAfter))
    check('收起不动右侧列表', treeToggle.markerCollapsed.crumbs === treeToggle.markerAfter.crumbs && treeToggle.markerCollapsed.summary === treeToggle.markerAfter.summary, JSON.stringify({ after: treeToggle.markerAfter, collapsed: treeToggle.markerCollapsed }))
  }

  // 点目录时**不能重建**已加载的行。
  //
  // 用户报的现象是「点子目录时它们全部消失再重新出现，看着闪一下」。原因就是
  // 每次 navigate → renderAll → renderTree 都无条件 clear + 重建，几十个已加载
  // 的行一进一出之间是空的。这里用节点身份（而不是行数）来钉住：点击前后必须
  // 是**同一个** DOM 节点对象，重建出来的新节点长得一样、行数也一样，只有身份
  // 能区分，所以这条只能用 node identity 测。
  const reuseOnClick = await ev(`(async () => {
    const tree = document.getElementById('tree')
    const name = tree.querySelector('.tree-root-name')
    const twisty = name.querySelector('.twisty')
    if (twisty.textContent === '▸') { twisty.click(); await new Promise((r) => setTimeout(r, 2500)) }
    const rowsBefore = [...tree.querySelectorAll('.tree-folder')]
    if (rowsBefore.length === 0) return { skipped: true }
    const probe = rowsBefore[Math.floor(rowsBefore.length / 2)]
    const label = probe.querySelector('.label').textContent
    // 点根名会走 toggle → navigate → renderAll → renderTree。
    name.click()
    await new Promise((r) => setTimeout(r, 1800))
    const rowsAfter = [...tree.querySelectorAll('.tree-folder')]
    const same = rowsAfter.includes(probe)
    return {
      skipped: false,
      label,
      rowsBefore: rowsBefore.length,
      rowsAfter: rowsAfter.length,
      sameNode: same,
      // 同一个节点还在文档里，说明没被删掉重建。
      stillConnected: probe.isConnected,
      activeAfter: document.querySelector('#tree .tree-folder.is-active')?.dataset.key ?? '(无)',
    }
  })()`)
  console.log('点击复用:', JSON.stringify(reuseOnClick))
  if (reuseOnClick.skipped !== true) {
    check('点目录不会重建已加载的子目录行', reuseOnClick.sameNode === true, JSON.stringify(reuseOnClick))
    check('复用后行数不变', reuseOnClick.rowsAfter === reuseOnClick.rowsBefore, JSON.stringify(reuseOnClick))
  }

  // 点子目录行：第一次点 = 展开并浏览；再点同一行 = 收起且列表不动。
  //
  // 每次点击都可能重画整棵树，所以每次都用「行文本」重新定位同一个逻辑行，
  // 不能攥着旧节点（旧节点已经脱离文档，点它只会作用在一个死掉的 DOM 上）。
  const childBrowse = await ev(`(async () => {
    const crumbs = () => document.getElementById('crumbs').textContent
    const findRow = (label) => [...document.querySelectorAll('#tree .tree-folder')].find((row) => row.querySelector('.label')?.textContent === label) ?? null
    const first = document.querySelector('#tree .tree-folder')
    if (first === null) return { skipped: true }
    const name = first.querySelector('.label').textContent
    const before = crumbs()
    first.click()
    await new Promise((r) => setTimeout(r, 2500))
    const expanded = crumbs()
    const again = findRow(name)
    if (again === null) return { skipped: false, name, before, expanded, collapsed: '(找不到同一行)' }
    again.click()
    await new Promise((r) => setTimeout(r, 1500))
    const collapsed = crumbs()
    const rowAfter = findRow(name)
    return {
      skipped: false,
      name,
      before,
      expanded,
      collapsed,
      stillExpanded: rowAfter === null ? null : rowAfter.closest('.tree-children')?.hidden === false,
      nextSiblingHostHidden: rowAfter === null ? null : rowAfter.nextElementSibling?.hidden ?? null,
    }
  })()`)
  console.log('子目录展开即浏览:', JSON.stringify(childBrowse))
  if (childBrowse.skipped !== true) {
    check('点子目录行会浏览它', childBrowse.expanded.includes(childBrowse.name), `面包屑「${childBrowse.expanded}」/ 目标「${childBrowse.name}」`)
    check('再点同一行收起且列表不变', childBrowse.collapsed === childBrowse.expanded, `收起后「${childBrowse.collapsed}」`)
    check('收起后那一行的子层确实隐藏了', childBrowse.nextSiblingHostHidden === true, JSON.stringify(childBrowse))
  }

  // 进目录有两个明确入口：行尾的 › 按钮，和双击行。
  await ev(`document.querySelector('[data-scope-btn="dir"]').click()`)
  await sleep(800)
  const treeEnter = await ev(`(async () => {
    const row = document.querySelector('#tree .tree-folder')
    if (row === null) return { skipped: true }
    const name = row.querySelector('.label').textContent
    const enter = row.querySelector('.tree-enter')
    if (enter === null) return { skipped: false, name, hasButton: false, crumb: '' }
    enter.click()
    await new Promise((r) => setTimeout(r, 2200))
    return { skipped: false, name, hasButton: true, crumb: document.getElementById('crumbs').textContent }
  })()`)
  console.log('进入子目录:', JSON.stringify(treeEnter))
  if (treeEnter.skipped !== true) {
    check('目录行有「进入」按钮', treeEnter.hasButton === true)
    check('点「进入」按钮会进那个目录', String(treeEnter.crumb).includes(treeEnter.name), `面包屑「${treeEnter.crumb}」/ 目标「${treeEnter.name}」`)
  }

  // 双击也应该进入（回到上一层再双击另一行）
  const treeDbl = await ev(`(async () => {
    const back = document.querySelector('#tree .tree-root-name')
    if (back === null) return { skipped: true }
    back.click()
    await new Promise((r) => setTimeout(r, 1200))
    const row = document.querySelector('#tree .tree-folder')
    if (row === null) return { skipped: true }
    const name = row.querySelector('.label').textContent
    const rect = row.getBoundingClientRect()
    const opts = { bubbles: true, clientX: Math.round(rect.left + 40), clientY: Math.round(rect.top + rect.height / 2) }
    row.dispatchEvent(new MouseEvent('dblclick', opts))
    await new Promise((r) => setTimeout(r, 2200))
    return { skipped: false, name, crumb: document.getElementById('crumbs').textContent }
  })()`)
  console.log('双击子目录行:', JSON.stringify(treeDbl))
  if (treeDbl.skipped !== true) {
    check('双击子目录行会进入它', String(treeDbl.crumb).includes(treeDbl.name), `面包屑「${treeDbl.crumb}」/ 目标「${treeDbl.name}」`)
  }

  // ── 10. 静默加载：列表侧不能出现任何加载指示 ───────────────────────────
  // 采样一整个「正在加载」的时间窗，而不是只在最后看一眼——遮罩和转圈都是
  // 一闪而过的，只看终态永远抓不到。
  const samples = await ev(`(async () => {
    const seen = { loadingEl: 0, spinnerEls: 0, pendingClass: 0, spinnerText: 0, samples: 0 }
    document.querySelector('[data-scope-btn="all"]').click()
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      seen.samples += 1
      if (document.getElementById('loading') !== null) seen.loadingEl += 1
      if (document.querySelectorAll('.loading, .more-spinner').length > 0) seen.spinnerEls += 1
      if (document.querySelectorAll('.card-media.is-pending').length > 0) seen.pendingClass += 1
      if (/载入更多/.test(document.getElementById('grid').innerHTML)) seen.spinnerText += 1
      await new Promise((r) => setTimeout(r, 60))
    }
    return seen
  })()`)
  console.log('加载指示采样:', JSON.stringify(samples))
  check('没有全局加载遮罩元素', samples.loadingEl === 0, `${samples.loadingEl}/${samples.samples} 次采样命中`)
  check('没有转圈元素', samples.spinnerEls === 0, `${samples.spinnerEls}/${samples.samples} 次采样命中`)
  check('卡片没有 pending 骨架类', samples.pendingClass === 0, `${samples.pendingClass}/${samples.samples} 次采样命中`)
  check('网格里没有「载入更多」', samples.spinnerText === 0, `${samples.spinnerText}/${samples.samples} 次采样命中`)
  check('续页区没有按钮', (await ev(`document.getElementById('more').querySelectorAll('button').length`)) === 0)
  // 该留的要留：播放器在等数据时仍然转圈。
  check('播放器自己的转圈还在', (await ev(`document.getElementById('playerSpinner') !== null`)) === true)

  // ── 11. 目录栏手感：滚动保持 + 键盘导航 + 不可选中 ─────────────────────
  await setUiState({ scope: 'dir', kinds: 'video', group: 'flat' })

  // 滚到中间，然后触发一次**不改变树高**的重画（切排序），滚动位置必须留在原处。
  const scrollKeep = await ev(`(async () => {
    const tree = document.getElementById('tree')
    const clickRoot = () => document.querySelectorAll('#tree .tree-root-name')[0]?.click()
    if (tree.scrollHeight <= tree.clientHeight + 10) {
      clickRoot()
      await new Promise((r) => setTimeout(r, 2500))
    }
    tree.scrollTop = Math.min(400, Math.max(0, tree.scrollHeight - tree.clientHeight - 20))
    await new Promise((r) => setTimeout(r, 250))
    const before = tree.scrollTop
    const heightBefore = tree.scrollHeight
    // 点行首三角：它只折展、**不抢焦点**，因此只触发一次普通重画。
    const row = tree.querySelector('.tree-folder')
    if (row === null) return { skipped: true }
    row.querySelector('.twisty').click()
    await new Promise((r) => setTimeout(r, 2000))
    const afterTwisty = tree.scrollTop
    const heightAfterTwisty = tree.scrollHeight

    // 再测一次「点一行目录触发整页重画」：点行会走 navigate → renderAll → renderTree，
    // 树的形状（根｜范围｜分组）没变，所以位置必须原地不动。
    //
    // 早先这里点的是行尾的 ›（只 navigate，不重画树），于是整段测量其实什么都没测到，
    // 断言还长期失败；渲染日志里显示那一次点击根本没有重画记录，就是这么发现的。
    const row2 = tree.querySelector('.tree-folder')
    tree.scrollTop = Math.min(400, Math.max(0, tree.scrollHeight - tree.clientHeight - 20))
    await new Promise((r) => setTimeout(r, 250))
    const before2 = tree.scrollTop
    // 装一个监视：记录重画过程中 scrollTop 的每一次变化，看清是谁把它归零。
    const log = []
    const timer = setInterval(() => log.push(Math.round(tree.scrollTop)), 40)
    row2?.querySelector('.label')?.click()
    await new Promise((r) => setTimeout(r, 2500))
    clearInterval(timer)
    return {
      skipped: false,
      before,
      afterTwisty,
      heightBefore,
      heightAfterTwisty,
      before2,
      afterEnter: tree.scrollTop,
      activeAfter: document.activeElement?.className ?? '(无)',
      timeline: log.slice(0, 24),
      listenersBound: tree.dataset.probeBound ?? '(未标记)',
    }
  })()`)
  console.log('滚动保持:', JSON.stringify(scrollKeep))
  if (scrollKeep.skipped !== true) {
    check('折叠后的重画不会把目录栏弹回顶部', scrollKeep.before === 0 || Math.abs(scrollKeep.afterTwisty - scrollKeep.before) <= 40, JSON.stringify(scrollKeep))
    check('点行导航后的重画也不会把目录栏弹回顶部', scrollKeep.before2 === 0 || Math.abs(scrollKeep.afterEnter - scrollKeep.before2) <= 40, JSON.stringify(scrollKeep))
  }

  // 键盘导航：↑↓ 移动焦点、→ 展开。
  //
  // 方向键本身不导航、不重画，所以 DOM 在这个用例里是稳定的，可以安全地
  // 攥着节点引用连续发键。
  const keyboard = await ev(`(async () => {
    const tree = document.getElementById('tree')
    const rows = () => [...tree.querySelectorAll('.tree-root-name, .tree-folder')]
    const active = () => document.activeElement?.dataset?.label ?? '(无)'
    const fire = (node, key) => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    if (rows().length < 2) return { skipped: true }
    const walk = async () => {
      rows()[0].focus()
      const a = active()
      const rowsBefore = rows().length
      fire(rows()[0], 'ArrowDown')
      await new Promise((r) => setTimeout(r, 200))
      const b = active()
      const idxB = rows().indexOf(document.activeElement)
      fire(rows()[1], 'ArrowDown')
      await new Promise((r) => setTimeout(r, 200))
      const c = active()
      const idxC = rows().indexOf(document.activeElement)
      fire(rows()[2], 'ArrowUp')
      await new Promise((r) => setTimeout(r, 200))
      const d = active()
      return { a, b, c, d, rowsBefore, idxB, idxC, sameNode: rows()[1] === document.activeElement }
    }
    const moved = await walk()
    // 收起一个子目录行，再按 → 应当展开它
    const collapsed = rows().find((row) =>
      row.classList.contains('tree-folder') && row.nextElementSibling?.classList.contains('tree-children') && row.nextElementSibling.hidden,
    )
    if (collapsed === undefined) return { skipped: false, moved, expand: '(没有收起的子目录行)' }
    const label = collapsed.dataset.label
    collapsed.focus()
    const focusBefore = active()
    const keyHandlerRan = { ran: false }
    const probe = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    collapsed.dispatchEvent(probe)
    keyHandlerRan.ran = probe.defaultPrevented // 我们的处理器会 preventDefault
    await new Promise((r) => setTimeout(r, 2500))
    const after = rows().find((row) => row.dataset.label === label)
    return {
      skipped: false,
      moved,
      expand: { label, hidden: after === undefined ? null : after.nextElementSibling.hidden, focusBefore, prevented: keyHandlerRan.ran },
    }
  })()`)
  console.log('键盘导航:', JSON.stringify(keyboard))
  if (keyboard.skipped !== true) {
    check('↓ 把焦点移到下一行', keyboard.moved.a !== keyboard.moved.b, `${keyboard.moved.a} → ${keyboard.moved.b}`)
    check('再按 ↓ 继续往下', keyboard.moved.b !== keyboard.moved.c, `${keyboard.moved.b} → ${keyboard.moved.c}`)
    check('↑ 把焦点移回上一行', keyboard.moved.d === keyboard.moved.b, `${keyboard.moved.c} → ${keyboard.moved.d}`)
    if (typeof keyboard.expand === 'object') {
      check('→ 展开当前行', keyboard.expand.hidden === false, JSON.stringify(keyboard.expand))
    } else {
      console.log('  没有收起的子目录行可测 → 展开')
    }
  }

  const selectable = await ev(`getComputedStyle(document.getElementById('tree')).userSelect`)
  check('目录树不可选中文字（双击不会选中）', selectable === 'none', selectable)

  check('控制台没有异常', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {})
  chrome.kill('SIGKILL')
  await sleep(600)
  // Chrome 有时还攥着 profile 目录，删不掉不该让测试结果变成崩栈。
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* 交给系统清理临时目录 */
  }
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('界面结构验证通过 ✓')
