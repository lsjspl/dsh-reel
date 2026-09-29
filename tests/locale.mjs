/**
 * 显示文案的契约测试：插件在「插件」面板上的标题、说明和图标由 **locale 字典**
 * 决定，不是 package.json 的 description。
 *
 * 为什么必须有：dsh 的 readPluginMeta 读 `<包>/locale/en.json` 与
 * `<包>/locale/zh.json`，把 `meta.title` / `meta.description` 合成一张语言映射；
 * 缺了 locale 目录就回退成 package.json 的 `name` / `description`——于是中文界面
 * 上显示的仍然是英文。这个回退不会报错，只是静静地显示错语言，所以必须锁住。
 *
 * 用法：node tests/locale.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const failures = []
const passes = []

function check(label, condition, detail) {
  if (condition) passes.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
function checkEqual(label, actual, expected) {
  check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// ── locale 目录与两个字典 ──────────────────────────────────────────────────

const enPath = join(root, 'locale', 'en.json')
const zhPath = join(root, 'locale', 'zh.json')
check('存在 locale/en.json', existsSync(enPath))
check('存在 locale/zh.json', existsSync(zhPath))

// 读不到就报断言失败，而不是让 readFileSync 抛出去把整个脚本崩掉——那样诊断
// 信息会淹没在栈里。
const readDictionary = (path) => {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    failures.push(`locale/${path.endsWith('zh.json') ? 'zh' : 'en'}.json 不是合法 JSON — ${error.message}`)
    return null
  }
}
const en = readDictionary(enPath)
const zh = readDictionary(zhPath)
check('en.json 可解析', en !== null)
check('zh.json 可解析', zh !== null)

check('en.json 有 meta 对象', typeof en?.meta === 'object' && en.meta !== null)
check('zh.json 有 meta 对象', typeof zh?.meta === 'object' && zh.meta !== null)
check('en 的 meta.title 非空', typeof en?.meta?.title === 'string' && en.meta.title.trim() !== '')
check('zh 的 meta.title 非空', typeof zh?.meta?.title === 'string' && zh.meta.title.trim() !== '')
check('en 的 meta.description 非空', typeof en?.meta?.description === 'string' && en.meta.description.trim() !== '')
check('zh 的 meta.description 非空', typeof zh?.meta?.description === 'string' && zh.meta.description.trim() !== '')

// 两个字典的键必须一致，否则某种语言会缺字段、静默回退到英文。
checkEqual('en / zh 的 meta 键一致',
  Object.keys(en?.meta ?? {}).sort().join(','),
  Object.keys(zh?.meta ?? {}).sort().join(','))

// 中文标题必须真的含中文——否则「翻译」其实还是英文。
check('zh 标题含中文字符', /[\u4e00-\u9fff]/.test(zh?.meta?.title ?? ''), String(zh?.meta?.title))
check('zh 说明含中文字符', /[\u4e00-\u9fff]/.test(zh?.meta?.description ?? ''), String(zh?.meta?.description).slice(0, 40))

// ── manifest 声明 ─────────────────────────────────────────────────────────

// locale 必须可解析：dsh 通过 `<包>/locale/<lang>.json` 这个子路径 import，
// 没有导出的子路径解析不到，字典就读不到。
check('exports 声明了 ./locale/*.json',
  typeof manifest.exports?.['./locale/*.json'] === 'string',
  JSON.stringify(Object.keys(manifest.exports ?? {})))
check('files 包含 locale（否则发布包里没有字典）',
  Array.isArray(manifest.files) && manifest.files.includes('locale'),
  JSON.stringify(manifest.files))

// ── 图标 ───────────────────────────────────────────────────────────────────

const iconRel = manifest.icon
check('声明了 icon', typeof iconRel === 'string', String(iconRel))
if (typeof iconRel === 'string') {
  // 相对路径、留在包内、合法扩展名、不超过 256 KiB —— readPluginMeta 的四条硬规则。
  check('icon 是相对路径', !/^[A-Za-z][A-Za-z\d+.-]*:/.test(iconRel) && !iconRel.startsWith('/') && !iconRel.startsWith('\\'), iconRel)
  check('icon 留在包内', !iconRel.split(/[\\/]/).includes('..'), iconRel)
  check('icon 扩展名合法', ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(iconRel.slice(iconRel.lastIndexOf('.')).toLowerCase()), iconRel)
  const iconPath = join(root, iconRel)
  check('icon 文件存在', existsSync(iconPath), iconPath)
  if (existsSync(iconPath)) {
    const size = statSync(iconPath).size
    check('icon 不超过 256 KiB', size <= 256 * 1024, `${size} bytes`)
    check('icon 是常规文件', statSync(iconPath).isFile())
  }
  // 图标也要有可解析的导出子路径（manifest.icon 自带 `./`，别再补一个）。
  const iconSubpath = iconRel.startsWith('./') ? iconRel : `./${iconRel.replace(/\\/g, '/')}`
  check('exports 声明了 icon 子路径',
    typeof manifest.exports?.[iconSubpath] === 'string',
    `${iconSubpath} 不在 ${JSON.stringify(Object.keys(manifest.exports ?? {}))}`)
}

// ── 汇编 ───────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passes.length} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
