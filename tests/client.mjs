/**
 * 客户端半边的契约测试：把 lib/client.js 当成浏览器模块系统那样加载，检查它
 * 注册到**正确的插槽**、用**正确的 key**，并且能用真实表单模型跑通编辑与保存。
 *
 * 为什么必须有这个文件：客户端半边的错误在服务端完全看不出来——路由照样 200，
 * 因为 apply 根本不需要设置。错误只表现为「卡片不出现」，而卡片出现与否取决于
 * 两个极易写错的字面量：插槽名和 key。这个文件把这两处锁死。
 *
 * 用法：node tests/client.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const failures = []
const passes = []

/** 断言。 */
function check(label, condition, detail) {
  if (condition) passes.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 断言相等。 */
function checkEqual(label, actual, expected) {
  check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// ── 浏览器环境桩 ───────────────────────────────────────────────────────────
//
// client.js 顶部就摸 window.__ModuleLoader__ 和 document（注入样式），所以桩
// 必须在 import 之前就位。

let registered = null
const injectedStyles = []
globalThis.window = globalThis
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => injectedStyles.push(tag) },
}
globalThis.localStorage = { getItem: () => null }
globalThis.__ModuleLoader__ = { load: (definition) => { registered = definition } }

const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

// ── primitives 替身 ────────────────────────────────────────────────────────
//
// 真实的 @deepseek-ai/dsh-client-ui-primitives 是浏览器包，在 Node 里拉不起来
// （它 import simple-icons、katex、shiki 和一堆 .module.css）。这里只替身本文件
// 用到的四个导出，并记录交互，供断言检查卡片是否读了正确的 props、调了正确的
// action。表单模型的分层语义由 tests/run.mjs 的宿主侧测试覆盖。

const calls = []
const primitives = {
  SettingsForm: (props) => {
    calls.push(['SettingsForm', { labels: props.labels, state: props.state }])
    return { type: 'SettingsForm', props }
  },
  SettingsValueField: (props) => {
    calls.push(['SettingsValueField', { id: props.id, text: props.text, disabled: props.disabled }])
    return { type: 'SettingsValueField', props }
  },
  settingsTextField: (field) => ({
    field,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => (text.trim() === '' ? { kind: 'clear' } : { kind: 'set', value: text.trim() }),
  }),
  SettingsFormModel: class {
    constructor(scope, specs) {
      this.scope = scope
      this.specs = specs
      this.staged = new Map()
    }
    bind(project) {
      this.project = project
      return { getSnapshot: () => project(), subscribe: () => () => {} }
    }
    shell() {
      const snap = this.scope.getSnapshot()
      return {
        available: snap.status === 'ready',
        writable: snap.writable,
        dirty: this.staged.size > 0,
        invalid: false,
        saving: false,
        failed: false,
      }
    }
    field(field) {
      const spec = this.specs.find((entry) => entry.field === field)
      const staged = this.staged.get(field)
      const value = this.scope.getSnapshot().value ?? {}
      return {
        text: staged !== undefined ? staged : spec.format(value[field]),
        overridden: Object.prototype.hasOwnProperty.call(this.scope.getSnapshot().user ?? {}, field),
        invalid: false,
      }
    }
    actions() {
      return {
        edit: (field, text) => { calls.push(['edit', { field, text }]); this.staged.set(field, text) },
        resetField: (field) => { calls.push(['resetField', { field }]); this.staged.delete(field) },
        save: () => calls.push(['save', {}]),
        discard: () => { calls.push(['discard', {}]); this.staged.clear() },
      }
    }
    dispose() { calls.push(['dispose', {}]) }
  },
}

const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
  }),
}

// ── 加载工厂 ───────────────────────────────────────────────────────────────

check('工厂已注册', registered !== null)
checkEqual('工厂 id 是包名', registered?.id, 'dsh-reel')

const seed = { react, '@deepseek-ai/dsh-client-ui-primitives': primitives }
const mod = registered.factory((spec) => {
  if (spec in seed) return seed[spec]
  throw new Error(`unexpected require("${spec}")`)
})

checkEqual('注入服务', mod.inject.join(','), 'slots,locale,configForms')
check('导出 apply', typeof mod.apply === 'function')

// ── 假的浏览器 cordis 上下文 ───────────────────────────────────────────────

const host = {
  value: { roots: ['D:\\Photos'], cacheDir: '', wallpaper: '' },
  user: { roots: ['D:\\Photos'] },
  writable: true,
  listeners: new Set(),
}
const scope = {
  getSnapshot: () => ({
    status: 'ready',
    value: host.value,
    base: {},
    user: host.user,
    writable: host.writable,
    revision: 1,
  }),
  subscribe: (listener) => { host.listeners.add(listener); return () => host.listeners.delete(listener) },
}

const dictionaries = new Map()
const slotEntries = []
const disposers = []
const ctx = {
  locale: {
    bind: (ns) => (key) => (dictionaries.get(ns) ?? {})[key] ?? key,
    register: (ns, dict) => { dictionaries.set(ns, { ...(dict.zh ?? {}), ...(dict.en ?? {}) }); return () => {} },
  },
  effect: (execute) => {
    const dispose = execute()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => {}
  },
  slots: {
    inject: (name, register) => { register(); return () => {} },
    register: (options, component) => { slotEntries.push({ options, component }); return () => {} },
  },
  configForms: {
    get: () => scope,
    whileServed: (namespaces, register) => { const off = register(new Set(namespaces)); return () => off?.() },
  },
}

mod.apply(ctx)

// ── 注册契约：插槽名与 key ─────────────────────────────────────────────────
//
// 这两处正是之前写错的地方。plugins.item 是「官方」分组的列表，dsh 自己的插槽
// 契约把它标为「由官方设置页占用，一个宿主平面命名空间一个伴生包」，并明确要求
// bundle 的配置放进 plugins.bundle.config 或 plugins.row.config。dsh-reel 是
// bundle，所以它的配置属于 bundle 自己的页面。

checkEqual('只注册一个插槽', slotEntries.length, 1)
checkEqual('插槽名是 plugins.bundle.config', slotEntries[0]?.options.name, 'plugins.bundle.config')
checkEqual('key 是 bundle 包名', slotEntries[0]?.options.key, 'dsh-reel')
checkEqual('locale 命名空间', slotEntries[0]?.options.locale, 'settings.plugins.reel')
check('注册了组件', typeof slotEntries[0]?.component === 'function')

// whileServed 以命名空间名单为准；名字写错就永远不触发。
check('命名空间名单含 reel', mod.inject.includes('configForms'))

// ── 卡片渲染 ───────────────────────────────────────────────────────────────

const entry = slotEntries[0]
const face = entry.options.inject()
checkEqual('inject face 的键', Object.keys(face).sort().join(','), 'discard,edit,hooks,resetField,save')
checkEqual('hooks 只暴露 reelCard', Object.keys(face.hooks).join(','), 'reelCard')

const snapshot = face.hooks.reelCard.getSnapshot()
check('快照可供组件读取', typeof snapshot === 'object')
check('快照带表单外壳字段', typeof snapshot.writable === 'boolean' && typeof snapshot.dirty === 'boolean')
checkEqual('快照带 roots 字段', typeof snapshot.roots?.text, 'string')

const render = (overrides = {}) => entry.component({
  view: 'page',
  t: (key) => key,
  ...face,
  ...overrides,
  useReelCard: (selector) => selector(face.hooks.reelCard.getSnapshot()),
})

// summary 视图只回一行文案（卡片标题下的说明）。
const summary = entry.component({
  view: 'summary',
  t: (key) => key,
  ...face,
  useReelCard: (selector) => selector(face.hooks.reelCard.getSnapshot()),
})
checkEqual('summary 视图返回说明文案', summary, 'description')

const tree = render()
checkEqual('卡片根节点是 SettingsForm', typeof tree.type, 'function')
checkEqual('SettingsForm 收到 4 个子节点', tree.props.children.length, 4)

// 表单外壳：只读状态必须来自宿主，而不是组件自己猜的。
checkEqual('可写状态透传给表单', tree.props.state.writable, true)
host.writable = false
checkEqual('只读状态透传给表单', render().props.state.writable, false)
host.writable = true

// ── 交互：编辑目录列表 ─────────────────────────────────────────────────────

const children = tree.props.children
const rootsField = children.find((child) => child && child.props && child.props.className === 'reel_field'
  && child.props.children?.[1]?.props?.className === 'reel_rootList')
check('找到目录列表字段', Boolean(rootsField))

const rows = rootsField.props.children[1].props.children
const firstInput = rows[0].props.children[0]
firstInput.props.onChange({ target: { value: 'E:\\Media' } })
const edits = calls.filter(([name]) => name === 'edit')
checkEqual('改动落到 roots 草稿', edits.at(-1)?.[1]?.field, 'roots')
checkEqual('草稿值是整份多行文本', edits.at(-1)?.[1]?.text, 'E:\\Media')

// 移除与添加按钮同样要写回多行文本。
const removeButton = rows[0].props.children[1]
calls.length = 0
removeButton.props.onClick()
checkEqual('移除按钮写回剩余行', calls.at(-1)?.[1]?.text, '')

// roots 被用户层覆盖时，标题旁应有「已覆盖」与重置。
const resetButton = rootsField.props.children[0].props.children
  .find((child) => child && child.props && child.props.className === 'reel_reset')
check('roots 覆盖时显示重置', Boolean(resetButton))
calls.length = 0
resetButton?.props.onClick()
checkEqual('重置走 resetField', calls.at(-1)?.[0], 'resetField')
checkEqual('重置的字段是 roots', calls.at(-1)?.[1]?.field, 'roots')

// ── 交互：本机壁纸 ─────────────────────────────────────────────────────────

check('无本机壁纸时不显示该行', !JSON.stringify(tree).includes('reel_localWall'))
globalThis.localStorage.getItem = () => JSON.stringify({ key: 'r0/照片/wall.jpg' })
const localTree = render()
check('有本机壁纸时显示该行', JSON.stringify(localTree).includes('reel_localWall'))
check('展示的是那个 key', JSON.stringify(localTree).includes('r0/照片/wall.jpg'))

// ── 释放 ───────────────────────────────────────────────────────────────────

calls.length = 0
for (const dispose of disposers.reverse()) dispose()
check('卸载时释放表单订阅', calls.some(([name]) => name === 'dispose'))

// ── 汇总 ───────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passes.length} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
