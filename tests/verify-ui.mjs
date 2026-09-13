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
 * 这个脚本连续做十几段互不相干的检查，而每次点击都会改变 内容/分组。
 * 早期版本靠「上一步留下的状态」接着做，结果一处改动就让后面几条假失败。
 * 现在每段开头先声明自己需要什么状态，而不是猜。
 *
 * @param {{kinds?: 'all'|'video'|'image', content?: 'current'|'all'|'folder', atRoot?: boolean}} want - 目标状态。
 */
const setUiState = async (want) => {
  const clicks = []
  if (want.kinds !== undefined) clicks.push(`['data-kind-btn', '${want.kinds}']`)
  if (want.content !== undefined) clicks.push(`['data-content-btn', '${want.content}']`)
  await ev(`(() => {
    for (const [attr, value] of [${clicks.join(', ')}]) {
      const node = document.querySelector('[' + attr + '="' + value + '"]')
      if (node !== null && !node.classList.contains('is-active')) node.click()
    }
    return true
  })()`)
  if (want.atRoot === true) await clickCrumbRootEntry()
  await sleep(1200)
  await waitFor('document.querySelectorAll(".card, .folder-group, .folder-row").length > 0', 25000)
}

/**
 * 回到根目录：点路径行上的**配置目录根**那一枚（路径行是「库 › 根 › …」，根是
 * 第二枚，data-depth="1"）。
 *
 * 面包屑名字就是导航本身——点根名字 = 回根目录这一层。已经在根上时那一枚是当前
 * 层（不是按钮），那就是已经到了。
 *
 * @returns {Promise<boolean>} 当前确实在根目录上。
 */
const clickCrumbRootEntry = async () => {
  const ok = await ev(`(async () => {
    if (new URLSearchParams(location.search).get('k') !== 'r0') {
      const root = document.querySelector('#crumbs .crumb-name[data-depth="1"]')
      if (root === null) return false
      root.click()
      await new Promise((r) => setTimeout(r, 1500))
    }
    return new URLSearchParams(location.search).get('k') === 'r0'
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

  // 手工再对一次账：接口认为有几个根，树里画了几个根。
  //
  // 早先这里还会点开设置抽屉、数里面列了几个目录。抽屉已经拆掉（目录改在 dsh
  // 的插件配置里加），所以现在只剩接口和树这两处可比，点一个已经不存在的按钮
  // 只会把整轮测试打断。
  const rootCause = await ev(`(async () => {
    const response = await fetch('/reel/api/session').then((r) => r.json())
    return {
      apiRoots: response.roots.length,
      treeRoots: document.querySelectorAll('#tree .tree-root').length,
    }
  })()`)
  console.log('API 根数:', rootCause.apiRoots, '| 树里的根数:', rootCause.treeRoots)
  check(`侧栏列出全部 ${session} 个根目录`, treeRoots === session, `树里有 ${treeRoots} 个`)

  const rootLabels = await ev('[...document.querySelectorAll("#tree .tree-root-name")].map(n=>n.textContent.trim()).join(" | ")')
  check('每个根都显示名字', rootLabels.split('|').length === session, rootLabels)

  // 第二个根默认收起，点它的名字应该展开出子目录（点击 = 切换展开，不导航）
  if (session > 1) {
    // 用「配置根」集合的索引定位第二个根，而不是 :nth-child——各根挂在
    // 「库」的子层里，父节点里还有库自己那一行（类名不同，不参与 .tree-root）。
    const beforeExpand = await ev('document.querySelectorAll("#tree .tree-root")[1].querySelectorAll(".tree-folder").length')
    await ev(`document.querySelectorAll('#tree .tree-root-name')[1].click()`)
    await sleep(1800)
    const afterExpand = await ev('document.querySelectorAll("#tree .tree-root")[1].querySelectorAll(".tree-folder").length')
    check('第二个根可以展开出子目录', afterExpand > 0, `展开前 ${beforeExpand} 行，展开后 ${afterExpand} 行`)
  }

  // ── 2. 文件夹是一行一个，不是卡片 ─────────────────────────────────────
  //
  // 「当前」这一层早先把子文件夹画成一排窄条（`.folder-row`）。现在文件夹不进
  // 网格了——左右两边分别是目录树和路径行的「▾」菜单——所以这几条只在旧元素还在
  // 时才检查；类已经没了就跳过，免得整轮测试断在一个不存在的选择器上。
  //
  // 点名字是切换展开，所以这里用「先确保展开」的方式回到第一个根的内容。
  await ev(`(async () => {
    const wrapper = document.querySelectorAll('#tree .tree-root')[0]
    if (wrapper.querySelector('.tree-children').hidden) wrapper.querySelector('.tree-root-name').click()
    return true
  })()`)
  check('第一个根展开后有数据', await waitFor('document.querySelectorAll("#tree .tree-folder").length > 0'))
  const folderRow = await ev(`(() => {
    const row = document.querySelector('.folder-row')
    if (row === null) return { skipped: true }
    const rect = row.getBoundingClientRect()
    const cs = getComputedStyle(row)
    return { skipped: false, h: Math.round(rect.height), w: Math.round(rect.width), display: cs.display, hasThumb: row.querySelector('img, video') !== null }
  })()`)
  if (folderRow.skipped === true) {
    console.log('没有 .folder-row（文件夹已不画进网格），跳过「窄条」两条断言')
  } else {
    check('文件夹行是窄条不是大卡片', folderRow.h < 60, `高度 ${folderRow.h}px`)
    check('文件夹行里没有缩略图', folderRow.hasThumb === false)
    const folderCount = await ev('document.querySelectorAll(".folder-row").length')
    const cardCount = await ev('document.querySelectorAll(".card").length')
    check('文件夹与媒体分开渲染', folderCount > 0 && cardCount > 0, `文件夹 ${folderCount} 行 / 媒体 ${cardCount} 张`)
  }

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
    links: [...document.querySelectorAll('#crumbs .crumb-name')].filter((n) => n.disabled !== true).map((n) => n.textContent),
    currentLabel: document.querySelector('#crumbs .crumb.is-current .crumb-name')?.textContent ?? '',
    chevrons: document.querySelectorAll('#crumbs .crumb-chevron').length,
    separators: document.querySelectorAll('#crumbs .crumb-sep').length,
    upDisabled: document.getElementById('crumbUp').disabled,
  }))()`)
  console.log('路径行结构:', JSON.stringify(dirState))
  check('路径行从库起步：库 › 根 › 当前层', dirState.names.length === 3 && dirState.names[0] === '库' && dirState.separators === 2, dirState.crumbs)
  check('库与根可点、当前层不可点', dirState.links.length === 2 && dirState.links[0] === '库' && dirState.links[1] !== targetName, JSON.stringify(dirState))
  check('当前层写出了目录名', dirState.currentLabel === targetName, `「${dirState.currentLabel}」/ 目标「${targetName}」`)
  check('子目录里「返回上一级」可用', dirState.upDisabled === false)

  // 点根名字 = 直接回根目录这一层。旧设计这里弹的是菜单。
  // 顺带钉住「根的上一级是库」：库是树顶，路径行和左树说的是同一件事。
  const clickRootName = await ev(`(async () => {
    const root = document.querySelector('#crumbs .crumb-name[data-depth="1"]')
    if (root === null) return { clicked: false }
    root.click()
    await new Promise((r) => setTimeout(r, 2000))
    const atRoot = {
      clicked: true,
      menuOpened: document.querySelector('.crumb-menu') !== null,
      key: new URLSearchParams(location.search).get('k'),
      current: document.querySelector('#crumbs .crumb.is-current .crumb-name')?.textContent ?? '',
      upDisabled: document.getElementById('crumbUp').disabled,
      names: [...document.querySelectorAll('#crumbs .crumb-name')].map((n) => n.textContent),
    }
    document.getElementById('crumbUp').click()
    await new Promise((r) => setTimeout(r, 2000))
    return {
      ...atRoot,
      upTo: new URLSearchParams(location.search).get('k'),
      upNames: [...document.querySelectorAll('#crumbs .crumb-name')].map((n) => n.textContent),
    }
  })()`)
  console.log('点根名字:', JSON.stringify(clickRootName))
  check('点名字直接导航，不再弹菜单', clickRootName.clicked === true && clickRootName.menuOpened === false, JSON.stringify(clickRootName))
  check('点根名字回到了根', clickRootName.key === 'r0', `${clickRootName.key} / 当前层「${clickRootName.current}」`)
  check('根的路径行是「库 › 根」', clickRootName.names.length === 2 && clickRootName.names[0] === '库', JSON.stringify(clickRootName.names))
  check('根的「返回上一级」可用（那一级是库）', clickRootName.upDisabled === false, String(clickRootName.upDisabled))
  check('根的上一级回到库', clickRootName.upTo === 'lib', String(clickRootName.upTo))
  check('库里路径行只剩库一枚、上一级不可用', clickRootName.upNames.join('›') === '库', JSON.stringify(clickRootName.upNames))

  // 「返回上一级」按钮：回根之后用它再进目标目录，顺带钉住它真的能上来。
  const upButton = await ev(`(async () => {
    const row = [...document.querySelectorAll('#tree .tree-folder')].find((n) => n.querySelector('.label')?.textContent === ${JSON.stringify(targetName)})
    row?.querySelector('.tree-enter')?.click()
    await new Promise((r) => setTimeout(r, 2200))
    const down = new URLSearchParams(location.search).get('k')
    const up = document.getElementById('crumbUp')
    up.click()
    await new Promise((r) => setTimeout(r, 2000))
    return { down, up: new URLSearchParams(location.search).get('k'), current: document.querySelector('#crumbs .crumb.is-current .crumb-name')?.textContent ?? '' }
  })()`)
  console.log('上一级按钮:', JSON.stringify(upButton))
  check('「返回上一级」回到父目录', upButton.up === 'r0', JSON.stringify(upButton))

  // 回到目标目录，后面的菜单断言在它上面做。
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(targetKey)}` })
  await waitFor('document.querySelectorAll(".card").length > 0')

  // 「▾」= **这一级**的子文件夹清单，只做下钻；范围不再混在里面。
  //
  // 选当前这一层那枚「▾」（data-crumb-chevron 就是这一级的键）：路径行现在是
  // 「库 › 根 › …」，头一枚列的是配置目录、第二枚列的是根的下一层，都不是
  // 「当前这一层」。
  const menuProbe = await ev(`(async () => {
    document.querySelector('.crumb-menu')?.remove()
    const key = new URLSearchParams(location.search).get('k')
    const chevron = [...document.querySelectorAll('#crumbs .crumb-chevron')].find((n) => n.dataset.crumbChevron === key)
    if (chevron === undefined) return { opened: false, reason: '当前这一层没有 ▾' }
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
  if (targetSubfolders === 0) {
    // 没有子文件夹的层不挂「▾」——点开一个空菜单没有意义。
    check('没有子文件夹的层不挂「▾」', menuProbe.opened === false, JSON.stringify(menuProbe))
  } else {
    check('点「▾」弹出子文件夹菜单', menuProbe.opened === true, JSON.stringify(menuProbe))
    check('菜单里只有子文件夹（范围已不在菜单里）', menuProbe.hasAllEntry === false && menuProbe.hasRootEntry === false, JSON.stringify(menuProbe))
    check('菜单列出了全部子文件夹', menuProbe.folderRows === targetSubfolders, `菜单 ${menuProbe.folderRows} 行 / 目标 ${targetSubfolders} 个`)
  }

  // 范围开关已经删掉：工具条上没有这枚按钮，路径行也不再标「所有层级」。
  const scopeGone = await ev(`(() => ({
    toggle: document.getElementById('scopeToggle') === null,
    badge: document.querySelector('#crumbs .crumb-scope') === null,
    storage: localStorage.getItem('mv.scope'),
  }))()`)
  check('工具条上不再有范围开关', scopeGone.toggle === true, JSON.stringify(scopeGone))
  check('路径行不再标「所有层级」', scopeGone.badge === true, JSON.stringify(scopeGone))

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

  // ── 6. 分组：递归成一棵可折展的目录树 ──────────────────────────────────
  await setUiState({ kinds: 'all', content: 'folder', atRoot: true })
  check('分组模式渲染出分组', await waitFor('document.querySelectorAll(".folder-group").length > 0'))
  check('分组里有卡片', await waitFor('document.querySelectorAll(".folder-group .card").length > 0', 30000))

  const grouped = await ev(`(() => {
    const groups = [...document.querySelectorAll('.folder-group')]
    const withChild = groups.filter((g) => g.querySelector('.folder-group') !== null)
    const firstChild = document.querySelector('.folder-group .folder-group')
    return {
      count: groups.length,
      hasHeader: groups.every((g) => g.querySelector('.group-name') !== null),
      hasTwisty: groups.every((g) => g.querySelector('.twisty') !== null),
      hasTally: groups.every((g) => /^\\d+ 个$/.test(g.querySelector('.group-tally').textContent.trim())),
      nested: withChild.length,
      childIndented: firstChild === null ? null : firstChild.classList.contains('is-child'),
      childHasOwnCards: firstChild === null ? null : firstChild.querySelectorAll('.card').length >= 0,
      openAtStart: groups.filter((g) => g.querySelector('.group-body').hidden === false).length,
      // 组头的数字是整棵子树的数量：根那一组必须不少于它自己的直接子组
      rootTally: Number((groups[0]?.querySelector('.group-tally')?.textContent ?? '0').replace(/\\D/g, '')),
      // 「展开 / 折叠」在工具条上、紧挨着「分组」按钮，不再单独占一行
      expandHidden: document.getElementById('groupExpand').hidden,
      collapseHidden: document.getElementById('groupCollapse').hidden,
      // 数量只在摘要行说一次：工具条与分组块里都不该再出现统计文字
      toolbarHasNumbers: /\\d/.test(document.querySelector('.toolbar-side')?.textContent ?? ''),
    }
  })()`)
  console.log('分组探测:', JSON.stringify(grouped))
  check('分组都带组头与三角', grouped.hasHeader === true && grouped.hasTwisty === true)
  check('分组都带媒体数', grouped.hasTally === true)
  check('出现了嵌套的子分组', grouped.nested > 0, `${grouped.nested} 个带子组`)
  check('嵌套的子分组带 is-child（缩进那条竖线）', grouped.childIndented === true)
  check('默认只展开第一层', grouped.openAtStart > 0 && grouped.openAtStart < grouped.count, `展开 ${grouped.openAtStart} / 共 ${grouped.count}`)
  check('组头统计的是整棵子树', grouped.rootTally > 0, `根组 ${grouped.rootTally}`)
  check('分组模式下才显示展开 / 折叠', grouped.expandHidden === false && grouped.collapseHidden === false, JSON.stringify(grouped))
  check('工具条上不再有第二处统计', grouped.toolbarHasNumbers === false, '工具条里出现了数字')
  check('动作带只有展开 / 折叠两个按钮', JSON.stringify(grouped.barButtons) === JSON.stringify(['展开全部', '折叠全部']), JSON.stringify(grouped.barButtons))
  check('动作带不重复报数量', grouped.barHasNumbers === false, '分组工具条里出现了数字')

  // 折展：点组头把它收起来，再点一次展开。
  const folding = await ev(`(async () => {
    const head = document.querySelector('.folder-group .group-head')
    const body = head.parentElement.querySelector('.group-body')
    const before = body.hidden
    head.click()
    await new Promise((r) => setTimeout(r, 200))
    const afterFirst = body.hidden
    head.click()
    await new Promise((r) => setTimeout(r, 200))
    return { before, afterFirst, afterSecond: body.hidden, expanded: head.getAttribute('aria-expanded') }
  })()`)
  console.log('折展探测:', JSON.stringify(folding))
  check('点组头能折起', folding.afterFirst === !folding.before, JSON.stringify(folding))
  check('再点一次能展开', folding.afterSecond === folding.before, JSON.stringify(folding))

  // 工具条上的展开全部 / 折叠全部
  const bulk = await ev(`(async () => {
    const read = () => [...document.querySelectorAll('.folder-group')].filter((g) => g.querySelector('.group-body').hidden === false).length
    const total = document.querySelectorAll('.folder-group').length
    document.getElementById('groupExpand').click()
    await new Promise((r) => setTimeout(r, 400))
    const expanded = read()
    document.getElementById('groupCollapse').click()
    await new Promise((r) => setTimeout(r, 400))
    return { total, expanded, collapsed: read() }
  })()`)
  console.log('批量折展:', JSON.stringify(bulk))
  check('「展开全部」把所有分组摊开', bulk.expanded === bulk.total, JSON.stringify(bulk))
  check('「折叠全部」只剩根展开', bulk.collapsed === 1, JSON.stringify(bulk))

  // 三个内容模式要能来回切：分组 → 全部 → 当前
  await ev(`document.querySelector('[data-content-btn="all"]').click()`)
  await sleep(800)
  const allMode = await ev(`(() => ({
    active: document.querySelector('[data-content-btn="all"]').classList.contains('is-active'),
    groups: document.querySelectorAll('.folder-group').length,
    cards: document.querySelectorAll('.card').length,
    summary: document.getElementById('summary').textContent,
  }))()`)
  check('「全部」是平铺（没有分组）', allMode.active === true && allMode.groups === 0, JSON.stringify(allMode))
  check('「全部」列出了递归内容', allMode.cards > 0 && allMode.summary.includes('含所有子目录'), JSON.stringify(allMode))

  await ev(`document.querySelector('[data-content-btn="current"]').click()`)
  await sleep(800)
  const currentMode = await ev(`(() => ({
    active: document.querySelector('[data-content-btn="current"]').classList.contains('is-active'),
    groups: document.querySelectorAll('.folder-group').length,
    cards: document.querySelectorAll('.card').length,
    summary: document.getElementById('summary').textContent,
  }))()`)
  check('「当前」回到平铺且不含子目录', currentMode.active === true && currentMode.groups === 0 && currentMode.summary.includes('含所有子目录') === false, JSON.stringify(currentMode))

  // ── 7. 悬停播放小动画 ──────────────────────────────────────────────────
  await ev(`document.querySelector('[data-content-btn="folder"]').click()`)
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

  // 分组在**根目录**上也要成立：这一层子目录最多，嵌套也最深。
  await clickCrumbRootEntry()
  await ev(`document.querySelector('[data-content-btn="folder"]').click()`)
  check('根目录分组渲染出分组', (await waitFor('document.querySelectorAll(".folder-group").length > 0', 20000)) === true)
  const groupedAll = await ev(`(() => {
    const groups = [...document.querySelectorAll('.folder-group')]
    return {
      groups: groups.length,
      innerCards: groups.reduce((sum, g) => sum + g.querySelectorAll('.card').length, 0),
      nested: groups.filter((g) => g.querySelector('.folder-group') !== null).length,
      summary: document.getElementById('summary').textContent,
    }
  })()`)
  console.log('根目录分组:', JSON.stringify(groupedAll))
  check('根目录分组铺出了卡片', groupedAll.innerCards > 0, `${groupedAll.innerCards} 张`)
  check('根目录分组有嵌套', groupedAll.nested > 0, JSON.stringify(groupedAll))
  check('摘要说明这是含子目录的数量', groupedAll.summary.includes('含所有子目录'), groupedAll.summary)

  // 静默续页：不该再有需要点的按钮（这一层不足一页时，连哨兵都不该有）。
  await ev(`document.querySelector('[data-content-btn="current"]').click()`)
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
    // 触发一次真实的重新载入（刷新按钮），采样整个过程里有没有加载指示。
    document.getElementById('refreshBtn').click()
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
  await setUiState({ kinds: 'video', content: 'current', atRoot: true })

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
    const rows = () => [...tree.querySelectorAll('.tree-root-name, .tree-library-name, .tree-folder')]
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

  // ── 12. 播放器：默认窗口播放，「页面全屏」是单独一步 ────────────────────
  //
  // 点开视频应当先给一个不是整页的窗口；只有点了「页面全屏」才铺满这一页。
  // 关闭与全屏相关的按钮都在视频**上方**那条浮动条上，下面的控件条里没有。
  await setUiState({ kinds: 'video', content: 'current', atRoot: true })
  const playerOpen = await ev(`(async () => {
    const card = document.querySelector('.card-video')?.closest('.card')
    if (card === undefined || card === null) return { skipped: true }
    card.click()
    await new Promise((r) => setTimeout(r, 1500))
    const player = document.getElementById('player')
    const box = document.getElementById('playerWindow').getBoundingClientRect()
    const top = document.getElementById('playerTop')
    const bottom = document.getElementById('playerChrome')
    const holds = (host, id) => host.querySelector('#' + id) !== null
    return {
      skipped: false,
      open: player.hidden === false,
      pageFull: player.classList.contains('is-page-full'),
      gapX: Math.round(window.innerWidth - box.width),
      gapY: Math.round(window.innerHeight - box.height),
      closeInTop: holds(top, 'btnClose'),
      fullscreenInTop: holds(top, 'btnFullscreen'),
      pageFullInTop: holds(top, 'btnPageFullscreen'),
      closeInBottom: holds(bottom, 'btnClose'),
      fullscreenInBottom: holds(bottom, 'btnFullscreen'),
    }
  })()`)
  console.log('播放器窗口:', JSON.stringify(playerOpen))
  if (playerOpen.skipped !== true) {
    check('点视频卡片打开播放器', playerOpen.open === true, JSON.stringify(playerOpen))
    check('打开时不是页面全屏', playerOpen.pageFull === false)
    check('窗口四周留白（不是整页）', playerOpen.gapX > 0 && playerOpen.gapY > 0, `左右 ${playerOpen.gapX}px，上下 ${playerOpen.gapY}px`)
    check('关闭按钮在视频上方的浮动条', playerOpen.closeInTop === true && playerOpen.closeInBottom === false, JSON.stringify(playerOpen))
    check('全屏按钮在视频上方的浮动条', playerOpen.fullscreenInTop === true && playerOpen.fullscreenInBottom === false, JSON.stringify(playerOpen))
    check('「页面全屏」按钮在上方浮动条', playerOpen.pageFullInTop === true)

    const pageFull = await ev(`(async () => {
      document.getElementById('btnPageFullscreen').click()
      await new Promise((r) => setTimeout(r, 400))
      const player = document.getElementById('player')
      const box = document.getElementById('playerWindow').getBoundingClientRect()
      return {
        on: player.classList.contains('is-page-full'),
        fills: Math.round(box.width) === window.innerWidth && Math.round(box.height) === window.innerHeight,
        buttonOn: document.getElementById('btnPageFullscreen').classList.contains('is-on'),
      }
    })()`)
    console.log('页面全屏:', JSON.stringify(pageFull))
    check('点「页面全屏」后铺满整页', pageFull.on === true && pageFull.fills === true, JSON.stringify(pageFull))
    check('「页面全屏」按钮点亮', pageFull.buttonOn === true)

    const playerClosed = await ev(`(async () => {
      document.getElementById('btnClose').click()
      await new Promise((r) => setTimeout(r, 400))
      const player = document.getElementById('player')
      const closed = { hidden: player.hidden, pageFull: player.classList.contains('is-page-full') }
      const card = document.querySelector('.card-video')?.closest('.card')
      card.click()
      await new Promise((r) => setTimeout(r, 1200))
      const box = document.getElementById('playerWindow').getBoundingClientRect()
      const reopened = {
        open: player.hidden === false,
        pageFull: player.classList.contains('is-page-full'),
        gapX: Math.round(window.innerWidth - box.width),
      }
      document.getElementById('btnClose').click()
      await new Promise((r) => setTimeout(r, 300))
      return { closed, reopened }
    })()`)
    console.log('关闭与重开:', JSON.stringify(playerClosed))
    check('上方浮动条的关闭能关掉播放器', playerClosed.closed.hidden === true)
    check('关掉时收回页面全屏', playerClosed.closed.pageFull === false, JSON.stringify(playerClosed.closed))
    check('再次打开仍是窗口形态', playerClosed.reopened.open === true && playerClosed.reopened.pageFull === false && playerClosed.reopened.gapX > 0, JSON.stringify(playerClosed.reopened))
  }

  // 图片查看器同一套规矩：先窗口、点「页面全屏」才铺满。目录里可能一张图都没有
  // （真实媒体库常常只有视频），那就跳过，而不是空手断言「有图片卡片」。
  await ev(`(() => {
    for (const [attr, value] of [['data-kind-btn', 'image'], ['data-content-btn', 'all']]) {
      const node = document.querySelector('[' + attr + '="' + value + '"]')
      if (node !== null && !node.classList.contains('is-active')) node.click()
    }
    return true
  })()`)
  await sleep(2500)
  const viewerState = await ev(`(async () => {
    const card = document.querySelector('.card-image')?.closest('.card')
    if (card === undefined || card === null) return { skipped: true }
    const host = document.getElementById('viewer')
    const top = document.getElementById('viewerTop')
    const bottom = document.querySelector('.viewer-bar')
    card.click()
    await new Promise((r) => setTimeout(r, 1200))
    const box = document.getElementById('viewerWindow').getBoundingClientRect()
    const opened = {
      open: host.hidden === false,
      pageFull: host.classList.contains('is-page-full'),
      gapX: Math.round(window.innerWidth - box.width),
      gapY: Math.round(window.innerHeight - box.height),
      closeInTop: top.querySelector('#imageClose') !== null,
      fullscreenInTop: top.querySelector('#imageFullscreen') !== null,
      closeInBottom: bottom.querySelector('#imageClose') !== null,
    }
    document.getElementById('imageFullscreen').click()
    await new Promise((r) => setTimeout(r, 400))
    const fullBox = document.getElementById('viewerWindow').getBoundingClientRect()
    const full = {
      on: host.classList.contains('is-page-full'),
      fills: Math.round(fullBox.width) === window.innerWidth && Math.round(fullBox.height) === window.innerHeight,
    }
    document.getElementById('imageClose').click()
    await new Promise((r) => setTimeout(r, 400))
    const closed = { hidden: host.hidden, pageFull: host.classList.contains('is-page-full') }
    return { skipped: false, opened, full, closed }
  })()`)
  console.log('查看器窗口:', JSON.stringify(viewerState))
  if (viewerState.skipped === true) {
    console.log('  这个目录里没有图片，跳过查看器的窗口断言')
  } else {
    check('点图片卡片打开查看器', viewerState.opened.open === true)
    check('查看器默认是窗口（不是整页）', viewerState.opened.pageFull === false && viewerState.opened.gapX > 0 && viewerState.opened.gapY > 0, JSON.stringify(viewerState.opened))
    check('关闭按钮在图片上方的浮动条', viewerState.opened.closeInTop === true && viewerState.opened.closeInBottom === false)
    check('「页面全屏」按钮在上方浮动条', viewerState.opened.fullscreenInTop === true)
    check('点「页面全屏」后查看器铺满整页', viewerState.full.on === true && viewerState.full.fills === true, JSON.stringify(viewerState.full))
    check('关掉查看器时收回页面全屏', viewerState.closed.hidden === true && viewerState.closed.pageFull === false, JSON.stringify(viewerState.closed))
  }

  // ── 13. 平铺网格的分块不许在末尾留半行空白 ─────────────────────────────
  //
  // 每个块是**自己**的一个网格，块内张数不整除列数时，块的最后一行就空着半行——
  // 用户看到的就是「视频后面凭空多出一行」。这里进「库」（会自动升到「全部」，条目
  // 够多、能分成多块），量两条：除最后一块外，块内张数必须整除列数；未挂载块的
  // 占位高度也不能和实高差太远（差太多 = 滚动条骗人）。
  //
  // 视口临时拉宽到 1920：默认 1280 宽时列数（4）正好整除 120，块边界对没对齐都看
  // 不出来；1920 宽下是 7 列，120 张会剩 1 张独占一行，正是用户看到的那一幕。
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1000, deviceScaleFactor: 1, mobile: false })
  await sleep(600)
  await ev(`(() => {
    // 只看图片 / 只看视频的筛选会把条目数压到一块以内，先都放回「全部」。
    for (const [attr, value] of [['data-kind-btn', 'all'], ['data-content-btn', 'all']]) {
      const node = document.querySelector('[' + attr + '="' + value + '"]')
      if (node !== null && !node.classList.contains('is-active')) node.click()
    }
    document.querySelector('.tree-library-name')?.click()
    return true
  })()`)
  await waitFor('document.querySelectorAll(".grid-chunk").length > 1', 30000)
  const chunkLayout = await ev(`(() => {
    const chunks = [...document.querySelectorAll('#grid .grid-chunk')]
    const mounted = chunks.find((chunk) => chunk.classList.contains('is-unmounted') === false)
    if (mounted === undefined || mounted.children.length === 0) return { skipped: true, chunks: chunks.length }
    const columns = getComputedStyle(mounted).gridTemplateColumns.split(' ').filter((part) => part !== '').length
    const counts = chunks.map((chunk) => chunk.children.length)
    const size = mounted.children.length
    const gap = 12
    const cardHeight = Math.round(mounted.firstElementChild.getBoundingClientRect().height)
    const fullHeight = Math.max(1, Math.ceil(size / columns)) * (cardHeight + gap) - gap
    // 每个未挂载块自己的张数看不到，但它的占位高度只可能落在「1 张」到「一整块」之间。
    // 超出这个上界就说明占位算错了（早先会算成整块实高的七八倍，滚动条跟着骗人）。
    const unmounted = chunks
      .filter((chunk) => chunk.classList.contains('is-unmounted'))
      .map((chunk) => ({ height: Math.round(chunk.offsetHeight), unmounted: true }))
    return {
      skipped: false,
      chunks: chunks.length,
      columns,
      size,
      counts,
      // 只有最后一块允许不满一行（那是列表的结尾）；未挂载的块没有卡片，不算。
      partial: counts.slice(0, -1).filter((count) => count % columns !== 0),
      fullHeight,
      unmounted,
    }
  })()`)
  console.log('分块排布:', JSON.stringify(chunkLayout))
  if (chunkLayout.skipped === true) {
    console.log('  页面里只有一个块（内容太少或还在加载），跳过块边界断言')
  } else {
    check('除最后一块外，块内张数整除列数', chunkLayout.partial.length === 0, `列数 ${chunkLayout.columns}，块内张数 ${JSON.stringify(chunkLayout.counts)}`)
    if (chunkLayout.unmounted.length === 0) {
      console.log('  没有未挂载的块，跳过占位高度断言')
    } else {
      const over = chunkLayout.unmounted.filter((item) => item.height > chunkLayout.fullHeight * 1.05)
      check('未挂载块的占位高度不超过一整块实高', over.length === 0, `一整块约 ${chunkLayout.fullHeight}px，实际 ${JSON.stringify(chunkLayout.unmounted.map((item) => item.height))}`)
    }
  }
  await send('Emulation.clearDeviceMetricsOverride')
  await sleep(400)

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
