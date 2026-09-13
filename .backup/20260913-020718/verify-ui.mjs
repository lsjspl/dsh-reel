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
 * 这个脚本连续做十几段互不相干的检查，而每次点击都会改变 范围/内容。
 * 早期版本靠「上一步留下的状态」接着做，结果一处改动就让后面几条假失败。
 * 现在每段开头先声明自己需要什么状态，而不是猜。
 *
 * 范围现在是工具条上的独立开关（#scopeToggle），切换目录不会顺手把它关掉，
 * 所以这里要显式设：先回根（面包屑上第一枚名字），再按需要打开开关。
 *
 * @param {{scope?: 'dir'|'all', kinds?: 'all'|'video'|'image'}} want - 目标状态。
 */
const setUiState = async (want) => {
  const clicks = []
  if (want.kinds !== undefined) clicks.push(`['data-kind-btn', '${want.kinds}']`)
  await ev(`(() => {
    for (const [attr, value] of [${clicks.join(', ')}]) {
      const node = document.querySelector('[' + attr + '="' + value + '"]')
      if (node !== null && !node.classList.contains('is-active')) node.click()
    }
    return true
  })()`)
  if (want.scope !== undefined) {
    await clickCrumbRootEntry()
    if (want.scope === 'all') await enterAllLevels()
  }
  await sleep(1200)
  await waitFor('document.querySelectorAll(".card, .folder-row").length > 0', 25000)
}

/**
 * 把范围切到「所有层级」：工具条上的独立开关。
 *
 * 范围不再挂在面包屑菜单里（那里只有路径和子文件夹），所以直接点 #scopeToggle。
 *
 * @returns {Promise<boolean>} 开关确实被点亮。
 */
const enterAllLevels = async () => {
  const clicked = await ev(`(async () => {
    const toggle = document.getElementById('scopeToggle')
    if (toggle === null) return false
    if (!toggle.classList.contains('is-on')) toggle.click()
    await new Promise((r) => setTimeout(r, 2500))
    return toggle.classList.contains('is-on')
  })()`)
  await sleep(600)
  return clicked === true
}

/**
 * 回到根目录的「本层」视图：先回根（路径行上第一枚名字），再关掉范围开关。
 *
 * 面包屑名字现在就是导航本身——点根名字 = 回根目录这一层。已经在根上时，
 * 路径行里根本没有「根」这一枚（当前层不是按钮），这时只关开关。
 *
 * @returns {Promise<boolean>} 已经在根上且开关是关的。
 */
const clickCrumbRootEntry = async () => {
  const ok = await ev(`(async () => {
    if (new URLSearchParams(location.search).get('k') !== 'r0') {
      const root = document.querySelector('#crumbs .crumb-name[data-depth="0"]')
      if (root === null) return false
      root.click()
      await new Promise((r) => setTimeout(r, 1500))
    }
    const toggle = document.getElementById('scopeToggle')
    if (toggle !== null && toggle.classList.contains('is-on')) {
      toggle.click()
      await new Promise((r) => setTimeout(r, 1500))
    }
    return new URLSearchParams(location.search).get('k') === 'r0' && (toggle === null || !toggle.classList.contains('is-on'))
  })()`)
  await sleep(600)
  return ok === true
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

  // ── 3. 路径行：点名字就进那一层，「▾」管子文件夹，范围是独立开关 ────────
  // 目标目录用「根目录里第一个有内容、自己还有子文件夹的子文件夹」，而不是写死
  // 某个名字：这个脚本要能跑在任何一台机器上，而「▾」得有子文件夹才出得来。
  const listOf = async (key) => (await fetch(`${origin}/reel/api/list?k=${encodeURIComponent(key)}`)).json()
  const rootListing = await listOf('r0')
  let target = null
  for (const folder of rootListing.folders ?? []) {
    if ((folder.mediaCount ?? 0) <= 0) continue
    if (target === null) target = folder
    const inner = await listOf(folder.key)
    if ((inner.folders ?? []).length > 0) {
      target = folder
      break
    }
  }
  check('根目录里能找到可用的子文件夹', target !== null, JSON.stringify(target))
  const targetName = String(target?.name ?? '')
  const targetKey = String(target?.key ?? '')
  const targetSubfolders = ((await listOf(targetKey)).folders ?? []).length
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(targetKey)}` })
  check('子目录页出现卡片', await waitFor('document.querySelectorAll(".card").length > 0'))
  const dirState = await ev(`(() => ({
    crumbs: document.getElementById('crumbs').textContent,
    cards: document.querySelectorAll('.card').length,
    summary: document.getElementById('summary').textContent,
    names: [...document.querySelectorAll('#crumbs .crumb-name')].map((n) => n.textContent),
    currentIsNotButton: document.querySelector('#crumbs .crumb-current.crumb-name, #crumbs button.crumb-current') === null,
    currentLabel: document.querySelector('#crumbs .crumb-current .crumb-label')?.textContent ?? '',
    chevrons: document.querySelectorAll('#crumbs .crumb-chevron').length,
    separators: document.querySelectorAll('#crumbs .crumb-sep').length,
    upDisabled: document.getElementById('crumbUp').disabled,
    scopeOn: document.getElementById('scopeToggle').classList.contains('is-on'),
  }))()`)
  console.log('路径行结构:', JSON.stringify(dirState))
  check('路径行把根和当前层分开了', dirState.names.length === 1 && dirState.separators === 1, dirState.crumbs)
  check('根是按钮、当前层不是按钮', dirState.names.length === 1 && dirState.currentIsNotButton === true, JSON.stringify(dirState))
  check('当前层写出了目录名', dirState.currentLabel === targetName, `「${dirState.currentLabel}」/ 目标「${targetName}」`)
  check('子目录里「返回上一级」可用', dirState.upDisabled === false)
  check('本层视图下范围开关是关的', dirState.scopeOn === false)

  // 点根名字 = 直接回根目录这一层。旧设计这里弹的是菜单。
  const clickRootName = await ev(`(async () => {
    const root = document.querySelector('#crumbs .crumb-name[data-depth="0"]')
    if (root === null) return { clicked: false }
    root.click()
    await new Promise((r) => setTimeout(r, 2000))
    return {
      clicked: true,
      menuOpened: document.querySelector('.crumb-menu') !== null,
      key: new URLSearchParams(location.search).get('k'),
      current: document.querySelector('#crumbs .crumb-current .crumb-label')?.textContent ?? '',
      upDisabled: document.getElementById('crumbUp').disabled,
    }
  })()`)
  console.log('点根名字:', JSON.stringify(clickRootName))
  check('点名字直接导航，不再弹菜单', clickRootName.clicked === true && clickRootName.menuOpened === false, JSON.stringify(clickRootName))
  check('点根名字回到了根', clickRootName.key === 'r0', `${clickRootName.key} / 当前层「${clickRootName.current}」`)
  check('根目录上「返回上一级」不可用', clickRootName.upDisabled === true)

  // 「返回上一级」按钮：回根之后用它再进目标目录，顺带钉住它真的能上来。
  const upButton = await ev(`(async () => {
    const row = [...document.querySelectorAll('#tree .tree-folder')].find((n) => n.querySelector('.label')?.textContent === ${JSON.stringify(targetName)})
    row?.querySelector('.tree-enter')?.click()
    await new Promise((r) => setTimeout(r, 2200))
    const down = new URLSearchParams(location.search).get('k')
    const up = document.getElementById('crumbUp')
    up.click()
    await new Promise((r) => setTimeout(r, 2000))
    return { down, up: new URLSearchParams(location.search).get('k'), current: document.querySelector('#crumbs .crumb-current .crumb-label')?.textContent ?? '' }
  })()`)
  console.log('上一级按钮:', JSON.stringify(upButton))
  check('「返回上一级」回到父目录', upButton.up === 'r0', JSON.stringify(upButton))

  // 回到目标目录，后面的菜单断言在它上面做。
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(targetKey)}` })
  await waitFor('document.querySelectorAll(".card").length > 0')

  // 「▾」= 这一级的子文件夹清单，只做下钻；范围不再混在里面。
  const menuProbe = await ev(`(async () => {
    document.querySelector('.crumb-menu')?.remove()
    const chevron = document.querySelector('#crumbs .crumb-chevron')
    if (chevron === null) return { opened: false, reason: '没有 ▾' }
    chevron.click()
    const deadline = Date.now() + 8000
    while (Date.now() < deadline && document.querySelectorAll('.crumb-menu .crumb-menu-item[data-folder-entry]').length === 0) {
      await new Promise((r) => setTimeout(r, 200))
    }
    const menu = document.querySelector('.crumb-menu')
    if (menu === null) return { opened: false, reason: '菜单没出来' }
    return {
      opened: true,
      rows: [...menu.querySelectorAll('.crumb-menu-item')].map((n) => n.textContent.trim()),
      hasAllEntry: menu.querySelector('.crumb-menu-item[data-all-entry]') !== null,
      hasRootEntry: menu.querySelector('.crumb-menu-item[data-root-entry]') !== null,
      folderRows: menu.querySelectorAll('.crumb-menu-item[data-folder-entry]').length,
    }
  })()`)
  console.log('子文件夹菜单探测:', JSON.stringify(menuProbe))
  check('点「▾」弹出子文件夹菜单', menuProbe.opened === true, JSON.stringify(menuProbe))
  check('菜单里只有子文件夹（范围不在菜单里）', menuProbe.hasAllEntry === false && menuProbe.hasRootEntry === false, JSON.stringify(menuProbe))
  check('菜单列出了全部子文件夹', menuProbe.folderRows === targetSubfolders, `菜单 ${menuProbe.folderRows} 行 / 目标 ${targetSubfolders} 个`)

  // 范围开关：工具条上独立的一枚，切换后路径行用标记说明当前范围。
  const allState = await ev(`(async () => {
    document.querySelector('.crumb-menu')?.remove()
    const toggle = document.getElementById('scopeToggle')
    const before = toggle.textContent
    toggle.click()
    await new Promise((r) => setTimeout(r, 2500))
    return {
      before,
      after: toggle.textContent,
      on: toggle.classList.contains('is-on'),
      crumbs: document.getElementById('crumbs').textContent,
      url: location.search,
      cards: document.querySelectorAll('.card').length,
      summary: document.getElementById('summary').textContent,
      where: document.querySelectorAll('.card-where').length,
      whereSample: document.querySelector('.card-where')?.textContent ?? '',
      storage: localStorage.getItem('mv.scope'),
    }
  })()`)
  console.log('范围开关探测:', JSON.stringify({ dirState, allState }))
  check('「所有层级」进入递归视图', allState.summary.includes('含所有子目录'), JSON.stringify(allState))
  check('递归视图留在当前目录', decodeURIComponent(allState.url).includes(targetKey), allState.url)
  check('开关自己表示状态', allState.on === true && allState.after === '所有层级' && allState.before === '本层', JSON.stringify(allState))
  check('路径行标出「所有层级」', allState.crumbs.includes('所有层级'), allState.crumbs)
  check('递归模式标出了来源层级', allState.where > 0, `带路径标签的卡片 ${allState.where} 张，例：${allState.whereSample}`)

  // 递归视图的出口：再按一次开关回到本层——只显示这一层的文件，路径行上的
  // 范围标记消失，摘要不再说「含所有子目录」。
  const rootOnly = await ev(`(async () => {
    const toggle = document.getElementById('scopeToggle')
    toggle.click()
    await new Promise((r) => setTimeout(r, 2000))
    return {
      found: true,
      on: toggle.classList.contains('is-on'),
      crumbs: document.getElementById('crumbs').textContent,
      summary: document.getElementById('summary').textContent,
      cards: document.querySelectorAll('.card').length,
      where: document.querySelectorAll('.card-where').length,
      storage: localStorage.getItem('mv.scope'),
    }
  })()`)
  console.log('范围开关回退探测:', JSON.stringify(rootOnly))
  check('再按一次开关回到本层', rootOnly.on === false && rootOnly.storage === 'dir', JSON.stringify(rootOnly))
  check('回本层后路径行不再标范围', rootOnly.crumbs.includes('所有层级') === false, rootOnly.crumbs)
  check('回本层后摘要不再说含子目录', rootOnly.summary.includes('含所有子目录') === false, rootOnly.summary)

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

  // ── 6. 点卡片打开的是**这一条**（不是列表第一条） ──────────────────────
  // 这条曾经真的坏过：卡片上存的是 state.media 里的下标，而不是这条媒体自己的
  // key。凡是不在那个数组里的卡片（分组视图里懒加载出来的那些）下标必然落到 0，
  // 于是「点哪个视频都播第一个」。现在统一按 key 打开，这里用第 2、3 张卡钉住它。
  await setUiState({ scope: 'dir', kinds: 'video' })
  await waitFor('document.querySelectorAll(".card-video").length > 2', 20000)
  const openProbe = await ev(`(async () => {
    const cards = [...document.querySelectorAll('.card-video')]
    const read = async (card) => {
      card.click()
      await new Promise((r) => setTimeout(r, 1500))
      const name = document.getElementById('playerName').textContent
      document.getElementById('btnClose').click()
      await new Promise((r) => setTimeout(r, 600))
      return name
    }
    const first = cards[0].dataset.key
    const second = cards[1].dataset.key
    const firstOpened = await read(cards[0])
    const secondOpened = await read(cards[1])
    return {
      firstKey: first,
      secondKey: second,
      firstOpened,
      secondOpened,
      secondCardName: cards[1].querySelector('.card-name')?.textContent ?? '',
      secondCardKey: cards[1].dataset.key,
    }
  })()`)
  console.log('打开探测:', JSON.stringify(openProbe))
  check('第二张卡打开的确实是它自己', openProbe.secondOpened === openProbe.secondCardName, `打开「${openProbe.secondOpened}」/ 卡片「${openProbe.secondCardName}」`)
  check('第二张卡没有落到第一张上', openProbe.secondOpened !== openProbe.firstOpened || openProbe.firstKey === openProbe.secondKey, JSON.stringify(openProbe))

  // ── 7. 悬停播放小动画 ──────────────────────────────────────────────────
  await waitFor('document.querySelectorAll(".card-video").length > 0', 20000)
  const previewAvailable = await ev(`fetch('/reel/api/session').then((r) => r.json()).then((j) => j.capabilities.previews === true)`)
  if (previewAvailable === true) {
    // 卡片可能在视口下方——先把目标滚进视野，否则鼠标事件打不到它
    // （elementFromPoint 会是 null，pointerenter 永远不会触发）。
    await ev(`(() => {
      const media = document.querySelector('.card-video .card-media')
      media.scrollIntoView({ block: 'center' })
      return true
    })()`)
    await sleep(400)
    const box = await ev(`(() => {
      const media = document.querySelector('.card-video .card-media')
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
      const media = document.querySelector('.card-video .card-media')
      for (const type of ['pointerenter', 'pointerover', 'pointerleave', 'mouseenter']) {
        media.addEventListener(type, (e) => window.__ptr.push(type + ':' + e.pointerType))
      }
      return true
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    const appeared = await waitFor('document.querySelector(".card-preview") !== null', 25000)
    const ptrLog = await ev('JSON.stringify(window.__ptr ?? [])')
    const hoverState = await ev(`(() => {
      const media = document.querySelector('.card-video .card-media')
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

  // ── 8. 折叠可恢复 + 递归范围 + 静默续页 ────────────────────────────────
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

  // 递归范围下卡片照样渲染（范围只换数据来源，不改渲染方式）。
  // 通过工具条上的范围开关进入所有层级。
  await enterAllLevels()
  await waitFor('document.querySelectorAll(".card").length > 0')
  const recursive = await ev(`(() => ({
    summary: document.getElementById('summary').textContent,
    cards: document.querySelectorAll('.card').length,
    where: document.querySelectorAll('.card-where').length,
  }))()`)
  console.log('递归范围:', JSON.stringify(recursive))
  check('递归范围下列出了卡片', recursive.cards > 0, JSON.stringify(recursive))
  check('递归范围标出了来源层级', recursive.where > 0, JSON.stringify(recursive))

  // 静默续页：不该再有需要点的按钮（这一层不足一页时，连哨兵都不该有）。
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
  // 先回根目录的「本层」视图（面包屑上第一枚名字 + 关掉范围开关）：递归视图会把
  // 子层级的文件一起刷进来，树点击的断言（卡片数、摘要）要有「只看这一层」的
  // 参照才有确定意义。
  await clickCrumbRootEntry()
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
  await clickCrumbRootEntry()
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
    document.querySelector('.crumb-menu')?.remove()
    const toggle = document.getElementById('scopeToggle')
    if (toggle.classList.contains('is-on')) {
      toggle.click()
      await new Promise((r) => setTimeout(r, 1200))
    }
    toggle.click()
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
    // 树的形状（根｜范围）没变，所以位置必须原地不动。
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
