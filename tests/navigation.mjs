import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../lib/assets/app.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
const playerSource = readFileSync(new URL('../lib/assets/player.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
let passes = 0
const equal = (label, actual, expected) => { assert.deepEqual(actual, expected, label); passes += 1 }
const check = (label, value) => { assert.ok(value, label); passes += 1 }
const tick = () => new Promise((done) => setImmediate(done))
function cut(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a)
  assert.ok(a >= 0 && b > a, `locate ${start}`)
  return text.slice(a, b)
}

class NodeStub {
  children = []
  dataset = {}
  classList = { add() {}, remove() {} }
  textWrites = []
  #text = ''
  get textContent() { return this.#text }
  set textContent(value) { this.#text = value; this.textWrites.push(value) }
  appendChild(child) { this.children.push(child) }
  replaceChildren() { this.children = [] }
  addEventListener() {}
}
class ObserverStub {
  static all = []
  constructor(callback) { this.callback = callback; ObserverStub.all.push(this) }
  observe(node) { this.target = node }
  disconnect() { this.target = null }
  intersect() { this.callback([{ isIntersecting: true }]) }
}

function harness(api) {
  const context = {
    state: { key: 'r5000000000000001/A', mode: 'current', sort: 'new', kinds: 'all', filter: '', scanned: [], scannedKey: null, scannedVersion: -1, session: null, media: [] },
    crumbFoldersCache: new Map(),
    itemByKey: new Map(),
    probeQueue: new Map(), probeTimer: 0, treeRootKeys: null, moreSentinel: null,
    groupTouched: false, groupOpen: new Set(),
    AbortController, clearTimeout, setTimeout,
    renders: [],
    api,
    guard: async (label, task) => { try { return await task() } catch { return undefined } },
    renderTree() {},
    renderAll() { context.renders.push(context.state.key); context.testing.renderSummary() },
    kindLabel: () => context.state.kinds === 'video' ? '视频' : context.state.kinds === 'image' ? '图片' : '媒体文件',
    grids: [],
    renderGrid() { context.grids.push(context.state.media.map(item => item.key)) },
    player: { isOpen: () => false },
    recomputeMedia() { context.state.media = context.state.mode === 'current' ? context.state.listing?.files ?? [] : context.state.scanned },
    growChunks() {},
    clear: (node) => node.replaceChildren(),
    el: { more: new NodeStub(), content: new NodeStub(), empty: new NodeStub(), search: new NodeStub(), summary: new NodeStub(), libraryTitle: new NodeStub(), loadStatus: new NodeStub(), loadStatusText: new NodeStub(), loadRetry: new NodeStub() },
    document: { createElement: () => new NodeStub(), querySelector: () => null },
    window: { location: { href: 'http://fixture/reel?k=old&q=no-match' }, history: { replaceState(_, __, url) { context.lastUrl = url.href } }, setInterval(callback) { context.poll = callback } },
    localStorage: { setItem() {} },
    URL, performance: { now: () => Date.now() },
    setDirectoryOpen() {}, syncTreeActive() {},
    toast() {},
    IntersectionObserver: ObserverStub,
    isLibraryKey: (key) => key === 'lib',
    rootKeyOf: (key) => String(key).replace(/^r(\d+).*$/, 'r$1'),
    LIBRARY_KEY: 'lib',
    ensureLibraryMode() { context.state.mode = 'all' },
    wallpaper: null, currentWallpaper: () => null, applyWallpaper() {},
    probeCapability: null, previewCapability: null, previewVersion: '1',
  }
  createContext(context)
  const code = cut(source, '  const comparators = {', '  const sortLabel = ')
    + cut(source, '  let navigationVersion = 0', '  /**\n   * 过滤 + 排序出当前要画的媒体列表。')
    + cut(source, '  const computeMedia = (pool) => {', '  /**\n   * 重新画整个列表模式。')
    + cut(source, '  const renderSummary = () => {', '  // 子文件夹的行列表整个移除了')
    + cut(source, '  const renderMore = () => {', '  // ── 目录树')
    + cut(source, '  const reloadSession = async () => {', '  // ── 启动')
    + cut(source, '  const watchSettings = () => {', '  /**\n   * 启动前把所有 id')
    + cut(source, '  let lastNavigationAt = 0', '  // ── 图片查看器')
    + '\n globalThis.testing = { loadListing, loadSearch, loadRecursive, renderSummary, renderMore, reloadSession, watchSettings, invalidateData, openLibrary, retryBrowseLoad, cancelSearch, pollIndexStatus: () => pollIndexStatus(searchVersion, navigationVersion, searchController?.signal), version: () => navigationVersion };'
  runInContext(code, context)
  return context
}

const listing = (key, files = [], folders = [{ key: `${key}/nested`, name: 'nested' }]) => ({ ok: true, payload: { key, files, folders, nextOffset: null } })
const pending = () => {
  const calls = []
  return {
    calls,
    api: (path, options) => new Promise((resolve) => calls.push({ path, options, resolve })),
  }
}

function clock(app) {
  const tasks = new Map()
  let id = 0
  app.setTimeout = (callback, delay) => { tasks.set(++id, { callback, delay }); return id }
  app.clearTimeout = id => tasks.delete(id)
  return {
    advance(delay) {
      for (const [id, task] of [...tasks]) {
        if (task.delay <= delay) { tasks.delete(id); task.callback() }
        else task.delay -= delay
      }
    },
  }
}

// Ignore AbortSignal in this transport to model a response that arrives after
// cancellation, so correctness cannot depend only on fetch abort behaviour.
{
  const transport = pending(), app = harness(transport.api)
  const a = app.testing.loadListing()
  app.state.key = 'r5000000000000001/B'
  const b = app.testing.loadListing()
  check('新导航取消旧请求', transport.calls[0].options.signal.aborted)
  transport.calls[1].resolve(listing(app.state.key, [{ key: 'B' }]))
  await b
  transport.calls[0].resolve(listing('r5000000000000001/A', [{ key: 'A' }]))
  await a
  equal('后返回的旧目录不能覆盖新目录', app.state.key, 'r5000000000000001/B')
  equal('旧响应不能覆盖文件列表', app.state.listing.files[0].key, 'B')
  equal('旧导航不会触发新渲染', app.renders.length, 1)
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.mode = 'all'
  const a = app.testing.loadListing()
  transport.calls[0].resolve(listing(app.state.key))
  await tick()
  const oldScan = transport.calls[1]
  app.state.key = 'r5000000000000001/B'
  const b = app.testing.loadListing()
  transport.calls[2].resolve(listing(app.state.key))
  await tick()
  transport.calls[3].resolve({ ok: true, payload: { items: [{ key: 'B', name: 'B' }], nextCursor: null, truncated: false } })
  await b
  oldScan.resolve({ ok: true, payload: { items: [{ key: 'A', name: 'A' }], nextCursor: 'stale-cursor', truncated: true } })
  await a
  equal('旧递归结果不能覆盖新目录', app.state.scanned[0].key, 'B')
  equal('过期扫描不会继续请求下一页', transport.calls.length, 4)
  equal('扫描缓存属于最终目录', app.state.scannedKey, 'r5000000000000001/B')
}

{
  let scans = 0, generation = 'old', requests = []
  const app = harness(async (path) => {
    requests.push(path)
    if (path.startsWith('/api/list')) return listing(app.state.key)
    scans += 1
    return { ok: true, payload: { items: [{ key: generation, name: generation }], nextCursor: null, truncated: false } }
  })
  app.state.mode = 'all'
  await app.testing.loadListing()
  generation = 'new'
  await app.testing.loadListing()
  equal('普通切换可以复用同版本扫描', scans, 1)
  app.crumbFoldersCache.set('old', ['stale'])
  await app.testing.loadListing({ refresh: true })
  equal('显式刷新重新扫描', scans, 2)
  equal('显式刷新看到新增媒体', app.state.scanned[0].name, 'new')
  check('显式刷新清除目录缓存', !app.crumbFoldersCache.has('old'))
}

{
  let scans = 0
  const app = harness(async (path) => {
    if (path.startsWith('/api/list')) return listing(app.state.key)
    scans += 1
    return { ok: true, payload: { items: [], nextCursor: null, truncated: false } }
  })
  app.state.mode = 'all'
  await app.testing.loadListing(); await app.testing.loadListing()
  equal('有子目录但没有媒体的成功扫描也可缓存', scans, 1)
  await app.testing.loadListing({ refresh: true })
  equal('有子目录的目录刷新仍会重新扫描', scans, 2)
}

{
  const calls = []
  const app = harness(async (path) => {
    calls.push(path)
    return listing(app.state.key, [], [])
  })
  app.state.mode = 'folder'
  app.state.media = [{ key: 'old' }]
  app.state.scanned = app.state.media
  app.state.scannedKey = 'r5000000000000001/old'
  app.state.key = 'r5000000000000001/empty'
  equal('真正空目录的导航成功', await app.testing.loadListing(), true)
  equal('空目录不额外等待递归扫描', calls.length, 1)
  equal('空目录替换旧目录的媒体', app.state.media.length, 0)
  equal('空目录仍然渲染目录外壳', app.renders, [app.state.key])
  equal('空目录扫描缓存属于当前目录', app.state.scannedKey, app.state.key)
}

{
  const paths = []
  const app = harness(async (path) => {
    paths.push(path)
    if (path.startsWith('/api/list')) return listing(app.state.key)
    if (!path.includes('cursor=')) return { ok: true, payload: { items: [{ key: 'first', kind: 'image', mtimeMs: 1 }], nextCursor: 'next/page', truncated: true } }
    return { ok: true, payload: { items: [{ key: 'first', kind: 'image', mtimeMs: 1 }, { key: 'latest', kind: 'image', mtimeMs: 3 }], nextCursor: null, truncated: false } }
  })
  app.state.mode = 'all'
  await app.testing.loadListing()
  equal('页面会自动请求续扫游标', paths.filter((path) => path.includes('cursor=')).length, 1)
  check('游标按 URL 编码发送', paths.some((path) => path.includes('cursor=next%2Fpage')))
  equal('所有页结果收齐且按 key 去重', app.state.scanned.length, 2)
  equal('最终页决定截断状态', app.state.scannedTruncated, false)
  equal('最后一页的最新媒体会排在全库首位', app.state.media[0].key, 'latest')
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.listing = { files: [{ key: 'old' }], nextOffset: 400 }
  app.state.media = app.state.listing.files
  app.testing.renderMore()
  const observer = ObserverStub.all.at(-1)
  observer.intersect(); observer.intersect()
  equal('哨兵重复通知只发一份续页请求', transport.calls.length, 1)
  app.state.key = 'r5000000000000001/B'
  const navigation = app.testing.loadListing()
  check('换目录立即断开旧哨兵', observer.target === null)
  transport.calls[1].resolve(listing(app.state.key, [{ key: 'new' }]))
  await navigation
  transport.calls[0].resolve({ ok: true, payload: { files: [{ key: 'stale-page' }], nextOffset: null } })
  await tick()
  equal('旧目录续页不能追加到新列表', app.state.listing.files.length, 1)
  equal('新目录文件保持正确', app.state.listing.files[0].key, 'new')
}

{
  const app = harness(async (path) => ({ ok: true, payload: { roots: [{ index: 5000000000000002, path: '/B' }], revision: 1, capabilities: {} } }))
  app.state.session = { roots: [{ index: 5000000000000001, path: '/A' }], revision: 0 }
  app.state.scanned = [{ key: 'old' }]; app.state.scannedKey = app.state.key
  app.crumbFoldersCache.set('old', [])
  await app.testing.reloadSession()
  equal('配置更新失效递归缓存', app.state.scannedKey, null)
  equal('配置更新失效目录缓存', app.crumbFoldersCache.size, 0)
  equal('当前根删除后回到库', app.state.key, 'lib')
  equal('回到库时使用全部视图', app.state.mode, 'all')
}

{
  const roots = [{ index: 5000000000000002, path: '/B' }]
  let listRequests = 0
  const app = harness(async (path) => {
    if (path === '/api/session') return { ok: true, payload: { roots, revision: 0, capabilities: {} } }
    if (path.startsWith('/api/list')) { listRequests += 1; return listing('lib') }
    return { ok: true, payload: { items: [], nextCursor: null, truncated: false } }
  })
  app.state.session = { revision: 0, roots: [{ index: 5000000000000001, path: '/A' }, ...roots] }
  app.testing.watchSettings()
  await app.poll()
  equal('revision 不变的目录离线仍会更新会话', app.state.session.roots.length, 1)
  equal('离线根不继续充当当前目录', app.state.key, 'lib')
  equal('可用根变化触发列表重载', listRequests, 1)
}

{
  const roots = [{ index: 5000000000000001, path: '/A' }]
  let listRequests = 0
  const app = harness(async (path) => {
    if (path === '/api/session') return { ok: true, payload: { roots, revision: 1, capabilities: {} } }
    listRequests += 1
    return listRequests === 1 ? { ok: false, status: 503, payload: { error: 'temporary failure' } } : listing(app.state.key)
  })
  app.state.session = { roots, revision: 0 }
  app.testing.watchSettings()
  await app.poll(); await app.poll(); await app.poll()
  equal('配置刷新失败后下一拍会重试', listRequests, 2)
  check('重试成功恢复列表', app.state.listing !== null)
}

{
  const context = { document: { createElement: () => new NodeStub() }, current: () => ({ subtitles: [{ name: 'movie.srt', label: '<img src=x onerror=bad()>' }] }), video: { textTracks: [] }, el: { subtitleMenu: new NodeStub(), subtitles: new NodeStub() } }
  createContext(context)
  runInContext(cut(playerSource, '    const buildSubtitleMenu = () => {', '    /** 用视频自身的时长') + '\n buildSubtitleMenu();', context)
  equal('字幕名称作为纯文本显示', context.el.subtitleMenu.children[1].children[0].textContent, '<img src=x onerror=bad()>')
  equal('字幕名称不写入 innerHTML', context.el.subtitleMenu.children[1].innerHTML, undefined)
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.session = { searchIndex: {} }
  const opening = app.testing.loadListing()
  transport.calls[0].resolve(listing(app.state.key, [{ key: 'direct', name: 'direct.mp4', kind: 'video', mtimeMs: 1 }]))
  await tick()
  equal('directory shell renders before the global index request completes', app.renders.length, 1)
  check('catalog-enabled browsing does not start another recursive directory walk', transport.calls[1].path.startsWith('/api/search?'))
  const old = transport.calls[1]
  app.state.filter = 'new'
  const search = app.testing.loadSearch()
  check('new search cancels the old query', old.options.signal.aborted)
  transport.calls[2].resolve({ ok: true, payload: { items: [{ key: 'new' }], total: 1, generation: 2, indexing: false, nextOffset: null } })
  await search
  old.resolve({ ok: true, payload: { items: [{ key: 'old' }], total: 1, generation: 1, indexing: false, nextOffset: null } })
  await opening
  equal('an old search response cannot replace the current query results', app.state.media[0].key, 'new')
}
{
  const transport = pending(), app = harness(transport.api)
  app.state.session = { searchIndex: {} }
  app.state.listing = { key: app.state.key }
  app.state.catalogResult = { items: [{ key: 'A' }], generation: 1, nextOffset: 120 }
  const a = app.testing.loadSearch({ append: true })
  const b = app.testing.loadSearch({ append: true })
  equal('duplicate pagination triggers share one in-flight request', transport.calls.length, 1)
  transport.calls[0].resolve({ ok: true, payload: { items: [{ key: 'B' }], generation: 2, total: 2, indexing: false, nextOffset: null } })
  await a; await b
  equal('new index generations restart pagination instead of merging incompatible offsets', transport.calls.length, 2)
  transport.calls[1].resolve({ ok: true, payload: { items: [{ key: 'A' }, { key: 'B' }], generation: 2, total: 2, indexing: false, nextOffset: null } })
  await tick()
  equal('restarted pagination retains every matching file exactly once', Array.from(app.state.catalogResult.items, item => item.key), ['A', 'B'])
}
// 全库入口会退出目录里的筛选和分组，优先使用完整索引。
for (const mode of ['current', 'all', 'folder']) {
  const transport = pending(), app = harness(transport.api)
  app.state.session = { searchIndex: {} }
  app.state.key = 'r5000000000000001/empty'
  app.state.mode = mode
  app.state.filter = 'no-match'
  app.state.kinds = 'image'
  app.el.search.value = 'no-match'
  app.el.content.scrollTop = 2000
  app.testing.openLibrary()
  equal(`全部媒体从 ${mode} 模式回到完整全库范围`, [app.state.key, app.state.mode, app.state.kinds, app.state.filter], ['lib', 'all', 'all', ''])
  equal(`全部媒体从 ${mode} 模式清除输入并回到顶部`, [app.el.search.value, app.el.content.scrollTop], ['', 0])
  check(`全部媒体从 ${mode} 模式清除地址里的旧搜索`, !app.lastUrl.includes('q='))
  transport.calls[0].resolve(listing('lib'))
  await tick()
  const query = new URL(transport.calls[1].path, 'http://fixture')
  equal(`全部媒体从 ${mode} 模式按索引查询所有硬盘和所有类型`, [query.pathname, query.searchParams.get('k'), query.searchParams.get('kinds'), query.searchParams.get('q'), query.searchParams.get('recursive')], ['/api/search', 'lib', 'all', '', '1'])
  transport.calls[1].resolve({ ok: true, payload: { items: [{ key: 'disk-A' }, { key: 'disk-B' }], total: 2, generation: 1, indexing: false, nextOffset: null } })
  await tick()
  equal(`全部媒体从 ${mode} 模式显示不同硬盘的结果`, Array.from(app.state.media, item => item.key), ['disk-A', 'disk-B'])
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.mode = 'all'
  const opening = app.testing.loadListing()
  const direct = { key: 'direct', kind: 'image', name: 'direct.jpg', mtimeMs: 1 }
  transport.calls[0].resolve(listing(app.state.key, [direct]))
  await tick()
  equal('无索引时不等待递归扫描就显示当前层媒体', Array.from(app.state.media, item => item.key), ['direct'])
  equal('无索引时目录外壳立即显示', app.renders.length, 1)
  check('无索引扫描中显示持续的进度提示', app.state.scanLoading && !app.el.loadStatus.hidden)
  transport.calls[1].resolve({ ok: true, payload: { items: [direct], scanned: 10, nextCursor: 'page-2', truncated: true } })
  await tick()
  check('递归下一页未返回时第一页已渲染', app.grids.length === 1 && app.state.media[0].key === 'direct')
  transport.calls[2].resolve({ ok: true, payload: { items: [{ key: 'nested', kind: 'image', name: 'nested.jpg', mtimeMs: 2 }], scanned: 20, nextCursor: null, truncated: false } })
  await opening
  equal('递归完成后收齐各页并应用排序', Array.from(app.state.media, item => item.key), ['nested', 'direct'])
  check('递归完成后结束扫描提示', !app.state.scanLoading && app.el.loadStatus.hidden)
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.mode = 'all'
  const opening = app.testing.loadListing()
  transport.calls[0].resolve(listing(app.state.key))
  await tick()
  transport.calls[1].resolve({ ok: true, payload: { items: [{ key: 'partial', kind: 'image', name: 'partial.jpg', mtimeMs: 1 }], nextCursor: 'page-2', truncated: true } })
  await tick()
  transport.calls[2].resolve({ ok: false, status: 503, payload: { error: 'disk temporarily offline' } })
  equal('递归失败向调用方报告未完成', await opening, false)
  equal('递归续页失败保留已找到的媒体', Array.from(app.state.media, item => item.key), ['partial'])
  check('递归失败提供可用的重试入口', !app.el.loadRetry.hidden && !app.state.scanLoading)
  const retry = app.testing.retryBrowseLoad()
  check('无索引时重试会重新打开目录', transport.calls[3].path.startsWith('/api/list?'))
  transport.calls[3].resolve(listing(app.state.key, [], []))
  await retry
}

{
  const paths = []
  let indexing = true
  const first = { key: 'first', kind: 'image', name: 'first.jpg', mtimeMs: 1, size: 1 }
  const app = harness(async path => {
    paths.push(path)
    if (path === '/api/session') return { ok: true, payload: { searchIndex: { indexing, indexed: indexing ? 500 : 1000 } } }
    return { ok: true, payload: { items: [first], indexing, indexed: indexing ? 1 : 1000, total: indexing ? 1 : 1000, generation: indexing ? 1 : 2, nextOffset: null } }
  })
  app.state.session = { searchIndex: {} }
  app.state.listing = { key: app.state.key }
  await app.testing.loadSearch()
  const originalItems = app.state.media
  await app.testing.pollIndexStatus()
  await app.testing.pollIndexStatus()
  equal('建立索引时后台只读进度，不重复查询媒体页', paths.filter(path => path.startsWith('/api/search?')).length, 1)
  equal('建立索引时不重画已有媒体列表', app.grids.length, 1)
  check('建立索引时保留当前媒体对象与分页快照', app.state.media === originalItems && app.state.catalogResult.generation === 1)
  check('索引进度仍然更新', app.el.loadStatusText.textContent.includes('500'))
  indexing = false
  await app.testing.pollIndexStatus()
  equal('完成索引后仅查询一次最终结果', paths.filter(path => path.startsWith('/api/search?')).length, 2)
  equal('最终媒体页相同则不替换 DOM', app.grids.length, 1)
  equal('索引完成后更新总数', app.state.catalogResult.total, 1000)
  check('索引完成后结束进度提示', app.el.loadStatus.hidden)
  app.testing.cancelSearch()
}

{
  const transport = pending(), app = harness(transport.api)
  app.state.session = { searchIndex: {} }
  app.state.listing = { key: app.state.key }
  const first = app.testing.loadSearch()
  transport.calls[0].resolve({ ok: true, payload: { items: [{ key: 'old', mtimeMs: 1 }], total: 1, indexed: 1, indexing: true, generation: 1, nextOffset: null } })
  await first
  const poll = app.testing.pollIndexStatus()
  equal('进度轮询使用会话状态接口', transport.calls[1].path, '/api/session')
  app.state.key = 'r5000000000000001/other'
  const opening = app.testing.loadListing()
  transport.calls[1].resolve({ ok: true, payload: { searchIndex: { indexing: false, indexed: 100 } } })
  await poll
  equal('旧目录的索引进度不能触发新目录媒体刷新', transport.calls.length, 3)
  transport.calls[2].resolve(listing(app.state.key))
  await tick()
  transport.calls[3].resolve({ ok: true, payload: { items: [{ key: 'new' }], total: 1, indexing: false, generation: 2, nextOffset: null } })
  await opening
  equal('过期索引轮询不会覆盖新目录', app.state.media[0].key, 'new')
  app.testing.cancelSearch()
}

{
  const paths = []
  const app = harness(async path => {
    paths.push(path)
    return { ok: true, payload: { searchIndex: { indexing: false, indexed: 2000 } } }
  })
  app.state.key = 'lib'
  app.state.session = { searchIndex: {} }
  const loaded = Array.from({ length: 240 }, (_, index) => ({ key: `file-${index}` }))
  app.state.catalogResult = { items: loaded, total: 500, indexing: true, generation: 1, nextOffset: 240 }
  app.state.media = loaded
  app.el.content.scrollTop = 3000
  await app.testing.pollIndexStatus()
  equal('已经向下浏览时索引完成不重新请求第一页', paths, ['/api/session'])
  check('索引完成保留已加载的多页与滚动位置', app.state.media === loaded && app.el.content.scrollTop === 3000 && app.grids.length === 0)
  equal('多页浏览中的全库总数也会更新', app.state.catalogResult.total, 2000)
  check('多页浏览中的索引状态正常结束', !app.state.catalogResult.indexing && app.el.loadStatus.hidden)
  app.testing.cancelSearch()
}

{
  const transport = pending(), app = harness(transport.api), time = clock(app)
  app.state.session = { searchIndex: {} }
  app.state.mode = 'all'
  app.el.summary.textContent = '12 个媒体文件 · 含子目录'
  app.el.summary.textWrites = []
  app.el.loadStatus.hidden = true
  const opening = app.testing.loadListing()
  time.advance(100)
  equal('快速切目录不立即显示打开提示', app.el.loadStatusText.textWrites, [])
  transport.calls[0].resolve(listing(app.state.key, [{ key: 'direct', kind: 'image', mtimeMs: 1 }]))
  await tick()
  equal('目录外壳显示时不闪过临时直接文件统计', app.el.summary.textWrites, [])
  transport.calls[1].resolve({ ok: true, payload: { items: [{ key: 'final' }], total: 8, indexing: false, generation: 1, nextOffset: null } })
  await opening
  equal('新目录统计只提交一次最终文字', app.el.summary.textWrites, ['8 个媒体文件 · 含子目录'])
  time.advance(1000)
  equal('快请求完成后不补闪过期加载提示', app.el.loadStatusText.textWrites, [])
}

{
  const transport = pending(), app = harness(transport.api), time = clock(app)
  app.state.session = { searchIndex: {} }
  app.state.listing = { key: app.state.key }
  const first = app.testing.loadSearch()
  transport.calls[0].resolve({ ok: true, payload: { items: [{ key: 'first' }], total: 1, indexed: 50, indexing: true, generation: 1, nextOffset: null } })
  await first
  const progress = app.el.loadStatusText.textContent
  app.el.loadStatusText.textWrites = []
  app.state.key = 'r5000000000000001/other'
  const opening = app.testing.loadListing()
  time.advance(250)
  equal('切目录期间索引行保持进度文字', app.el.loadStatusText.textContent, progress)
  transport.calls[1].resolve(listing(app.state.key))
  await tick()
  time.advance(250)
  equal('索引查询等待中不穿插其他加载文字', app.el.loadStatusText.textWrites, [])
  transport.calls[2].resolve({ ok: true, payload: { items: [], total: 0, indexed: 50, indexing: true, generation: 1, nextOffset: null } })
  await opening
  equal('相同索引进度不会重复改写提示 DOM', app.el.loadStatusText.textWrites, [])
  const poll = app.testing.pollIndexStatus()
  transport.calls[3].resolve({ ok: true, payload: { searchIndex: { indexing: true, indexed: 51 } } })
  await tick()
  // An empty directory may request its first indexed page as the index grows.
  transport.calls[4].resolve({ ok: true, payload: { items: [], total: 0, indexed: 51, indexing: true, generation: 1, nextOffset: null } })
  await poll
  equal('索引页与轮询采用同一提示格式', app.el.loadStatusText.textWrites, ['正在建立索引 · 已找到 51 个媒体'])
  app.testing.cancelSearch()
}

{
  const transport = pending(), app = harness(transport.api), time = clock(app)
  app.state.session = { searchIndex: {} }
  const first = app.testing.loadListing()
  app.state.key = 'r5000000000000001/B'
  const second = app.testing.loadListing()
  time.advance(200)
  equal('慢目录读取仍有可见加载反馈', app.el.loadStatusText.textContent, '正在打开目录…')
  transport.calls[1].resolve(listing(app.state.key))
  await tick()
  transport.calls[2].resolve({ ok: true, payload: { items: [], total: 0, indexing: false, generation: 1, nextOffset: null } })
  await second
  transport.calls[0].resolve(listing('r5000000000000001/A'))
  await first
  time.advance(1000)
  check('旧导航的延迟提示不能覆盖新目录的完成状态', app.el.loadStatus.hidden && app.el.summary.textContent === '0 个媒体文件 · 当前目录')
}

{
  const app = harness(async () => ({ ok: false, status: 503, payload: { error: 'offline' } }))
  app.state.session = { searchIndex: {} }
  app.state.listing = { key: app.state.key }
  app.state.summaryPending = true
  app.el.summary.textContent = '99 个媒体文件 · 含子目录'
  await app.testing.loadSearch()
  equal('查询失败不会把旧目录数量当成新目录数量', app.el.summary.textContent, '')
  check('查询失败保留重试提示', !app.el.loadRetry.hidden)
}

console.log(`导航与缓存回归通过 ${passes} 项 ✓`)
