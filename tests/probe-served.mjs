/**
 * 决定性实验：把目标实例正在服务的 index.html / app.css / app.js 原样抓下来，
 * 用本地静态服务器重新供一遍，再用浏览器量侧栏。
 *
 * 目的：把「资源本身有问题」和「那个实例的运行时有别的东西」分开。如果抓下来
 * 的资源在浏览器里侧栏正常，问题就在对方的运行时；如果也不正常，问题就在资源。
 *
 * 用法：node tests/probe-served.mjs <origin>
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 原样抓取三个资源 ──────────────────────────────────────────────────
const grabbed = {}
for (const name of ['index.html', 'app.css', 'app.js']) {
  const path = name === 'index.html' ? '/reel' : `/reel/${name}`
  const response = await fetch(`${origin}${path}`)
  grabbed[name] = { status: response.status, type: response.headers.get('content-type'), body: await response.text() }
}
console.log('抓取结果:')
for (const [name, info] of Object.entries(grabbed)) {
  console.log(`  ${name.padEnd(11)} HTTP ${info.status}  ${String(info.type).padEnd(32)} ${info.body.length} 字符`)
}

// 关键标记是否都在
const html = grabbed['index.html'].body
for (const marker of ['id="sidebar"', 'id="sidebarRail"', 'id="browsePane"', 'data-scope-btn', 'id="grid"', 'id="content"']) {
  console.log(`  ${marker.padEnd(18)} ${html.includes(marker) ? '有' : '缺失 ✗'}`)
}

// app.css 本身的内容是否正常（如果它空了，页面就会完全没样式，
// 侧栏会以默认的 display:block 铺满整宽——正是「根本没有侧边栏」的样子）。
const cssBody = grabbed['app.css'].body
console.log(`\napp.css 内容检查:`)
console.log(`  长度            ${cssBody.length} 字符`)
console.log(`  开头 80 字符    ${JSON.stringify(cssBody.slice(0, 80))}`)
console.log(`  含 .browse      ${cssBody.includes('.browse {')}`)
console.log(`  含 sidebar-rail ${cssBody.includes('sidebar-rail')}`)
console.log(`  含 @media       ${cssBody.includes('@media')}`)

// index.html 里是否真的引用了它
const linkMatch = /<link[^>]*app\.css[^>]*>/i.exec(html)
console.log(`\nindex.html 里的样式引用: ${linkMatch === null ? '找不到 ✗' : linkMatch[0]}`)

// ── 2. 用本地静态服务器重新供一遍 ────────────────────────────────────────
const server = createServer((req, res) => {
  const name = req.url === '/' || req.url === '' ? 'index.html' : req.url.replace(/^\//, '')
  const entry = grabbed[name]
  if (entry === undefined) {
    res.statusCode = 404
    res.end('nope')
    return
  }
  const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html'
  res.setHeader('content-type', `${type}; charset=utf-8`)
  res.end(entry.body)
})
await new Promise((settle) => server.listen(0, '127.0.0.1', settle))
const localOrigin = `http://127.0.0.1:${server.address().port}`
console.log(`\n本地重供: ${localOrigin}`)

// ── 3. 浏览器里量侧栏 ────────────────────────────────────────────────────
const userDataDir = mkdtempSync(join(tmpdir(), 'mv-probe-'))
const port = 9345
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank'],
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
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.text ?? 'exception')
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
  if (r.exceptionDetails) return `EX: ${r.exceptionDetails.text}`
  return r.result.value
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1335, height: 739, deviceScaleFactor: 2, mobile: false })
await send('Page.navigate', { url: `${localOrigin}/` })
await sleep(2000)

const probe = await ev(`(() => {
  const bar = document.getElementById('sidebar')
  const rail = document.getElementById('sidebarRail')
  const browse = document.getElementById('browsePane')

  // 把这个页面上所有能匹配到 #sidebar / #browsePane / .sidebar-rail 的规则列出来，
  // 直接看谁把 display 定了。
  const walk = (rules, media, out) => {
    for (const rule of rules) {
      if (rule.cssRules !== undefined) {
        walk([...rule.cssRules], rule.conditionText ?? rule.media?.mediaText ?? media, out)
        continue
      }
      const selector = rule.selectorText
      if (selector === undefined || rule.style === undefined) continue
      for (const [node, label] of [[bar, '#sidebar'], [browse, '#browsePane'], [rail, '#sidebarRail']]) {
        if (node === null) continue
        let hit = false
        try { hit = node.matches(selector) } catch {}
        if (!hit) continue
        const decl = rule.style.cssText
        if (!/display|flex|width|visibility/.test(decl)) continue
        out.push((media === undefined || media === null ? '-' : '@' + media) + '  ' + selector + ' { ' + decl + ' }')
      }
    }
  }
  const out = []
  let sheets = 0
  let rules = 0
  for (const sheet of document.styleSheets) {
    sheets += 1
    try {
      const list = [...sheet.cssRules]
      rules += list.length
      walk(list, null, out)
    } catch (error) {
      out.push('(读不到 ' + (sheet.href ?? 'inline') + ': ' + error.message + ')')
    }
  }

  return {
    sheets,
    rules,
    sidebarExists: bar !== null,
    railExists: rail !== null,
    sidebarDisplay: bar === null ? '(无元素)' : getComputedStyle(bar).display,
    sidebarWidth: bar === null ? -1 : Math.round(bar.getBoundingClientRect().width),
    railDisplay: rail === null ? '(无元素)' : getComputedStyle(rail).display,
    browseDisplay: browse === null ? '(无元素)' : getComputedStyle(browse).display,
    bodyClass: document.body.className || '(空)',
    missingToast: document.getElementById('toasts')?.textContent ?? '',
    mobileQuery: window.matchMedia('(max-width: 720px)').matches,
    innerWidth: window.innerWidth,
    matchedRules: out,
  }
})()`)
console.log('\n本地重供后的侧栏状态:')
console.log(JSON.stringify({ ...probe, matchedRules: undefined }, null, 2))
console.log('\n匹配到的 display/flex/width 规则:')
for (const line of probe.matchedRules ?? []) console.log('  ' + line)
console.log('运行时异常:', errors.length === 0 ? '无' : errors.slice(0, 3).join(' | '))

socket.close()
chrome.kill('SIGKILL')
server.close()
await sleep(400)
try {
  rmSync(userDataDir, { recursive: true, force: true })
} catch {}
