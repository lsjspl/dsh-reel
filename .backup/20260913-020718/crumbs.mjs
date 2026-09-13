/**
 * 路径行（面包屑）的结构验证。
 *
 * 为什么需要它：这层逻辑（哪一级画成按钮、哪一级只是标记、深路径怎么折、菜单里
 * 有什么）以前只能靠 tests/verify-ui.mjs 在一个跑着的实例 + 真 Chrome 里看。
 * 那样测不出「不同深度的路径」。这里用一套极小的 DOM 替身把 app.js 真跑起来，
 * 只替换宿主接口（document / fetch / localStorage / IntersectionObserver），
 * 逻辑本身一行都不假手于人。
 *
 * 用法：node tests/crumbs.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const appRaw = readFileSync(join(here, '..', 'lib', 'assets', 'app.js'), 'utf8')
// 取证开关：把「每次重画前路径行里还剩几个节点」打进日志，用来分辨「重画没清干净」
// 和「一屏被渲染了两遍」这两种看起来一样的症状。锚点找不到时**不插桩**（也不报错）：
// 它只是调试辅助，不该因为 app.js 挪了一行就把整个用例挂掉。
const renderLog = []
const probeAnchor = 'clear(el.crumbs)\n'
const appSource = process.env.CRUMB_DEBUG === '1' && appRaw.includes(probeAnchor)
  ? appRaw.replace(
    probeAnchor,
    '__crumbRenders.push(el.crumbs.children.length)\n    clear(el.crumbs)\n',
  )
  : appRaw
if (process.env.CRUMB_DEBUG === '1' && appSource === appRaw) console.log('（取证插桩锚点没匹配上，本次不插桩）')

// ── 断言 ──────────────────────────────────────────────────────────────────

let passes = 0
const failures = []
const check = (label, ok, detail) => {
  if (ok) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const checkEqual = (label, actual, expected) => {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`)
}

// ── 极小 DOM ──────────────────────────────────────────────────────────────
//
// 只实现 app.js 真正用到的那些：createElement / appendChild / classList /
// dataset / textContent / 带属性选择器的 querySelector(All) / 事件冒泡。

let nodeSeq = 0

/**
 * 挂过监听的节点。
 *
 * 替身里每次「重启页面」都是把同一个 document 再喂给 app.js：模块级的
 * `document.addEventListener('keydown', …)` 会越积越多，于是按键会触发上一轮
 * 那份已经过期的状态。真实浏览器里整页刷新会把监听一起丢掉，所以这里也得丢。
 */
const knownNodes = new Set()

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.uid = (nodeSeq += 1)
    this.childNodes = []
    this.parentElement = null
    this.attributes = new Map()
    this.listeners = new Map()
    this.style = { setProperty() {}, removeProperty() {}, width: '' }
    this.dataset = new Proxy({}, {
      get: (_, key) => this.attributes.get(`data-${camelToDash(String(key))}`),
      set: (_, key, value) => {
        this.attributes.set(`data-${camelToDash(String(key))}`, String(value))
        return true
      },
      has: (_, key) => this.attributes.has(`data-${camelToDash(String(key))}`),
      deleteProperty: (_, key) => this.attributes.delete(`data-${camelToDash(String(key))}`),
    })
    this.hidden = false
    this.disabled = false
    this.tabIndex = -1
    this.title = ''
    this.type = ''
    this.checked = false
  }

  get className() {
    return this.attributes.get('class') ?? ''
  }

  set className(value) {
    this.attributes.set('class', String(value))
  }

  get classList() {
    const self = this
    const list = () => self.className.split(/\s+/).filter((name) => name !== '')
    const write = (names) => { self.className = names.join(' ') }
    return {
      contains: (name) => list().includes(name),
      add: (...names) => write([...new Set([...list(), ...names])]),
      remove: (...names) => write(list().filter((name) => !names.includes(name))),
      toggle: (name, force) => {
        const has = list().includes(name)
        const want = force === undefined ? !has : force === true
        if (want && !has) write([...list(), name])
        if (!want && has) write(list().filter((item) => item !== name))
        return want
      },
    }
  }

  get children() {
    return this.childNodes.filter((node) => node instanceof FakeNode)
  }

  get firstChild() {
    return this.childNodes[0] ?? null
  }

  get textContent() {
    return this.childNodes.map((node) => (node instanceof FakeNode ? node.textContent : String(node))).join('')
  }

  set textContent(value) {
    this.childNodes = []
    if (value !== '' && value !== undefined && value !== null) this.childNodes.push(String(value))
  }

  set innerHTML(value) {
    this.childNodes = []
    if (value !== '') this.childNodes.push(String(value))
  }

  get isConnected() {
    let node = this
    while (node.parentElement !== null) node = node.parentElement
    return node === doc.body || node === doc.documentElement
  }

  appendChild(node) {
    // 真实 DOM 的 appendChild 是「移动」：节点已有父节点时先从原处摘掉。
    // 少了这一步，orphan 节点会留在旧父节点的 childNodes 里，querySelector 就
    // 会数出幽灵节点——本项目已经因为它误报过一次。
    if (node.parentElement !== null && node.parentElement !== this) node.parentElement.removeChild(node)
    node.parentElement = this
    this.childNodes.push(node)
    return node
  }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node)
  }

  replaceChildren(...nodes) {
    this.childNodes = []
    for (const node of nodes) node.parentElement = this
    this.childNodes.push(...nodes)
  }

  remove() {
    if (this.parentElement === null) return
    this.parentElement.childNodes = this.parentElement.childNodes.filter((node) => node !== this)
    this.parentElement = null
  }

  removeChild(node) {
    this.childNodes = this.childNodes.filter((item) => item !== node)
    node.parentElement = null
    return node
  }

  contains(node) {
    for (let current = node; current !== null && current !== undefined; current = current.parentElement) {
      if (current === this) return true
    }
    return false
  }

  closest(selector) {
    for (let node = this; node !== null && node instanceof FakeNode; node = node.parentElement) {
      if (matchesSelector(node, selector)) return node
    }
    return null
  }

  get offsetHeight() {
    return 120
  }

  get offsetWidth() {
    return 300
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name) {
    this.attributes.delete(name)
  }

  addEventListener(type, handler, options) {
    const list = this.listeners.get(type) ?? []
    list.push({ handler, capture: options === true || options?.capture === true, once: options?.once === true })
    this.listeners.set(type, list)
    knownNodes.add(this)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter((item) => item.handler !== handler))
  }

  focus() {
    doc.activeElement = this
  }

  blur() {
    if (doc.activeElement === this) doc.activeElement = doc.body
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30, x: 0, y: 0 }
  }

  /** 走一遍「捕获 → 目标 → 冒泡」，够 app.js 的委托和关闭逻辑用。 */
  dispatch(type, extra = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra }
    const chain = [this]
    for (let node = this.parentElement; node !== null; node = node.parentElement) chain.push(node)
    for (const node of [...chain].reverse()) {
      if (node === doc) continue
      for (const item of node.listeners.get(type) ?? []) if (item.capture) item.handler(event)
    }
    for (const node of chain) {
      for (const item of [...(node.listeners.get(type) ?? [])]) {
        if (item.capture) continue
        item.handler(event)
        if (item.once) node.removeEventListener(type, item.handler)
      }
    }
    for (const node of [...chain].reverse()) {
      for (const item of [...(node.listeners.get(type) ?? [])]) {
        if (item.capture) continue
        if (item.once) node.removeEventListener(type, item.handler)
      }
    }
    return event
  }

  /** 给测试用：直接触发 click。 */
  click() {
    return this.dispatch('click')
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector) {
    const out = []
    walk(this, (node) => {
      if (node !== this && matchesSelector(node, selector)) out.push(node)
    })
    return out
  }
}

function camelToDash(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function walk(node, visit) {
  for (const child of node.childNodes) {
    if (!(child instanceof FakeNode)) continue
    visit(child)
    walk(child, visit)
  }
}

/** 复合选择器按空格拆开，逐段向上匹配（够用：类 / id / 属性 / 标签）。 */
function matchesSelector(node, selector) {
  const chain = selector.trim().split(/\s+/).filter((part) => part !== '')
  return matchChain(node, chain, chain.length - 1)
}

function matchChain(node, chain, index) {
  if (node === null || node === undefined || !(node instanceof FakeNode)) return false
  if (!matchSimple(node, chain[index])) return false
  if (index === 0) return true
  return matchChain(node.parentElement, chain, index - 1)
}

function matchSimple(node, part) {
  const tokens = part.match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(#[\w-]+)|(\[[^\]]+\])/g)
  if (tokens === null) return false
  for (const token of tokens) {
    if (token.startsWith('.')) {
      if (!node.classList.contains(token.slice(1))) return false
    } else if (token.startsWith('#')) {
      if (node.getAttribute('id') !== token.slice(1)) return false
    } else if (token.startsWith('[')) {
      const body = token.slice(1, -1)
      const match = /^([\w-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?$/.exec(body)
      if (match === null) return false
      const value = node.getAttribute(match[1])
      if (match[2] === undefined) {
        if (value === null) return false
      } else if (value !== match[3]) return false
    } else if (node.tagName !== token.toUpperCase()) {
      return false
    }
  }
  return true
}

const doc = new FakeNode('#document')
doc.documentElement = new FakeNode('html')
doc.body = new FakeNode('body')
doc.documentElement.appendChild(doc.body)
doc.readyState = 'complete'
doc.activeElement = doc.body
doc.byId = new Map()
doc.createElement = (tag) => new FakeNode(tag)
doc.createDocumentFragment = () => new FakeNode('#fragment')
doc.getElementById = (id) => {
  if (!doc.byId.has(id)) {
    const node = new FakeNode('div')
    node.setAttribute('id', id)
    doc.body.appendChild(node)
    // 页面里嵌在 #empty 下面的两个提示节点：真实 HTML 有，替身也得有。
    if (id === 'empty') {
      for (const className of ['empty-title', 'empty-hint']) {
        const hint = new FakeNode('p')
        hint.className = className
        node.appendChild(hint)
      }
    }
    doc.byId.set(id, node)
  }
  return doc.byId.get(id)
}
doc.addEventListener = FakeNode.prototype.addEventListener.bind(doc)
doc.dispatch = FakeNode.prototype.dispatch.bind(doc)
doc.querySelector = FakeNode.prototype.querySelector.bind(doc)
doc.querySelectorAll = FakeNode.prototype.querySelectorAll.bind(doc)

// ── 宿主接口替身 ──────────────────────────────────────────────────────────

const storage = new Map()
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
}
const sessionStorage = { ...localStorage }

const observers = []
class IntersectionObserver {
  constructor(callback) {
    this.callback = callback
    this.targets = []
    observers.push(this)
  }

  observe(target) {
    this.targets.push(target)
  }

  unobserve(target) {
    this.targets = this.targets.filter((item) => item !== target)
  }

  disconnect() {
    this.targets = []
  }
}

/** 目录树：root → 子目录。path 是根之后的部分。 */
const TREE = {
  '': ['a', 'b'],
  a: ['a1'],
  b: [],
  'a/a1': ['a1x'],
  'a/a1/a1x': ['deep'],
  'a/a1/a1x/deep': ['deeper'],
  'a/a1/a1x/deep/deeper': ['deepest'],
  'a/a1/a1x/deep/deeper/deepest': [],
}

const keyOf = (folders) => `r0${folders.length === 0 ? '' : `/${folders.join('/')}`}`

/**
 * 一层目录的 listing，契约与 host 的 /api/list 一致：
 * `crumbs[0]` 是根，最后一级是当前目录——所以长度为「路径段数 + 1」。
 */
const listingOf = (folders) => {
  const crumbList = [{ key: 'r0', name: '根目录' }]
  for (let depth = 0; depth < folders.length - 1; depth += 1) {
    crumbList.push({ key: keyOf(folders.slice(0, depth + 1)), name: folders[depth] })
  }
  if (folders.length > 0) crumbList.push({ key: keyOf(folders), name: folders[folders.length - 1] })
  return {
    root: { index: 0, path: 'D:\\根目录', label: '根目录' },
    rel: folders.join('/'),
    key: keyOf(folders),
    parent: folders.length === 0 ? null : keyOf(folders.slice(0, -1)),
    crumbs: crumbList,
    folders: (TREE[folders.join('/')] ?? []).map((name) => ({
      key: keyOf([...folders, name]),
      name,
      kind: 'directory',
      mtimeMs: 1,
      hidden: false,
      mediaCount: name === 'b' ? 0 : 2,
    })),
    files: [],
    offset: 0,
    nextOffset: null,
    fileCount: 0,
  }
}

const fetchCalls = []
const fetchJson = async (url) => {
  fetchCalls.push(url)
  if (url.includes('/api/session')) {
    return {
      version: 'test',
      base: '/reel',
      roots: [{ index: 0, path: 'D:\\根目录', label: '根目录' }],
      writable: false,
      revision: 1,
      capabilities: { thumbnails: false, probing: false },
    }
  }
  if (url.includes('/api/list')) {
    const raw = new URL(url, 'http://x').searchParams.get('k') ?? ''
    const path = raw.replace(/^r\d+\/?/, '')
    return listingOf(path === '' ? [] : path.split('/'))
  }
  if (url.includes('/api/scan')) return { items: [], scanned: 0, truncated: false }
  return {}
}

const fetchStub = async (url) => {
  const payload = await fetchJson(String(url))
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(payload)
    },
    async json() {
      return payload
    },
  }
}

/** 极简 Deferred：让「等一拍」在 vm 里也能用。 */
const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 把 app.js 跑起来 ──────────────────────────────────────────────────────

const windowStub = {
  location: { href: 'http://x/reel?k=r0', search: '?k=r0' },
  history: { replaceState() {} },
  addEventListener() {},
  matchMedia: () => ({ matches: false }),
  innerWidth: 1440,
  innerHeight: 900,
  open() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
}

windowStub.Reel = {
  toast() {},
  fmtTime: (seconds) => `${Math.round(seconds)}s`,
  fmtBytes: (bytes) => `${bytes}B`,
  progressStore: { get: () => 0, set() {} },
  createPlayer: () => ({ isOpen: () => false }),
}

const sandbox = {
  window: windowStub,
  document: doc,
  HTMLElement: FakeNode,
  Node: FakeNode,
  __crumbRenders: renderLog,
  localStorage,
  sessionStorage,
  location: windowStub.location,
  history: windowStub.history,
  fetch: fetchStub,
  IntersectionObserver,
  KeyboardEvent: class KeyboardEvent {},
  innerWidth: 1440,
  innerHeight: 900,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  performance: { now: () => Date.now() },
  CSS: { escape: (value) => String(value).replace(/["\\]/g, '\\$&') },
  URL,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Map,
  Set,
  Promise,
  Error,
  RegExp,
  isNaN,
  parseFloat,
  parseInt,
}
sandbox.globalThis = sandbox
sandbox.self = sandbox

runInNewContext(appSource, sandbox, { filename: 'app.js' })

// ── 取样工具 ──────────────────────────────────────────────────────────────

// 每次启动都会重建 DOM，所以这些句柄要现取，不能攥着第一轮的节点。
const crumbHost = () => doc.getElementById('crumbs')
const upButton = () => doc.getElementById('crumbUp')
const scopeToggle = () => doc.getElementById('scopeToggle')

const waitBoot = async () => {
  for (let i = 0; i < 60; i += 1) {
    if (crumbHost().children.length > 0) return true
    await sleep(20)
  }
  return false
}

/** 路径行的可观察形态。 */
const shape = () => ({
  text: crumbHost().textContent,
  names: crumbHost().querySelectorAll('.crumb-name').map((node) => node.textContent),
  // 可点的层级：当前层那一枚是 disabled 的，不算入口。
  links: crumbHost().querySelectorAll('.crumb-name').filter((node) => node.disabled !== true).map((node) => node.textContent),
  levels: crumbHost().querySelectorAll('.crumb').length,
  chevrons: crumbHost().querySelectorAll('.crumb-chevron').length,
  folds: crumbHost().querySelectorAll('.crumb-fold').length,
  separators: crumbHost().querySelectorAll('.crumb-sep').length,
  current: crumbHost().querySelector('.crumb.is-current .crumb-name')?.textContent ?? '',
  upDisabled: upButton().disabled,
  scopeOn: scopeToggle().classList.contains('is-on'),
})

/**
 * 换一个目录，并等渲染稳定。
 *
 * 地址栏换成新 key 后再启动一次 app.js：整页刷新等价。
 *
 * @param {string[]} folders - 根之后的路径段。
 * @returns {Promise<object>} 路径行的形态。
 */
const at = async (folders) => {
  const key = keyOf(folders)
  windowStub.location.href = `http://x/reel?k=${encodeURIComponent(key)}`
  windowStub.location.search = `?k=${encodeURIComponent(key)}`
  // 等价于整页刷新：DOM、监听、观察者全部丢掉重来。
  for (const node of knownNodes) node.listeners.clear()
  knownNodes.clear()
  observers.length = 0
  doc.byId.clear()
  doc.body.replaceChildren()
  sandbox.window = windowStub
  runInNewContext(appSource, sandbox, { filename: 'app.js' })
  await waitBoot()
  await sleep(30)
  if (process.env.CRUMB_DEBUG === '1') console.log('at', JSON.stringify(folders), '→', JSON.stringify(shape()))
  return shape()
}

// ── 用例 ──────────────────────────────────────────────────────────────────

// 1. 根目录：**一枚**路径，加粗、带自己那级的「▾」。早先这里是「可点的根 +
//    另一枚同名的当前层标记」，同一件事画两遍。
const root = await at([])
checkEqual('根目录只有一枚路径', [root.names, root.current, root.levels], [['根目录'], '根目录', 1])
check('根目录那枚不可点（没有去处）', root.links.length === 0, JSON.stringify(root))
check('根目录带自己那级的「▾」', root.chevrons === 1, JSON.stringify(root))
check('根目录没有分隔符也没有「…」', root.separators === 0 && root.folds === 0, JSON.stringify(root))
check('根目录上「返回上一级」是灰的', root.upDisabled === true, JSON.stringify(root))

// 2. 一层：根可点，当前层与根是同一套画法，只是不可点。
const one = await at(['a'])
checkEqual('一层路径：根可点、当前层加粗', [one.links, one.current], [['根目录'], 'a'])
check('一层路径只有一个分隔符', one.separators === 1, JSON.stringify(one))
check('「返回上一级」可用', one.upDisabled === false)
check('有子文件夹的两级都挂「▾」', one.chevrons === 2, JSON.stringify(one))

// 2b. 当前层没有子文件夹时不挂「▾」——点开空菜单没有意义。
const leaf = await at(['b'])
checkEqual('空文件夹的当前层不挂「▾」', [leaf.chevrons, leaf.current], [1, 'b'])

// 3. 两层：根 + 父级 + 当前层全部直给，不折。
const two = await at(['a', 'a1'])
checkEqual('两层路径：根与父级可点，当前层加粗', [two.links, two.current], [['根目录', 'a'], 'a1'])
check('两层不出现「…」', two.folds === 0, JSON.stringify(two))
check('两层路径用两个分隔符串起三级', two.separators === 2, JSON.stringify(two))

// 4. 七层：中间收成一枚「…」，根、当前层与当前层的父级保住。
renderLog.length = 0
const deep = await at(['a', 'a1', 'a1x', 'deep', 'deeper', 'deepest'])
if (process.env.CRUMB_DEBUG === '1') console.log('  本层重画次数:', renderLog.length, '各次重画前节点数:', JSON.stringify(renderLog))
checkEqual('深路径保住根、当前层与父级', [deep.links, deep.current], [['根目录', 'deeper'], 'deepest'])
if (process.env.CRUMB_DEBUG === '1') {
  const dump = (node, depth = 0) => [
    `${'  '.repeat(depth)}[${node.className || node.tagName}] "${node.textContent}" parent=${node.parentElement?.className || node.parentElement?.tagName || '(无)'}`,
    ...node.children.map((child) => dump(child, depth + 1)),
  ].join('\n')
  console.log('  路径行 DOM:\n' + dump(crumbHost()))
  console.log('  直接子节点数:', crumbHost().childNodes.length, ' children():', crumbHost().children.length)
  console.log('  匹配 .crumb-sep 的节点:', JSON.stringify(crumbHost().querySelectorAll('.crumb-sep').map((n) => `${n.className}@${n.parentElement?.className || n.parentElement?.tagName}`)))
}
check('深路径把中间收成「…」', deep.folds === 1, JSON.stringify(deep))
check('深路径不换行（分隔符数与可见级数一致）', deep.separators === 3, JSON.stringify(deep))
check('深路径的「…」说明省略了哪几级', crumbHost().querySelector('.crumb-fold').title.includes('a1'), crumbHost().querySelector('.crumb-fold').title)

// 5. 点「…」摊平：中间层级全部变成可点的名字（根、当前层、父级本来就直给）。
crumbHost().querySelector('.crumb-fold').click()
await sleep(20)
const expanded = shape()
checkEqual('点「…」后中间层级摊平', expanded.links, ['根目录', 'a', 'a1', 'a1x', 'deep', 'deeper'])
check('摊平后不再有「…」', expanded.folds === 0, JSON.stringify(expanded))
check('摊平后当前层不变', expanded.current === 'deepest', JSON.stringify(expanded))

// 6. 点名字 = 直接导航到那一层（不再弹菜单）。
crumbHost().querySelectorAll('.crumb-name')[1].click()
await sleep(60)
const afterJump = shape()
check('点中间层级直接跳过去', afterJump.current === 'a', JSON.stringify(afterJump))
check('跳过去之后「…」收回', afterJump.folds === 0, JSON.stringify(afterJump))
check('跳过去之后没弹出菜单', doc.querySelector('.crumb-menu') === null)

// 7. 「▾」只弹子文件夹，不再混范围。
const chevron = crumbHost().querySelectorAll('.crumb-chevron')[0]
chevron.click()
await sleep(80)
const menu = doc.querySelector('.crumb-menu')
check('点「▾」弹出菜单', menu !== null)
if (menu !== null) {
  const rows = menu.querySelectorAll('.crumb-menu-item')
  checkEqual('菜单里除了子文件夹没有别的动作', rows.length, menu.querySelectorAll('.crumb-menu-item[data-folder-entry]').length)
  check('菜单里没有范围项（范围在工具条开关上）', menu.querySelector('.crumb-menu-item[data-all-entry]') === null)
  check('菜单里没有「只看根目录这一层」的旧项', menu.querySelector('.crumb-menu-item[data-root-entry]') === null)
  checkEqual('菜单里是这一级的子文件夹', menu.querySelectorAll('.crumb-menu-item[data-folder-entry]').map((node) => node.querySelector('.crumb-menu-name').textContent), ['a', 'b'])
  checkEqual('菜单带上每个子目录的媒体数', menu.querySelectorAll('.crumb-menu-tally').map((node) => node.textContent), ['2 个', '空'])
  // 点一个子文件夹即导航，菜单关掉。
  rows[1].click()
  await sleep(60)
  check('点菜单里的子文件夹会进去', shape().current === 'a', JSON.stringify(shape()))
  check('进去之后菜单关掉', doc.querySelector('.crumb-menu') === null)
}

// 8. 范围开关：独立于路径行、状态自述、范围由工具条那枚开关表达。
const beforeToggle = shape()
check('默认是「本层」', beforeToggle.scopeOn === false && scopeToggle().textContent === '本层', JSON.stringify(beforeToggle))
scopeToggle().click()
await sleep(80)
const allOn = shape()
check('打开后开关自述「所有层级」', allOn.scopeOn === true && scopeToggle().textContent === '所有层级', JSON.stringify(allOn))
check('范围不改变路径本身', JSON.stringify(allOn) === JSON.stringify({ ...beforeToggle, scopeOn: true }), JSON.stringify(allOn))
scopeToggle().click()
await sleep(80)
check('关掉后开关回到「本层」', scopeToggle().textContent === '本层' && scopeToggle().classList.contains('is-on') === false)

// 9. 「返回上一级」按钮与 Backspace。
const start = await at(['a', 'a1'])
check('起点在 a1', start.current === 'a1', JSON.stringify(start))
upButton().click()
await sleep(60)
check('「‹」回到上一级', shape().current === 'a', JSON.stringify(shape()))
doc.dispatch('keydown', { key: 'Backspace', target: doc.body })
await sleep(60)
check('Backspace 也回上一级', shape().current === '根目录', JSON.stringify(shape()))

// ── 结果 ──────────────────────────────────────────────────────────────────

console.log(fetchCalls.length > 0 ? `（期间发出 ${fetchCalls.length} 次接口请求）` : '')
if (failures.length === 0) {
  console.log(`通过 ${passes} 项\n全部通过 ✓`)
} else {
  console.log(`通过 ${passes} 项，失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
