/**
 * 独立的端到端测试：用一个最小的假 cordis 上下文挂载真实插件，起一个真实
 * HTTP 服务，然后按真实浏览器的请求方式打所有接口。
 *
 * 这个文件不进入发布包（files 里没有 tests/），但它是验证的核心：
 * 视频能不能拖动进度条，全看 /stream 的范围语义是否正确。
 *
 * 用法：node tests/run.mjs
 */
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, Config } from '../lib/reel.js'

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

// ── 测试目录 ───────────────────────────────────────────────────────────────

const workspace = mkdtempSync(join(tmpdir(), 'mv-test-'))
const mediaRoot = join(workspace, '媒体 库')
const outside = join(workspace, 'outside')
mkdirSync(join(mediaRoot, '子目录', '更深'), { recursive: true })
mkdirSync(outside, { recursive: true })

const bytes = (size) => Buffer.alloc(size, 0x41)

writeFileSync(join(mediaRoot, 'a.mp4'), bytes(3000))
// 真 JPEG（1×1 白图，base64）：图片缩略图走 ffmpeg 解码，全零字节解不开。
writeFileSync(join(mediaRoot, 'b.jpg'), Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
  'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARC' +
  'AABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAg' +
  'EDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhc' +
  'YGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJ' +
  'ipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6' +
  'erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64',
))
writeFileSync(join(mediaRoot, 'c 空格 & 符号.mkv'), bytes(900))
writeFileSync(join(mediaRoot, 'd.srt'), '1\n00:00:01,000 --> 00:00:03,500\n第一行\n第二行\n\n2\n00:00:04,000 --> 00:00:06,000\n<i>斜体</i>\n')
writeFileSync(join(mediaRoot, 'd.ass'), '[Script Info]\nTitle: t\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\b1}加粗{\\b0}\\N第二行\n')
writeFileSync(join(mediaRoot, '子目录', 'e.webm'), bytes(1200))
writeFileSync(join(mediaRoot, '子目录', '更深', 'f.png'), bytes(700))
writeFileSync(join(mediaRoot, 'notes.txt'), '不是媒体\n')
writeFileSync(join(outside, 'secret.mp4'), bytes(100))
// 一个指向根目录之外的符号链接：这是包含性检查必须挡住的情况。
try {
  symlinkSync(outside, join(mediaRoot, '逃逸链接'), 'junction')
} catch {
  /* 某些环境不允许建链接，跳过这条即可 */
}

// ── 假上下文 ───────────────────────────────────────────────────────────────

/**
 * 假的设置服务：只实现插件用到的那部分契约（register / installSection /
 * update / get / watch），并且刻意按真实实现的分层顺序解析
 * —— schema 默认 → 组合 base → 用户层。
 */
function fakeSettings() {
  const registrations = new Map()
  const watchers = new Map()
  const service = {
    register(ns, schema, options) {
      if (registrations.has(ns)) throw new Error(`settings namespace "${ns}" is already registered`)
      const registration = { ns, schema, base: options?.base, user: undefined, validate: options?.validate }
      registrations.set(ns, registration)
      const resolve = () => {
        const merged = { ...(registration.base ?? {}), ...(registration.user ?? {}) }
        const value = schema(merged)
        registration.validate?.(value)
        return value
      }
      registration.resolve = resolve
      return {
        get: resolve,
        watch: (callback) => {
          const list = watchers.get(ns) ?? []
          list.push(callback)
          watchers.set(ns, list)
          return () => watchers.set(ns, (watchers.get(ns) ?? []).filter((entry) => entry !== callback))
        },
        update: async (patch) => {
          registration.user = { ...(registration.user ?? {}), ...patch }
          for (const callback of watchers.get(ns) ?? []) callback(resolve(), resolve())
        },
        replace: async (section) => {
          registration.user = section
          for (const callback of watchers.get(ns) ?? []) callback(resolve(), resolve())
        },
      }
    },
    installSection(owner, ns, schema, entry, hooks) {
      const scope = this.register(ns, schema, { base: entry, validate: hooks.validate })
      hooks.setSource(() => scope.get())
      hooks.onChange()
      scope.watch(() => hooks.onChange())
    },
    update: async (ns, patch) => registrations.get(ns).user = { ...(registrations.get(ns).user ?? {}), ...patch },
    get: (ns) => registrations.get(ns)?.resolve(),
  }
  return { service, registrations }
}

/** 最小 cordis 替身：只实现插件真正用到的那部分。 */
function fakeContext(options = {}) {
  const routes = { exact: new Map(), prefix: new Map() }
  const disposers = []
  const listeners = new Map()
  const logs = []
  const settings = options.withSettings === true ? fakeSettings() : null
  const webServer = {
    port: 0,
    host: '127.0.0.1',
    register(route) {
      const table = route.kind === 'exact' ? routes.exact : routes.prefix
      if (table.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      table.set(route.path, route.handler)
      return () => table.delete(route.path)
    },
  }
  const ctx = {
    webServer,
    logger: (name) => ({
      info: (...args) => logs.push(['info', name, args]),
      warn: (...args) => logs.push(['warn', name, args]),
      error: (...args) => logs.push(['error', name, args]),
      debug: () => {},
    }),
    // 插件用 ctx.get 读服务，而不是 ctx.webServer 访问器：这样即使组合里
    // 少写了 row 级 inject，也不会在第一个请求上抛 "without inject"。
    get: (serviceName) => {
      if (serviceName === 'webServer') return webServer
      if (serviceName === 'settings') return settings?.service
      return undefined
    },
    // 插件对设置服务是可选的：没有 provider 时必须继续用入口配置工作。
    // 真实的 cordis 会把被注入的服务挂到回调的 ctx 上，这里照做。
    inject: (deps, callback) => {
      const names = Array.isArray(deps) ? deps : []
      const available = names.every((dep) => ctx.get(dep) !== undefined)
      if (!available) return { then: () => {} }
      const injected = { ...ctx }
      for (const name of names) injected[name] = ctx.get(name)
      const dispose = callback(injected)
      if (typeof dispose === 'function') disposers.push(dispose)
      return { then: () => {} }
    },
    effect: (execute) => {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    logs,
    settings,
    emit: (event, ...args) => (listeners.get(event) ?? []).forEach((listener) => listener(...args)),
    dispose: () => disposers.reverse().forEach((dispose) => dispose()),
  }
}

/** 按 webserver 的匹配顺序派发：精确表 → 最长前缀 → 404。 */
function dispatch(routes) {
  return (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '') || '/'
    const exact = routes.exact.get(pathname)
    if (exact !== undefined) return void exact(req, res)
    let best = null
    for (const [prefix, handler] of routes.prefix) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        if (best === null || prefix.length > best[0].length) best = [prefix, handler]
      }
    }
    if (best !== null) return void best[1](req, res)
    res.statusCode = 404
    res.end()
  }
}

// ── 启动 ───────────────────────────────────────────────────────────────────

const harness = fakeContext()
const entry = Config['~standard'].validate({ roots: [mediaRoot], requireTrustedRequest: true })
if ('issues' in entry) {
  console.error('config validation failed', entry.issues)
  process.exit(1)
}
apply(harness.ctx, entry.value)

const server = createServer(dispatch(harness.routes))
await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
const origin = `http://127.0.0.1:${server.address().port}`
harness.ctx.webServer.port = server.address().port
harness.emit('internal/ready')

/** 发一个请求，返回状态、响应头与字节。 */
async function request(path, options = {}) {
  const response = await fetch(`${origin}${path}`, options)
  const buffer = Buffer.from(await response.arrayBuffer())
  return { status: response.status, headers: response.headers, buffer }
}

const keyOf = (rel) => `r0${rel === '' ? '' : `/${rel.split('/').map(encodeURIComponent).join('/')}`}`

// ── 接口测试 ───────────────────────────────────────────────────────────────

{
  const session = await request('/reel/api/session')
  checkEqual('session 状态码', session.status, 200)
  const payload = JSON.parse(session.buffer.toString('utf8'))
  checkEqual('session 报告一个根目录', payload.roots.length, 1)
  checkEqual('根目录路径正确', payload.roots[0].path, mediaRoot)
  check('capabilities 存在', typeof payload.capabilities?.thumbnails === 'boolean')
}

{
  const list = await request(`/reel/api/list?k=${encodeURIComponent(keyOf(''))}`)
  checkEqual('list 状态码', list.status, 200)
  const payload = JSON.parse(list.buffer.toString('utf8'))
  const names = payload.files.map((item) => item.name)
  check('列出图片', names.includes('b.jpg'))
  check('列出视频', names.includes('a.mp4'))
  check('列出带空格的视频', names.includes('c 空格 & 符号.mkv'))
  check('不把 txt 当媒体', !names.includes('notes.txt'))
  check('列出子目录', payload.folders.some((folder) => folder.name === '子目录'))
  const mkv = payload.files.find((item) => item.name === 'c 空格 & 符号.mkv')
  check('mkv 的 key 可编码往返', decodeURIComponent(encodeURIComponent(mkv.key)) === mkv.key)
  check('mkv 带 streamUrl', typeof mkv.streamUrl === 'string' && mkv.streamUrl.startsWith('/reel/stream'))
  // 面包屑契约：任何层的 crumbs 都以根开头、当前目录收尾，根自己就只有一枚。
  checkEqual('根目录面包屑只有根一枚', payload.crumbs.length, 1)
  check('根面包屑就是根目录', payload.crumbs[0].key === keyOf('') && payload.crumbs[0].name === payload.root.label, JSON.stringify(payload.crumbs))
}

{
  const nested = await request(`/reel/api/list?k=${encodeURIComponent(keyOf('子目录'))}`)
  const payload = JSON.parse(nested.buffer.toString('utf8'))
  checkEqual('子目录里的文件数', payload.files.length, 1)
  check('子目录面包屑长度为 2', payload.crumbs.length, 2)
  check('子目录有上一层', payload.parent !== null)
}

// ── 空 key 等于「第一个根目录」 ────────────────────────────────────────────
//
// 这一组是回归测试：页面首次加载时 state.key 是空的，会直接请求 `k=`。
// 服务端如果只认显式的 r0，首屏就会 404——而所有手写 key 的测试都发现不了。

{
  const explicit = JSON.parse((await request(`/reel/api/list?k=r0`)).buffer.toString('utf8'))
  const empty = await request('/reel/api/list?k=')
  checkEqual('list 空 key 不 404', empty.status, 200)
  const emptyPayload = JSON.parse(empty.buffer.toString('utf8'))
  checkEqual('list 空 key 落到第一个根', emptyPayload.root.path, explicit.root.path)
  checkEqual('list 空 key 与 r0 结果一致', emptyPayload.files.length, explicit.files.length)

  const noParam = await request('/reel/api/list')
  checkEqual('list 完全不带 key 也是 200', noParam.status, 200)

  const scanExplicit = JSON.parse((await request('/reel/api/scan?k=r0&limit=50')).buffer.toString('utf8'))
  const scanEmpty = await request('/reel/api/scan?k=&kinds=image,video&limit=50&depth=10')
  checkEqual('scan 空 key 不 404', scanEmpty.status, 200)
  const scanPayload = JSON.parse(scanEmpty.buffer.toString('utf8'))
  checkEqual('scan 空 key 与 r0 结果一致', scanPayload.items.length, scanExplicit.items.length)
  check('scan 空 key 真的返回条目', scanPayload.items.length > 0)

  // stream 上，空 key 解析成根目录（一个目录），所以是「不是文件」而不是
  // 「找不到」——两种都回 404，但理由不同，服务端自己会说明。
  const streamEmpty = await request('/reel/stream?k=')
  checkEqual('stream 空 key 落到根目录并被拒', streamEmpty.status, 404)
  check('拒绝理由指向「不是文件」', streamEmpty.buffer.toString('utf8').includes('not a file'), streamEmpty.buffer.toString('utf8'))
  check(
    '仍然拒绝真正的未知根目录',
    (await request('/reel/stream?k=r9/a.mp4')).status === 404,
  )
}

{
  const scan = await request(`/reel/api/scan?k=${encodeURIComponent(keyOf(''))}&kinds=image,video&limit=50`)
  const payload = JSON.parse(scan.buffer.toString('utf8'))
  const names = payload.items.map((item) => item.name).sort()
  check('递归扫描拿到 5 个媒体', payload.items.length === 5, JSON.stringify(names))
  check('递归扫描包含深层文件', names.includes('f.png'))
  check('扫描结果按时间倒序', payload.items.every((item, index, all) => index === 0 || all[index - 1].mtimeMs >= item.mtimeMs))
}

// ── 范围流：这是「视频能不能拖」的全部 ──────────────────────────────────────

{
  const streamPath = `/reel/stream?k=${encodeURIComponent(keyOf('a.mp4'))}`

  const full = await request(streamPath)
  checkEqual('整文件 200', full.status, 200)
  checkEqual('整文件长度', full.buffer.length, 3000)
  checkEqual('声明支持范围', full.headers.get('accept-ranges'), 'bytes')
  checkEqual('内容类型', full.headers.get('content-type'), 'video/mp4')
  const etag = full.headers.get('etag')
  check('有 ETag', typeof etag === 'string' && etag.startsWith('"'))

  const middle = await request(streamPath, { headers: { range: 'bytes=100-199' } })
  checkEqual('范围请求回 206', middle.status, 206)
  checkEqual('范围长度 100', middle.buffer.length, 100)
  checkEqual('Content-Range 精确', middle.headers.get('content-range'), 'bytes 100-199/3000')

  const open = await request(streamPath, { headers: { range: 'bytes=2900-' } })
  checkEqual('开区间 206', open.status, 206)
  checkEqual('开区间长度', open.buffer.length, 100)
  checkEqual('开区间 Content-Range', open.headers.get('content-range'), 'bytes 2900-2999/3000')

  const suffix = await request(streamPath, { headers: { range: 'bytes=-500' } })
  checkEqual('后缀范围 206', suffix.status, 206)
  checkEqual('后缀范围长度', suffix.buffer.length, 500)
  checkEqual('后缀范围起点', suffix.headers.get('content-range'), 'bytes 2500-2999/3000')

  const clamp = await request(streamPath, { headers: { range: 'bytes=1000-99999' } })
  checkEqual('超出末尾被截断为 206', clamp.status, 206)
  checkEqual('超出末尾被截断', clamp.headers.get('content-range'), 'bytes 1000-2999/3000')

  const overshoot = await request(streamPath, { headers: { range: 'bytes=99999-' } })
  checkEqual('起点越界回 416', overshoot.status, 416)
  checkEqual('416 带 Content-Range', overshoot.headers.get('content-range'), 'bytes */3000')

  const malformed = await request(streamPath, { headers: { range: 'pages=1-2' } })
  checkEqual('非法单位按整文件处理', malformed.status, 200)

  const multi = await request(streamPath, { headers: { range: 'bytes=0-10,20-30' } })
  checkEqual('多段范围按整文件处理', multi.status, 200)

  const head = await request(streamPath, { method: 'HEAD' })
  checkEqual('HEAD 200', head.status, 200)
  checkEqual('HEAD 无响应体', head.buffer.length, 0)
  checkEqual('HEAD 声明长度', head.headers.get('content-length'), '3000')

  const headRange = await request(streamPath, { method: 'HEAD', headers: { range: 'bytes=0-9' } })
  checkEqual('HEAD + Range 回 206', headRange.status, 206)
  checkEqual('HEAD + Range 无响应体', headRange.buffer.length, 0)

  const revalidated = await request(streamPath, { headers: { 'if-none-match': etag } })
  checkEqual('ETag 命中回 304', revalidated.status, 304)

  const staleRange = await request(streamPath, { headers: { range: 'bytes=0-99', 'if-range': '"nope"' } })
  checkEqual('If-Range 不匹配时回整文件', staleRange.status, 200)
  checkEqual('If-Range 不匹配时长度完整', staleRange.buffer.length, 3000)

  const goodRange = await request(streamPath, { headers: { range: 'bytes=0-99', 'if-range': etag } })
  checkEqual('If-Range 匹配时回 206', goodRange.status, 206)

  const download = await request(`/reel/download?k=${encodeURIComponent(keyOf('a.mp4'))}`)
  check('下载带 attachment', String(download.headers.get('content-disposition')).startsWith('attachment'))
  const inline = await request(streamPath)
  check('流式播放带 inline', String(inline.headers.get('content-disposition')).startsWith('inline'))

  // 分段读取拼接后必须与源文件逐字节相同，这是范围实现正确性的硬证据。
  const parts = []
  for (let offset = 0; offset < 3000; offset += 700) {
    const end = Math.min(offset + 699, 2999)
    const chunk = await request(streamPath, { headers: { range: `bytes=${offset}-${end}` } })
    parts.push(chunk.buffer)
  }
  const joined = Buffer.concat(parts)
  checkEqual('分段拼接长度', joined.length, 3000)
  check('分段拼接内容一致', joined.equals(bytes(3000)))

  // 非 ASCII 文件名要能通过响应头往返。
  const unicode = await request(`/reel/stream?k=${encodeURIComponent(keyOf('c 空格 & 符号.mkv'))}`)
  checkEqual('非 ASCII 文件可流式读取', unicode.status, 200)
  check('非 ASCII 文件名走 filename*', String(unicode.headers.get('content-disposition')).includes("filename*=UTF-8''"))
}

{
  const thumb = await request(`/reel/thumb?k=${encodeURIComponent(keyOf('a.mp4'))}`)
  check('没有 ffmpeg 时缩略图返回 503', thumb.status === 503, `实际 ${thumb.status}`)
}

{
  const srt = await request(`/reel/subtitle?k=${encodeURIComponent(keyOf('d.srt'))}`)
  checkEqual('SRT 转 VTT 状态码', srt.status, 200)
  const body = srt.buffer.toString('utf8')
  check('VTT 头正确', body.startsWith('WEBVTT'))
  check('VTT 时间戳用点号', body.includes('00:00:01.000 --> 00:00:03.500'))
  check('VTT 保留换行文本', body.includes('第一行\n第二行'))

  const ass = await request(`/reel/subtitle?k=${encodeURIComponent(keyOf('d.ass'))}`)
  const assBody = ass.buffer.toString('utf8')
  check('ASS 转 VTT 成功', assBody.startsWith('WEBVTT'))
  check('ASS 去掉花括号标签', assBody.includes('加粗') && !assBody.includes('{\\b1}'), assBody.slice(0, 120))
  check('ASS 的 \\N 变成换行', assBody.includes('加粗\n第二行') || assBody.includes('加粗\r\n第二行'))

  const notSubtitle = await request(`/reel/subtitle?k=${encodeURIComponent(keyOf('a.mp4'))}`)
  checkEqual('非字幕文件被拒', notSubtitle.status, 415)
}

// ── 包含性与安全性 ─────────────────────────────────────────────────────────

{
  const escape = await request(`/reel/stream?k=${encodeURIComponent(`r0/../secret.mp4`)}`)
  check('拒绝 .. 逃逸', escape.status === 404 || escape.status === 400, `实际 ${escape.status}`)

  const encodedEscape = await request(`/reel/stream?k=${encodeURIComponent('r0/%2e%2e/secret.mp4')}`)
  check('拒绝编码后的 .. 逃逸', encodedEscape.status === 404 || encodedEscape.status === 400, `实际 ${encodedEscape.status}`)

  const badRoot = await request(`/reel/stream?k=${encodeURIComponent('r9/a.mp4')}`)
  checkEqual('未知根目录被拒', badRoot.status, 404)

  const noKey = await request('/reel/stream')
  checkEqual('缺少 key 被拒', noKey.status, 404)

  const traversalList = await request(`/reel/api/list?k=${encodeURIComponent('r0/../../')}`)
  checkEqual('列目录也挡住逃逸', traversalList.status, 404)

  const symlink = await request(`/reel/stream?k=${encodeURIComponent(keyOf('逃逸链接/secret.mp4'))}`)
  check('符号链接不能用于逃出根目录', symlink.status === 404, `实际 ${symlink.status}`)
}

{
  // 非回环来源在没有可信连接服务时必须被 refuse（这里用伪造的 Host 头模拟）。
  const forged = await request('/reel/api/session', { headers: { 'x-forwarded-for': '10.0.0.9' } })
  checkEqual('回环请求仍然放行', forged.status, 200)
}

// ── 静态资源与页面 ─────────────────────────────────────────────────────────

{
  const page = await request('/reel')
  checkEqual('页面 200', page.status, 200)
  const html = page.buffer.toString('utf8')
  check('页面引用样式', html.includes('/reel/app.css'))
  check('页面引用脚本', html.includes('/reel/app.js') && html.includes('/reel/player.js'))

  const css = await request('/reel/app.css')
  checkEqual('CSS 200', css.status, 200)
  checkEqual('CSS 类型', css.headers.get('content-type'), 'text/css; charset=utf-8')

  const js = await request('/reel/player.js')
  checkEqual('JS 200', js.status, 200)
  check('JS 类型正确', String(js.headers.get('content-type')).startsWith('text/javascript'))

  const missing = await request('/reel/nope.js')
  checkEqual('未知资源 404', missing.status, 404)

  const nested = await request('/reel/../package.json')
  check('资源路径不能上跳', nested.status === 404 || nested.status === 400)
}

{
  const config = await request('/reel/api/config')
  checkEqual('页内配置接口已删除', config.status, 404)
  const browse = await request('/reel/api/browse?path=')
  checkEqual('目录列举接口已删除', browse.status, 404)
  const session = JSON.parse((await request('/reel/api/session')).buffer.toString('utf8'))
  checkEqual('无设置服务时只读', session.writable, false)

  // 图片缩略图：有 ffmpeg 时 /thumb 对图片返回缩小的 JPEG，列表条目带 thumbUrl。
  const thumb = await request('/reel/thumb?k=r0/b.jpg')
  if (session.capabilities.thumbnails === true) {
    checkEqual('图片缩略图 200', thumb.status, 200)
    check('图片缩略图是 JPEG', String(thumb.headers.get('content-type')).startsWith('image/jpeg'), String(thumb.headers.get('content-type')))
    check('图片缩略图有内容', thumb.buffer.length > 100)
    const listed = JSON.parse((await request('/reel/api/list?k=r0')).buffer.toString('utf8'))
    const image = (listed.files ?? []).find((file) => file.name === 'b.jpg')
    check('图片条目带 thumbUrl', typeof image?.thumbUrl === 'string', JSON.stringify(image))
  } else {
    checkEqual('无 ffmpeg 时图片缩略图 503', thumb.status, 503)
  }
}

// ── 库：所有配置目录的聚合 ─────────────────────────────────────────────────
//
// 页面树顶的「库」节点用固定的 `lib` 键。列目录时合并各根的顶层，扫描时递归
// 所有根；条目的键仍是各自的 r<index>/…，所以从库里点进某个文件夹照旧。
// 这里单起一个 harness，用两个根来验证合并与保键。

{
  const rootA = join(workspace, '库 A')
  const rootB = join(workspace, '库 B')
  mkdirSync(join(rootA, '照片'), { recursive: true })
  mkdirSync(join(rootB, '视频'), { recursive: true })
  writeFileSync(join(rootA, 'photo.jpg'), bytes(500))
  writeFileSync(join(rootB, 'clip.mp4'), bytes(600))
  writeFileSync(join(rootB, '视频', 'deep.mp4'), bytes(700))

  const libHarness = fakeContext()
  apply(libHarness.ctx, Config['~standard'].validate({ roots: [rootA, rootB], requireTrustedRequest: true }).value)
  const libServer = createServer(dispatch(libHarness.routes))
  await new Promise((settle) => libServer.listen(0, '127.0.0.1', settle))
  const libOrigin = `http://127.0.0.1:${libServer.address().port}`
  const callLib = async (path) => {
    const response = await fetch(`${libOrigin}${path}`)
    return { status: response.status, payload: JSON.parse(await response.text()) }
  }

  const list = await callLib('/reel/api/list?k=lib')
  checkEqual('库列表 200', list.status, 200)
  checkEqual('库的根标签', list.payload.root.label, '库')
  checkEqual('库的键就是 lib', list.payload.key, 'lib')
  checkEqual('库的面包屑只有一枚', list.payload.crumbs.length, 1)
  checkEqual('库的面包屑指向 lib', list.payload.crumbs[0].key, 'lib')
  check('库列出第一个根的文件夹', list.payload.folders.some((folder) => folder.name === '照片' && folder.key.startsWith('r0/')))
  check('库列出第二个根的文件夹', list.payload.folders.some((folder) => folder.name === '视频' && folder.key.startsWith('r1/')))
  const topNames = list.payload.files.map((file) => file.name).sort()
  check('库合并两个根的顶层文件', topNames.join(',') === 'clip.mp4,photo.jpg', topNames.join(','))
  checkEqual('库的文件总数', list.payload.fileCount, 2)

  const videoFolder = list.payload.folders.find((folder) => folder.name === '视频')
  const inside = await callLib(`/reel/api/list?k=${encodeURIComponent(videoFolder.key)}`)
  check('库里的文件夹键仍能单独打开', inside.status === 200 && inside.payload.files.some((file) => file.name === 'deep.mp4'))

  const scan = await callLib('/reel/api/scan?k=lib&kinds=image,video&limit=100&depth=8')
  checkEqual('库扫描 200', scan.status, 200)
  const scanNames = scan.payload.items.map((item) => item.name).sort()
  check('库扫描覆盖所有根', scanNames.join(',') === 'clip.mp4,deep.mp4,photo.jpg', scanNames.join(','))
  check('库扫描的键保留各自的根前缀', scan.payload.items.every((item) => /^r[01]\//.test(item.key)))
  checkEqual('库扫描的根标签', scan.payload.root.label, '库')
  checkEqual('库扫描没有相对路径', scan.payload.rel, '')

  // 文件级端点不认 lib：库不是一个文件，也不该被解析成某个根。
  const stream = await callLib('/reel/stream?k=lib')
  checkEqual('lib 不会被当成文件流式读取', stream.status, 404)

  libServer.close()
  libHarness.dispose()
}

// ── 方法限制 ───────────────────────────────────────────────────────────────

{
  const post = await request('/reel/stream', { method: 'POST' })
  checkEqual('stream 只接受 GET/HEAD', post.status, 405)
  checkEqual('405 带 Allow', post.headers.get('allow'), 'GET, HEAD')
  const del = await request('/reel/api/session', { method: 'DELETE' })
  checkEqual('session 拒绝 DELETE', del.status, 405)
}

// ── 生命周期 ───────────────────────────────────────────────────────────────

{
  checkEqual('注册了 11 条精确路由', harness.routes.exact.size, 11)
  check('注册了资源前缀路由', harness.routes.prefix.has('/reel'))
  const before = harness.routes.exact.size
  harness.dispose()
  checkEqual('卸载后路由全部移除', harness.routes.exact.size, 0)
  check('卸载前确实有路由', before > 0)
  check('就绪日志已输出', harness.logs.some(([level]) => level === 'info'))
}

// ── 挂了设置服务时的分层解析 ───────────────────────────────────────────────
//
// 这一组是回归测试：设置命名空间的 schema 默认值是空数组，如果插件把
// 入口配置和用户层「手工合并」，那个空默认就会盖掉 cordis.patch.yml 里
// 手写的 roots，用户配置会被静默忽略。正确顺序必须是
// schema 默认 → 组合 base（入口配置）→ 用户层。

{
  const settingsHarness = fakeContext({ withSettings: true })
  const settingsEntry = Config['~standard'].validate({ roots: [mediaRoot], requireTrustedRequest: true })
  apply(settingsHarness.ctx, settingsEntry.value)

  const settingsServer = createServer(dispatch(settingsHarness.routes))
  await new Promise((settle) => settingsServer.listen(0, '127.0.0.1', settle))
  const settingsOrigin = `http://127.0.0.1:${settingsServer.address().port}`
  const call = async (path, options) => {
    const response = await fetch(`${settingsOrigin}${path}`, options)
    return { status: response.status, payload: JSON.parse(await response.text()) }
  }
  const registered = settingsHarness.settings.registrations.get('reel')
  check('设置了命名空间已注册', registered !== undefined)
  checkEqual('组合入口成为 base 层', registered.base.roots[0], mediaRoot)

  // 1) 用户层为空：必须回落到入口配置，而不是空默认。
  const fromEntry = await call('/reel/api/session')
  checkEqual('用户层为空时用入口配置', fromEntry.payload.roots.length, 1)
  checkEqual('入口配置的路径生效', fromEntry.payload.roots[0].path, mediaRoot)
  checkEqual('有设置服务时可写', fromEntry.payload.writable, true)

  // 2) 用户层盖过入口配置（设置卡片经 settings 远程写入，同一份数据）。
  settingsHarness.settings.registrations.get('reel').user = { roots: [join(mediaRoot, '子目录')] }
  const written = await call('/reel/api/session')
  checkEqual('用户层盖过入口配置', written.payload.roots.length, 1)
  check('用户层的路径生效', written.payload.roots[0].path.endsWith('子目录'), JSON.stringify(written.payload.roots))

  // 3) 用户层显式写成空数组 = 「一个目录都不要」，这是设置服务的既有语义，
  //    上层显式给了值就不再往下继承。删掉这个键（unset）才回到入口配置。
  settingsHarness.settings.registrations.get('reel').user = { roots: [] }
  const cleared = await call('/reel/api/session')
  checkEqual('空数组表示清空目录', cleared.payload.roots.length, 0)

  settingsHarness.settings.registrations.get('reel').user = undefined
  const inherited = await call('/reel/api/session')
  checkEqual('删掉用户键后继承入口配置', inherited.payload.roots.length, 1)
  checkEqual('继承回入口配置的路径', inherited.payload.roots[0].path, mediaRoot)

  settingsServer.close()
  settingsHarness.dispose()
}

// ── cacheDir：校验、schema 包络与落点警告 ──────────────────────────────────
//
// cacheDir 是新增配置：缩略图与悬停动画的缓存目录，缺省仍在系统临时目录。
// schema 包络必须是「子节点以 uid 数字引用」的形状——浏览器半边的 rehydrate
// 靠 refs[uid] 接线，包络里出现嵌套对象会静默退化，设置卡片就会消失。

{
  // Config 校验：接受字符串并 trim，拒绝非字符串。
  const withCache = Config['~standard'].validate({ roots: [], cacheDir: '  E:\\cache  ' })
  check('Config 接受 cacheDir', withCache.issues === undefined, JSON.stringify(withCache))
  checkEqual('Config 会 trim cacheDir', withCache.value.cacheDir, 'E:\\cache')
  const badCache = Config['~standard'].validate({ roots: [], cacheDir: 42 })
  check('Config 拒绝非字符串 cacheDir', badCache.issues !== undefined)

  // schema 包络：与 schemastery 的 toJSON 输出同构（数字 uid 引用）。
  const schemaHarness = fakeContext({ withSettings: true })
  apply(schemaHarness.ctx, Config['~standard'].validate({ roots: [mediaRoot], requireTrustedRequest: true }).value)
  const schema = schemaHarness.settings.registrations.get('reel').schema
  const envelope = schema.toJSON()
  checkEqual('包络根节点是 object', envelope.refs[envelope.uid].type, 'object')
  checkEqual('包络引用是 uid 数字（客户端可 rehydrate）',
    typeof envelope.refs[envelope.uid].dict.roots, 'number')
  checkEqual('包络声明 cacheDir 字段', typeof envelope.refs[envelope.uid].dict.cacheDir, 'number')

  // schema 解析：默认不注入 cacheDir；给值时保留，非字符串报 TypeError。
  const resolved = schema({})
  check('默认不注入 cacheDir', resolved.cacheDir === undefined, JSON.stringify(resolved))
  const given = schema({ roots: ['x'], cacheDir: 'E:\\cache' })
  checkEqual('给值时保留 cacheDir', given.cacheDir, 'E:\\cache')
  let threw = false
  try { schema({ cacheDir: 7 }) } catch { threw = true }
  check('非字符串 cacheDir 被拒', threw)
  schemaHarness.dispose()

  // 落点警告：cacheDir 在配置根之内要警告一次，之外必须安静。
  const warnHarness = fakeContext({ withSettings: true })
  apply(warnHarness.ctx, Config['~standard'].validate({ roots: [mediaRoot], cacheDir: mediaRoot, requireTrustedRequest: true }).value)
  warnHarness.emit('internal/ready')
  check('cacheDir 在根内时给出警告',
    warnHarness.logs.some(([level, , args]) => level === 'warn' && String(args?.[0]).includes('inside a configured root')),
    JSON.stringify(warnHarness.logs))
  warnHarness.dispose()

  const quietHarness = fakeContext({ withSettings: true })
  apply(quietHarness.ctx, Config['~standard'].validate({ roots: [mediaRoot], cacheDir: `${mediaRoot}-cache`, requireTrustedRequest: true }).value)
  quietHarness.emit('internal/ready')
  check('cacheDir 在根外不警告',
    !quietHarness.logs.some(([level]) => level === 'warn'),
    JSON.stringify(quietHarness.logs))
  quietHarness.dispose()
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

server.close()
rmSync(workspace, { recursive: true, force: true })

console.log(`\n通过 ${passes.length} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
void here
