/**
 * 面包屑取证脚本（临时工具，不是测试）。
 *
 * 用法：node tools/crumb-shot.mjs <origin> <outDir>
 *
 * 打开一个真实实例，在若干层级的目录上截图，并把 #crumbs 的结构打出来，
 * 用来判断「现在的面包屑到底长什么样、别扭在哪」。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const outDir = process.argv[3] ?? join(tmpdir(), 'crumb-shots')
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const userDataDir = mkdtempSync(join(tmpdir(), 'crumb-ui-'))
const port = 9361
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--window-size=1440,900', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
)
for (let i = 0; i < 80; i += 1) {
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await ev(expression)) === true) return true
    await sleep(200)
  }
  return false
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })

/** 打开一个 key，等卡片出来，截图并回报面包屑结构。 */
const shot = async (label, key) => {
  await send('Page.navigate', { url: `${origin}/reel?k=${encodeURIComponent(key)}` })
  await waitFor('document.readyState === "complete" && document.getElementById("crumbs") !== null')
  await waitFor('document.querySelectorAll(".card").length > 0 || document.querySelectorAll(".crumb").length > 0', 15000)
  await sleep(1200)
  const info = await ev(`(() => {
    const crumbs = document.getElementById('crumbs')
    const nodes = [...crumbs.children].map((n) => {
      const r = n.getBoundingClientRect()
      return {
        cls: n.className,
        text: n.textContent,
        w: Math.round(r.width),
        left: Math.round(r.left),
        top: Math.round(r.top),
        h: Math.round(r.height),
      }
    })
    const box = crumbs.getBoundingClientRect()
    const bar = document.getElementById('toolbarSticky').getBoundingClientRect()
    const side = document.querySelector('.toolbar-side').getBoundingClientRect()
    return {
      key: new URLSearchParams(location.search).get('k'),
      crumbsBox: { w: Math.round(box.width), h: Math.round(box.height), left: Math.round(box.left), top: Math.round(box.top) },
      toolbarBox: { h: Math.round(bar.height), top: Math.round(bar.top) },
      sideTop: Math.round(side.top),
      nodes,
    }
  })()`)
  const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(outDir, `${label}.png`)
  writeFileSync(file, Buffer.from(png.data, 'base64'))
  console.log(`\n=== ${label} (k=${info.key}) ===`)
  console.log(`crumbs 行: ${JSON.stringify(info.crumbsBox)}  工具条高 ${info.toolbarBox.h}  sideTop ${info.sideTop}`)
  for (const n of info.nodes) console.log(`  [${n.cls}] "${n.text}" w=${n.w} left=${n.left} top=${n.top} h=${n.h}`)
  console.log(`  截图 → ${file}`)
  return info
}

await shot('01-root', 'r0')
await shot('02-level1', 'r0/Telegram Desktop')
await shot('03-level2', 'r0/auto_rig_pro-master')
// 找出一个至少三层的真实路径
const deep = await (async () => {
  const walk = async (key, depth) => {
    if (depth === 0) return key
    const r = await (await fetch(`${origin}/reel/api/list?k=${encodeURIComponent(key)}`)).json()
    const folder = (r.folders ?? []).find((f) => (f.mediaCount ?? 0) > 0) ?? (r.folders ?? [])[0]
    if (folder === undefined) return key
    return walk(folder.key, depth - 1)
  }
  return walk('r0', 3)
})()
console.log(`\n深层路径：${deep}`)
await shot('04-deep', deep)
// 分组视图下的面包屑
await ev(`document.querySelector('[data-group-btn="folder"]')?.click()`)
await sleep(1200)
const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(join(outDir, '05-grouped.png'), Buffer.from(png.data, 'base64'))
console.log(`\n分组视图截图 → ${join(outDir, '05-grouped.png')}`)

// 打开一个祖先层菜单，看看菜单里有什么
await ev(`document.querySelector('#crumbs .crumb')?.click()`)
await sleep(900)
const menu = await ev(`(() => {
  const m = document.querySelector('.crumb-menu')
  if (m === null) return { open: false }
  return { open: true, text: m.textContent, rows: [...m.querySelectorAll('.crumb-menu-item')].map((n) => n.textContent.trim()).slice(0, 12) }
})()`)
console.log(`\n祖先层菜单: ${JSON.stringify(menu)}`)
const png2 = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
writeFileSync(join(outDir, '06-menu.png'), Buffer.from(png2.data, 'base64'))
console.log(`菜单截图 → ${join(outDir, '06-menu.png')}`)
console.log(`\n页面异常：${errors.length === 0 ? '无' : errors.join(' | ')}`)
chrome.kill()
process.exit(0)
