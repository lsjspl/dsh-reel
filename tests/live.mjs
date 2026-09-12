/**
 * 对「真机 dsh」的集成测试：打的是一个真正由 dsh web 起起来的服务，
 * 插件是 profile 里安装的那一份。
 *
 * 用法：node tests/live.mjs <origin>
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:3092'
const failures = []
let passes = 0

const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const checkEqual = (label, actual, expected) => {
  check(label, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const request = async (path, options = {}) => {
  const response = await fetch(`${origin}${path}`, options)
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, buffer }
}

const json = (result) => JSON.parse(result.buffer.toString('utf8'))

const keyOf = (root, rel) => `r${root}${rel === '' ? '' : `/${rel.split('/').map(encodeURIComponent).join('/')}`}`

// 1. 页面与静态资源
{
  const page = await request('/reel')
  checkEqual('页面 200', page.status, 200)
  const html = page.buffer.toString('utf8')
  check('页面是 HTML', html.includes('<!doctype html>'))
  check('页面含列表模式', html.includes('data-mode-btn="browse"'))
  check('页面含刷视频模式', html.includes('data-mode-btn="feed"'))

  for (const asset of ['app.css', 'app.js', 'player.js']) {
    const file = await request(`/reel/${asset}`)
    checkEqual(`${asset} 200`, file.status, 200)
    check(`${asset} 非空`, file.buffer.length > 1000, `${file.buffer.length} 字节`)
  }
}

// 2. 会话与目录
const session = json(await request('/reel/api/session'))
check('会话报告可写设置', session.writable === true)
// ffmpeg 有没有取决于这台机器；两种都是合法状态，但不能是 undefined。
check('会话报告了缩略图能力', typeof session.capabilities?.thumbnails === 'boolean')
check('会话报告了 ffmpeg 路径或 null', session.capabilities?.ffmpeg === null || typeof session.capabilities?.ffmpeg === 'string', JSON.stringify(session.capabilities))
console.log(`  能力：ffmpeg=${session.capabilities.ffmpeg ?? '(未找到)'} probing=${session.capabilities.probing}`)

/**
 * 找一个真的有媒体的目录来断言分类与字段。
 *
 * 不能写死 fixture 路径：这套用例是要打在「任何一份真实媒体库」上的，
 * 而真实库的根目录常常只是一层分类目录。先看根，根没有媒体就下沉一层。
 */
let targetKey = 'r0'
let targetRel = ''
let listing = json(await request('/reel/api/list?k=r0'))
if ((listing.files ?? []).length === 0) {
  for (const folder of (listing.folders ?? []).slice(0, 20)) {
    const candidate = json(await request(`/reel/api/list?k=${encodeURIComponent(folder.key)}`))
    if ((candidate.files ?? []).length > 0) {
      targetKey = folder.key
      targetRel = folder.name
      listing = candidate
      break
    }
  }
}
console.log(`测试目录：${targetKey}${targetRel === '' ? '' : `（${targetRel}）`} —— ${(listing.files ?? []).length} 个媒体文件`)

check('目录返回文件与子目录字段', Array.isArray(listing.files) && Array.isArray(listing.folders))
check('有可断言的媒体文件', (listing.files ?? []).length > 0, `实际 ${(listing.files ?? []).length}`)
check('只列图片/视频', (listing.files ?? []).every((item) => item.kind === 'image' || item.kind === 'video'))
check('每个文件都有可用的 key', (listing.files ?? []).every((item) => /^r\d+(\/|$)/.test(item.key)))
check('每个文件都有 etag 与大小', (listing.files ?? []).every((item) => typeof item.etag === 'string' && item.size >= 0))
check('视频带 streamUrl 与 stream 端点', (listing.files ?? []).filter((item) => item.kind === 'video').every((item) => /\/reel\/stream\?k=/.test(item.streamUrl ?? '')))
check('不把字幕/文本当媒体', (listing.files ?? []).every((item) => !/\.(srt|vtt|ass|ssa|txt|nfo)$/i.test(item.name)))
check('子目录项有 key 与名称', (listing.folders ?? []).every((folder) => typeof folder.key === 'string' && typeof folder.name === 'string'))

// 有侧车字幕时，必须被识别出来并给出可用的 VTT 地址。
const withSubs = (listing.files ?? []).find((item) => (item.subtitles ?? []).length > 0)
if (withSubs !== undefined) {
  const track = withSubs.subtitles[0]
  check('字幕地址指向 subtitle 端点', /\/reel\/subtitle\?k=/.test(track.url ?? ''))
  const vtt = await request(track.url)
  check('字幕能取到且是 VTT', vtt.status === 200 && vtt.buffer.toString('utf8').startsWith('WEBVTT'))
} else {
  console.log('  该目录没有侧车字幕，跳过字幕断言')
}

const scan = json(await request(`/reel/api/scan?k=${encodeURIComponent(keyOf(0, ''))}&kinds=image,video&limit=100&depth=6`))
check('递归扫描找到媒体', scan.items.length >= 3, `实际 ${scan.items.length}`)
check('递归扫描不下钻 node_modules 之外的隐藏目录', scan.items.every((item) => !String(item.rel).startsWith('.testhome/')))

// 3. 范围流：拖动进度条的全部依据
//
// 用目标目录里真实存在的第一个视频。这里刻意不假设文件内容或长度：
// 先取整文件当作基准，再证明「范围切片拼起来 == 整文件」，
// 这条等价关系才是播放器能随便拖的根本依据。
{
  const video = (listing.files ?? []).find((item) => item.kind === 'video')
  check('目标目录里有视频可测', video !== undefined)

  if (video !== undefined) {
    const path = `/reel/stream?k=${encodeURIComponent(video.key)}`
    const full = await request(path)
    const size = full.buffer.length
    checkEqual('整文件 200', full.status, 200)
    checkEqual('整文件长度与 stat 一致', size, video.size)
    checkEqual('accept-ranges', full.headers.get('accept-ranges'), 'bytes')
    check('有 ETag', typeof full.headers.get('etag') === 'string')

    const part = await request(path, { headers: { range: 'bytes=0-99' } })
    checkEqual('范围 206', part.status, 206)
    checkEqual('范围长度 100', part.buffer.length, 100)
    checkEqual('Content-Range 正确', part.headers.get('content-range'), `bytes 0-99/${size}`)

    const suffix = await request(path, { headers: { range: `bytes=-${Math.min(100, size)}` } })
    checkEqual('后缀范围 206', suffix.status, 206)
    checkEqual('后缀范围落在文件末尾', suffix.headers.get('content-range'), `bytes ${size - Math.min(100, size)}-${size - 1}/${size}`)

    const overshoot = await request(path, { headers: { range: `bytes=${size + 10}-` } })
    checkEqual('起点越界回 416', overshoot.status, 416)

    const head = await request(path, { method: 'HEAD' })
    checkEqual('HEAD 200', head.status, 200)
    checkEqual('HEAD 空体', head.buffer.length, 0)

    // 模拟一次拖动：分段取回后用整文件逐字节比对。
    const step = Math.max(1, Math.floor(size / 8))
    const chunks = []
    for (let offset = 0; offset < size; offset += step) {
      const end = Math.min(offset + step - 1, size - 1)
      const chunk = await request(path, { headers: { range: `bytes=${offset}-${end}` } })
      if (chunk.status !== 206) check(`分段 ${offset} 回 206`, false, `实际 ${chunk.status}`)
      chunks.push(chunk.buffer)
    }
    check('分段拼接长度正确', Buffer.concat(chunks).length === size, `${Buffer.concat(chunks).length} vs ${size}`)
    check('分段拼接与整文件逐字节相同', Buffer.concat(chunks).equals(full.buffer))

    const reject = await request(`/reel/stream?k=${encodeURIComponent(keyOf(0, '../package.json'))}`)
    check('文件包含性检查生效', reject.status === 404 || reject.status === 400, `实际 ${reject.status}`)
  }
}

// 4. 设置写入往返（会真的写 settings.yaml）
//
// 这套用例可能打在用户的真实 $DSH_HOME 上，所以写入的内容必须是「本来就在
// 的目录」：先记下原始根集合，写完验证，再原样写回。不制造任何测试专用的
// 目录，也不假设根目录里有什么。
{
  const before = json(await request('/reel/api/config'))
  check('配置可读', Array.isArray(before.roots) && before.roots.length >= 1)
  checkEqual('配置命名空间', before.namespace, 'reel')

  const original = before.roots.map((root) => root.path)

  const bad = await request('/reel/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: ['Z:\\definitely\\missing\\directory'] }),
  })
  checkEqual('不存在的目录被拒', bad.status, 400)

  // 用第一个真实根做一次往返：内容不变，但足以证明写入链路是通的。
  const written = await request('/reel/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: original }),
  })
  checkEqual('写入目录 200', written.status, 200)
  const after = json(await request('/reel/api/config'))
  checkEqual('写入后根数量不变', after.roots.length, original.length)
  check('写入后根路径不变', after.roots.every((root, index) => root.path === original[index]), JSON.stringify(after.roots))

  // 副作用检查：这次写必须真的落到 settings.yaml 的 reel 段。
  const settingsPath = `${process.env.DSH_HOME}\\settings.yaml`
  const { readFileSync } = await import('node:fs')
  const settings = readFileSync(settingsPath, 'utf8')
  check('settings.yaml 出现 reel 段', settings.includes('reel:'), settings.slice(0, 200))
  check('settings.yaml 记录了第一个根', settings.includes(original[0].replace(/\\/g, '\\')))

  // 还原（内容本来就相同，这一步是为了在断言失败时也能留下干净状态）。
  const restored = await request('/reel/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roots: original }),
  })
  checkEqual('还原目录 200', restored.status, 200)
  const final = json(await request('/reel/api/config'))
  checkEqual('目录数量还原', final.roots.length, original.length)
}

// 5. 目录选择器
{
  const roots = json(await request('/reel/api/browse?path='))
  check('空路径返回系统入口', Array.isArray(roots.folders) && roots.folders.length > 0)
  const target = session.roots[0].path
  const browse = json(await request(`/reel/api/browse?path=${encodeURIComponent(target)}`))
  check('浏览返回当前路径', browse.path === target)
  check('浏览只列文件夹', (browse.folders ?? []).every((folder) => !/\.(mp4|mkv|jpg|png|webm)$/i.test(folder.name)))
  check('浏览列出了子目录', (browse.folders ?? []).length > 0, JSON.stringify((browse.folders ?? []).map((folder) => folder.name).slice(0, 5)))
  check('浏览为子目录给出绝对路径', (browse.folders ?? []).every((folder) => folder.path.startsWith(target) || /^[A-Za-z]:\\/.test(folder.path)))
}

// 6. 方法与错误
{
  checkEqual('stream 拒绝 POST', (await request('/reel/stream', { method: 'POST' })).status, 405)
  checkEqual('未知资源 404', (await request('/reel/nope.js')).status, 404)
  checkEqual('未知 key 404', (await request('/reel/stream?k=r0%2Fnope.mp4')).status, 404)
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('真机集成测试全部通过 ✓')
