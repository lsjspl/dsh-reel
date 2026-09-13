/**
 * 分组树（`buildFolderTree`）的行为验证。
 *
 * 单独抽出来测，是因为这段逻辑最容易悄悄错、又最难一眼看出来：目录键要和
 * 服务端的 keyFor 同构（错一位，点「打开 ›」就跳到别的目录）、子目录要真的
 * 嵌对父亲、组头的「N 个」要按**整棵子树**累计而不是这一层。
 *
 * 用法：node tests/group-tree.mjs
 *
 * 这里**不复制**被测代码：直接从 lib/assets/app.js 里把那一个函数抠出来，
 * 在 vm 里跑。复制一份的话，改了实现而忘了改测试就永远测不出问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'assets', 'app.js'), 'utf8')

/** 抠出一个顶层 const 箭头函数（从声明处到它的收尾 `}`）。 */
const extract = (name) => {
  const start = source.indexOf(`const ${name} = `)
  if (start === -1) throw new Error(`app.js 里找不到 ${name}`)
  const open = source.indexOf('{', source.indexOf('=>', start))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 的花括号没有闭合`)
}

let passes = 0
const failures = []
const check = (label, ok, detail) => {
  if (ok) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const checkEqual = (label, actual, expected) => {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`)
}

/** 在给定的 state / listing 下建一棵树。 */
const build = (items, key, listing) => {
  const sandbox = { state: { key, listing } }
  runInNewContext(`${extract('buildFolderTree')}\nthis.buildFolderTree = buildFolderTree`, sandbox)
  return sandbox.buildFolderTree(items, key, listing.crumbs[listing.crumbs.length - 1].name)
}

const file = (rel, size = 1) => ({ key: `r0/${rel}`, rel, name: rel.split('/').pop(), size, kind: 'image' })

// ── 用例 1：根上直接有文件，又嵌了两层子目录 ──────────────────────────────

const listing = {
  rel: 'Photos',
  key: 'r0/Photos',
  root: { label: 'D 盘' },
  crumbs: [{ key: 'r0', name: 'D 盘' }, { key: 'r0/Photos', name: 'Photos' }],
}
const items = [
  file('Photos/封面.jpg'),
  file('Photos/2024/a.jpg'),
  file('Photos/2024/b.jpg'),
  file('Photos/2024/元旦/c.png'),
  file('Photos/2025/x.mp4'),
]
const tree = build(items, 'r0/Photos', listing)

checkEqual('根节点用当前目录的名字', tree.name, 'Photos')
checkEqual('根节点带回自己的 rel', tree.rel, 'Photos')
checkEqual('根节点的键就是当前目录键', tree.key, 'r0/Photos')
check('根上直接挂的文件只有 1 个', tree.files.length === 1, `实际 ${tree.files.length}`)
checkEqual('根的子树总数是全部 5 条', tree.total, 5)
checkEqual('根的直接子目录按名字排序', tree.children.map((child) => child.name), ['2024', '2025'])

const y2024 = tree.children[0]
checkEqual('子目录的键 = 父键 + 名字', y2024.key, 'r0/Photos/2024')
check('子目录的文件挂在自己身上', y2024.files.length === 2, `实际 ${y2024.files.length}`)
checkEqual('子目录的子树数含更深一层', y2024.total, 3)
checkEqual('子目录的深度是 1', y2024.depth, 1)

const newYear = y2024.children[0]
checkEqual('第三层的键逐级拼出来', newYear.key, 'r0/Photos/2024/%E5%85%83%E6%97%A6')
checkEqual('第三层的深度是 2', newYear.depth, 2)
checkEqual('第三层只有一个文件', newYear.total, 1)
checkEqual('没有文件的层不出现', newYear.children.length, 0)

// ── 用例 2：不挂在当前目录下的条目不会被塞进来 ────────────────────────────
// 服务端只会扫当前目录的子树，但真出了越界条目也不该把树拐到别处去。

const strays = build([...items, file('Other/x.jpg')], 'r0/Photos', listing)
checkEqual('越界的条目被归到根上，键不会被带歪', strays.total, 6)
checkEqual('树的形状不变（没有凭空多出目录）', strays.children.map((child) => child.name), ['2024', '2025'])

// ── 用例 3：在根目录上（rel 为空）────────────────────────────────────────

const atRoot = {
  rel: '',
  key: 'r0',
  root: { label: 'D 盘' },
  crumbs: [{ key: 'r0', name: 'D 盘' }],
}
const rootTree = build([file('a.jpg'), file('电影/b.mp4')], 'r0', atRoot)
checkEqual('根目录上根节点 rel 是空的', rootTree.rel, '')
checkEqual('根目录下第一层子目录的键', rootTree.children[0].key, 'r0/%E7%94%B5%E5%BD%B1')
checkEqual('总数照旧累计', rootTree.total, 2)

// ── 用例 4：一条媒体都没有 ────────────────────────────────────────────────

const empty = build([], 'r0/Photos', listing)
checkEqual('空树的总数是 0', empty.total, 0)
checkEqual('空树没有子目录', empty.children.length, 0)
check('空树的总数为 0 时调用方会回退平铺', empty.total === 0)

// ── 用例 5：库树：第一层是各配置目录，键保持各自的根 ──────────────────────

/**
 * 在给定的扫描结果 / 会话根下建库树。
 *
 * @param {object[]} items - 扫描结果（每条带 root）。
 * @param {object[]} roots - 会话里的配置根。
 * @returns {object} 库树根。
 */
const buildLibrary = (items, roots) => {
  const sandbox = {
    LIBRARY_KEY: 'lib',
    state: { key: 'lib', listing: { rel: '' }, scanned: items, session: { roots } },
  }
  runInNewContext(
    `${extract('buildFolderTree')}\n${extract('buildLibraryTree')}\nthis.buildLibraryTree = buildLibraryTree`,
    sandbox,
  )
  return sandbox.buildLibraryTree()
}

const libFile = (root, rel) => ({ key: `r${root}/${rel}`, rel, name: rel.split('/').pop(), size: 1, kind: 'image', root })
const libRoots = [{ index: 0, label: '照片盘' }, { index: 1, label: '电影盘' }]
const libTree = buildLibrary([
  libFile(0, '2024/a.jpg'),
  libFile(0, '2024/b.jpg'),
  libFile(0, '封面.jpg'),
  libFile(1, '影片/x.mp4'),
  libFile(1, 'y.mp4'),
], libRoots)

checkEqual('库树的根叫「库」', libTree.name, '库')
checkEqual('库树的键是 lib', libTree.key, 'lib')
checkEqual('库树的总数是全部条目', libTree.total, 5)
checkEqual('库树第一层是各配置目录（按配置顺序）', libTree.children.map((child) => child.name), ['照片盘', '电影盘'])
checkEqual('库树里根的键保持 r<index>', libTree.children.map((child) => child.key), ['r0', 'r1'])
checkEqual('库的子树深度从 1 起', libTree.children.map((child) => child.depth), [1, 1])
checkEqual('各根累计自己的子树数', libTree.children.map((child) => child.total), [3, 2])
checkEqual('根的子树键仍带根前缀', libTree.children[0].children[0].key, 'r0/2024')
checkEqual('第三层的深度是 2', libTree.children[0].children[0].depth, 2)

// 没有媒体的根不出现：库树只画有内容的目录，空根不占一行。
const libPartial = buildLibrary([libFile(1, 'z.jpg')], libRoots)
checkEqual('没有媒体的根不出现在库树里', libPartial.children.map((child) => child.name), ['电影盘'])
checkEqual('总数只算出现的根', libPartial.total, 1)

// ── 结果 ──────────────────────────────────────────────────────────────────

if (failures.length === 0) {
  console.log(`通过 ${passes} 项\n全部通过 ✓`)
} else {
  console.log(`通过 ${passes} 项，失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}
