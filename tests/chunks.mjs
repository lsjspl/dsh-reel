/**
 * 平铺网格的分块窗口化验证：滚动全程，视口里不许出现「未挂载块」留下的空白。
 *
 * 为什么要单独一套：分块挂载是异步的（IntersectionObserver 只在**相交状态变化**时
 * 通知）。代码读起来完全对，真实翻车却是「滑着滑着凭空空出一大块，往回滑还是一
 * 片空」——某一块在还看得见的时候被折成占位，它的可见性没变过，观察者不会为
 * 「没变化」再发一次通知，于是它永远等不到重新挂载。只有真的滚一遍才看得见。
 *
 * 清单是合成的（倍数于真实库，末尾一块故意凑不满，和「几百条 + 7 列」的真实
 * 情形同构）：条目本身尽量克隆真实媒体，卡片高度、封面、探测都跟线上一致。
 *
 * 用法：node tests/chunks.mjs <origin> [条数]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const want = Number(process.argv[3] ?? 400)
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const failures = []
let passes = 0

const check = (label, condition, detail) => {
  if (condition) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((settle) => setTimeout(settle, ms))

/**
 * 合成清单：优先克隆真实媒体（缩略图、容器格式、时长都是真的），
 * 库是空的就退回自造条目——几何照样成立，只是封面走兜底图标。
 */
const synth = async () => {
  let seeds = []
  try {
    const response = await fetch(`${origin}/reel/api/scan?k=&kinds=image,video,audio&limit=3000&depth=24`)
    if (response.ok) seeds = (await response.json()).items ?? []
  } catch {
    /* 拿不到就拿不到，下面照造 */
  }
  const items = []
  for (let index = 0; index < want; index += 1) {
    const seed = seeds[index % Math.max(1, seeds.length)]
    const name = `chunk-check-${String(index).padStart(4, '0')}${seed === undefined ? '.mp4' : `-${seed.name}`}`
    items.push(
      seed === undefined
        ? { key: `r0/${name}`, name, rel: name, root: 0, kind: 'video', size: 1024 * 1024, mtimeMs: Date.now() - index * 1000, streamUrl: '', thumbUrl: '' }
        : { ...seed, key: `r${seed.root}/${name}`, name, rel: name },
    )
  }
  return items
}

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-chunks-'))
const port = 9344
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
)

/** 等 DevTools 端点。 */
async function waitForDevTools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口没起来')
}

let socket = null
let created = null

try {
  await waitForDevTools()
  created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  socket = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))

  let nextId = 0
  const pending = new Map()
  const consoleErrors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails?.exception?.description?.split('\n')[0] ?? message.params.exceptionDetails?.text)
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    message.error ? entry.fail(new Error(message.error.message)) : entry.settle(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((settle, fail) => {
      nextId += 1
      pending.set(nextId, { settle, fail })
      socket.send(JSON.stringify({ id: nextId, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'evaluate failed')
    return result.result.value
  }
  const waitFor = async (expression, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await evaluate(expression)) === true) return true
      await sleep(250)
    }
    return false
  }

  /**
   * 量一次。
   *
   * `blanks` 是这次断言的主角：**未挂载的块**压在视口里的竖带。占位块本身是空的
   * （只有高度），压住视口就是用户看到的那片空白。
   */
  const SNAP = `(() => {
    const content = document.getElementById('content')
    const grid = document.getElementById('grid')
    const view = content.getBoundingClientRect()
    const viewBottom = view.top + content.clientHeight
    const chunks = [...grid.children].map((node, index) => {
      const rect = node.getBoundingClientRect()
      return {
        index,
        unmounted: node.classList.contains('is-unmounted'),
        top: rect.top,
        bottom: rect.bottom,
        cards: node.querySelectorAll('.card').length,
      }
    })
    const blanks = chunks
      .filter((chunk) => chunk.unmounted && chunk.bottom > view.top && chunk.top < viewBottom)
      .map((chunk) => ({ index: chunk.index, coverTop: Math.round(Math.max(chunk.top, view.top) - view.top) }))
    const visibleCards = [...grid.querySelectorAll('.card')].filter((card) => {
      const rect = card.getBoundingClientRect()
      return rect.bottom > view.top && rect.top < viewBottom
    }).length
    // 网格自己铺满整个视口时，视口里必须至少有一张卡：否则不是「空白带」而是
    // 形状更怪的洞（例如某一块被拆掉却没留占位）。
    const gridRect = grid.getBoundingClientRect()
    const gridCovers = gridRect.top <= view.top && gridRect.bottom >= viewBottom
    return {
      scrollTop: Math.round(content.scrollTop),
      maxScroll: Math.round(content.scrollHeight - content.clientHeight),
      chunkCount: chunks.length,
      chunkCards: chunks.map((chunk) => chunk.cards),
      tailUnmounted: chunks.length > 0 ? chunks[chunks.length - 1].unmounted : false,
      mounted: chunks.filter((chunk) => !chunk.unmounted).length,
      domCards: grid.querySelectorAll('.card').length,
      columns: (() => {
        const cards = [...grid.querySelectorAll('.card')]
        if (cards.length === 0) return 0
        const firstTop = Math.round(cards[0].getBoundingClientRect().top)
        return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length
      })(),
      visibleCards,
      gridCovers,
      blanks,
      shape: chunks.map((chunk) => chunk.index + (chunk.unmounted ? 'U' : 'M') + '(' + chunk.cards + ')').join(' '),
    }
  })()`

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1432, height: 556, deviceScaleFactor: 1, mobile: false })
  const items = await synth()
  const scanBody = JSON.stringify({ root: 0, rel: '', key: '', items, scanned: items.length, truncated: false })
  // 页面脚本之前换掉 fetch：/api/scan 交合成清单，其余照常。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const body = ${JSON.stringify(scanBody)};
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/scan')) return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }));
        return realFetch(input, init);
      };
    })()`,
  })
  await send('Page.navigate', { url: `${origin}/reel` })
  await waitFor('document.readyState === "complete"', 20000)
  await waitFor('document.querySelectorAll("#grid .card").length > 0', 30000)
  // 固定到「库 + 全部 + 网格」、目录栏收起：列数只随窗口宽度变，采样才可比。
  await evaluate('document.getElementById("collapseSidebar")?.click()')
  await evaluate('document.querySelector("[data-content-btn=\\"all\\"]").click()')
  await evaluate('document.querySelector("[data-view-btn=\\"grid\\"]").click()')
  await sleep(2500)

  const first = await evaluate(SNAP)
  const columns = Math.max(1, first.columns)
  check('清单条数对上', items.length === want, `${items.length} vs ${want}`)
  check('分成了多块（否则测不到窗口化）', first.chunkCount >= 3, `${first.chunkCount} 块`)
  check(
    '除末尾一块外，每块张数都是列数的整数倍',
    first.chunkCards.slice(0, -1).every((count) => count % columns === 0),
    `列数 ${columns}，各块 ${first.chunkCards.join('/')}`,
  )
  check('首屏没有未挂载块压住视口', first.blanks.length === 0, JSON.stringify(first.blanks))
  check('首屏只挂了视口附近的块', first.mounted <= 3, `挂了 ${first.mounted} 块`)

  // 滚一遍：下 → 上 → 几个跳跃。任何一帧的空白带都要记下来。
  const seen = { blanks: [], maxMounted: 0, maxCards: 0, holes: [] }
  const visit = async (top) => {
    await evaluate(`document.getElementById('content').scrollTop = ${top}`)
    await sleep(420)
    const snap = await evaluate(SNAP)
    seen.maxMounted = Math.max(seen.maxMounted, snap.mounted)
    seen.maxCards = Math.max(seen.maxCards, snap.domCards)
    if (snap.blanks.length > 0) seen.blanks.push(`top=${snap.scrollTop} ${JSON.stringify(snap.blanks)} shape=${snap.shape}`)
    else if (snap.gridCovers && snap.visibleCards === 0) seen.holes.push(`top=${snap.scrollTop} shape=${snap.shape}`)
    return snap
  }

  const maxScroll = first.maxScroll
  for (let top = 0; top <= maxScroll; top += 400) await visit(top)
  for (let top = maxScroll; top >= 0; top -= 300) await visit(top)
  for (const fraction of [0.5, 0.9, 0.1, 0.63, 0.99, 0]) await visit(Math.round(maxScroll * fraction))

  check('滚动全程没有未挂载块压住视口', seen.blanks.length === 0, seen.blanks.slice(0, 3).join(' ; '))
  check('网格铺满视口时总有卡片可见', seen.holes.length === 0, seen.holes.slice(0, 3).join(' ; '))
  check('同时挂载的块数仍然钉在 ±1', seen.maxMounted <= 3, `峰值 ${seen.maxMounted} 块`)
  check('窗口化没退化成「全都挂着」', seen.maxCards < items.length, `DOM 峰值 ${seen.maxCards} / ${items.length} 条`)
  check('没有控制台异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  socket?.close()
  if (created !== null) await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`).catch(() => {})
  chrome.kill('SIGKILL')
  await sleep(300)
  rmSync(userDataDir, { recursive: true, force: true })
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('平铺网格分块验证通过 ✓')
