/**
 * 全屏壁纸验证：从播放器把当前这条设成壁纸，量层、持久化、点击穿透与取消。
 *
 * 为什么要单独一套：壁纸是一层 `position: fixed` 的媒体 + 一整套「玻璃」配色，
 * 出问题的样子都不报错——层被别的元素盖住、点击被它吃掉、刷新后没了、取消不掉。
 * 这些只能真的开一个浏览器看。
 *
 * 用法：node tests/wallpaper.mjs <origin>
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const origin = process.argv[2] ?? 'http://127.0.0.1:3080'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const failures = []
let passes = 0

const check = (label, ok, detail) => {
  if (ok) passes += 1
  else failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const userDataDir = mkdtempSync(join(tmpdir(), 'mv-wall-'))
const port = 9346
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`, '--no-first-run', '--no-sandbox', '--disable-gpu', '--autoplay-policy=no-user-gesture-required', 'about:blank'],
  { stdio: 'ignore', windowsHide: true },
)

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(250)
  }
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const socket = new WebSocket(created.webSocketDebuggerUrl)
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
    if (result.exceptionDetails !== undefined) {
      throw new Error(`${result.exceptionDetails.text} :: ${(result.exceptionDetails.exception?.description ?? '').split('\n').slice(0, 2).join(' | ')}`)
    }
    return result.result.value
  }
  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if ((await evaluate(expression)) === true) return true
      await sleep(250)
    }
    return false
  }

  /** 壁纸的可观察状态。 */
  const STATE = `(() => {
    const layer = document.getElementById('wallpaper')
    const child = layer.firstElementChild
    const card = document.querySelector('.card')
    const hit = card === null ? null : (() => {
      const rect = card.getBoundingClientRect()
      const node = document.elementFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2))
      return node === null ? '' : (node.closest('.card') !== null ? 'card' : node.tagName.toLowerCase())
    })()
    return {
      hidden: layer.hidden,
      tag: child === null ? '' : child.tagName.toLowerCase(),
      src: child === null ? '' : (child.getAttribute('src') ?? ''),
      fit: child === null ? '' : getComputedStyle(child).objectFit,
      playing: child !== null && child.tagName === 'VIDEO' ? child.paused === false : null,
      body: document.body.dataset.wallpaper ?? '',
      stored: localStorage.getItem('mv.wallpaper'),
      pointerEvents: getComputedStyle(layer).pointerEvents,
      hit,
      cards: document.querySelectorAll('.card').length,
      tileGlass: getComputedStyle(document.querySelector('.card') ?? document.body).backgroundColor,
    }
  })()`

  /** 从播放器把第一条视频设成壁纸 / 取消壁纸（同一枚按钮点一下切换）。 */
  const clickWallpaperInPlayer = () => evaluate(`(async () => {
    const card = [...document.querySelectorAll('.card[data-key]')].find((node) => node.classList.contains('card-video'))
    if (card === undefined) return { ok: false, reason: '这个目录里没有视频卡片' }
    card.click()
    const deadline = Date.now() + 12000
    while (Date.now() < deadline && document.getElementById('player').hidden) await new Promise((r) => setTimeout(r, 200))
    await new Promise((r) => setTimeout(r, 1500))
    const button = document.getElementById('btnWallpaper')
    if (button === null) return { ok: false, reason: '播放器里没有壁纸按钮' }
    const titleBefore = button.title
    button.click()
    await new Promise((r) => setTimeout(r, 700))
    const titleAfter = button.title
    document.getElementById('btnClose').click()
    await new Promise((r) => setTimeout(r, 500))
    return { ok: true, titleBefore, titleAfter }
  })()`)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `${origin}/reel` })
  // 导航之后先等一拍再发求值：导航途中发 Runtime.evaluate，CDP 命令会悬着不返回，
  // 整个测试就静悄悄地挂住（仓库里其它界面测试也都这么等）。
  await sleep(1200)
  check('首屏出卡片', await waitFor('document.querySelectorAll(".card").length > 0', 25000))

  // 1. 没设壁纸时，层是藏着的、body 上也没有标记
  const fresh = await evaluate(STATE)
  console.log('① 开箱:', JSON.stringify({ hidden: fresh.hidden, tag: fresh.tag, body: fresh.body, stored: fresh.stored }))
  check('开箱没有壁纸层', fresh.hidden === true && fresh.tag === '' && fresh.body === '', JSON.stringify(fresh))
  check('开箱没有壁纸记录', fresh.stored === null, String(fresh.stored))

  // 2. 从播放器设一条视频壁纸
  const set = await clickWallpaperInPlayer()
  console.log('② 设置:', JSON.stringify(set))
  check('播放器里有壁纸按钮', set.ok === true, JSON.stringify(set))
  const on = await evaluate(STATE)
  check('壁纸层显出来了', on.hidden === false && on.body === '1', JSON.stringify(on))
  check('壁纸是视频（走流地址）', on.tag === 'video' && on.src.includes('/reel/'), JSON.stringify({ tag: on.tag, src: on.src }))
  check('视频壁纸自动在放', on.playing === true, String(on.playing))
  check('壁纸铺满（object-fit: cover）', on.fit === 'cover', on.fit)
  check('壁纸记录写进 localStorage', typeof on.stored === 'string' && on.stored.includes('"kind":"video"'), String(on.stored))
  check('壁纸层不吃点击（pointer-events: none）', on.pointerEvents === 'none', on.pointerEvents)
  check('卡片仍能收到点击（层没盖住界面）', on.hit === 'card', String(on.hit))
  check('网格还在（壁纸没把内容顶掉）', on.cards > 0, String(on.cards))
  check('界面转成玻璃（卡片底色带透明度）', /rgba\(.+,\s*0?\.\d+\)/.test(on.tileGlass), on.tileGlass)
  check('设完之后按钮文案变成「取消」', String(set.titleAfter).includes('取消'), `${set.titleBefore} → ${set.titleAfter}`)

  // 3. 刷新后壁纸还在（这是「壁纸」该有的脾气）
  await send('Page.navigate', { url: `${origin}/reel` })
  await sleep(1200)
  check('刷新后重新画出网格', await waitFor('document.querySelectorAll(".card").length > 0', 25000))
  const afterReload = await evaluate(STATE)
  console.log('③ 刷新后:', JSON.stringify({ hidden: afterReload.hidden, tag: afterReload.tag, body: afterReload.body }))
  check('刷新后壁纸还在', afterReload.hidden === false && afterReload.tag === 'video' && afterReload.body === '1', JSON.stringify(afterReload))

  // 4. 取消：同一条视频上再点一次那枚按钮（此时记录里的 key 正是它）
  const clear = await clickWallpaperInPlayer()
  console.log('④ 取消:', JSON.stringify(clear))
  check('取消壁纸的点击成功', clear.ok === true, JSON.stringify(clear))
  const cleared = await evaluate(STATE)
  check('取消后层藏起来、body 标记清掉', cleared.hidden === true && cleared.tag === '' && cleared.body === '', JSON.stringify(cleared))
  // 取消写的是 'off' 而不是删键：设置里可能配着默认壁纸，删键就等于「回到默认」，
  // 那张又冒出来了（第 6 段专门验这个）。
  check('取消后记住「本机不要」', String(cleared.stored) === 'off', String(cleared.stored))
  check('取消后界面配色回到不透明', !/rgba\(.+,\s*0?\.\d+\)/.test(cleared.tileGlass), cleared.tileGlass)

  // 5. 图片壁纸：图片和视频走的是两条分支（<img> vs <video>）。这台机器上的库
  //    里没有图片，所以直接写一条「图片壁纸」记录（URL 用真实的 /reel/thumb），
  //    验证 <img> 分支、铺满方式和点击穿透。
  const thumb = await evaluate(`(() => {
    const image = document.querySelector('.card-media img')
    return image === null ? '' : image.getAttribute('src')
  })()`)
  check('能找到一张真实图片地址', String(thumb).startsWith('/reel/'), String(thumb))
  await evaluate(`localStorage.setItem('mv.wallpaper', JSON.stringify({ key: 'probe/photo.jpg', kind: 'image', name: '图片壁纸', url: ${JSON.stringify(thumb)}, poster: '' }))`)
  await send('Page.navigate', { url: `${origin}/reel` })
  await sleep(1200)
  check('刷新后重画网格（图片壁纸）', await waitFor('document.querySelectorAll(".card").length > 0', 25000))
  const imageWall = await evaluate(STATE)
  console.log('⑤ 图片壁纸:', JSON.stringify({ tag: imageWall.tag, fit: imageWall.fit, hidden: imageWall.hidden }))
  check('图片壁纸用 <img> 铺满', imageWall.tag === 'img' && imageWall.fit === 'cover', JSON.stringify({ tag: imageWall.tag, fit: imageWall.fit }))
  check('图片壁纸同样不吃点击', imageWall.pointerEvents === 'none' && imageWall.hit === 'card', JSON.stringify({ pe: imageWall.pointerEvents, hit: imageWall.hit }))
  await evaluate(`localStorage.removeItem('mv.wallpaper')`)

  // 6. 设置里配的那张（会话里的 wallpaper 字段）：本机没表态时它当默认；本机说过
  //    'off' 就连它一起压掉。这台机器的实例还跑着旧的 reel.js（会话里没有这个
  //    字段），所以这里把会话响应换成带壁纸的一份。
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const real = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (!url.includes('/api/session')) return real(input, init)
        return real(input, init).then(async (response) => {
          const payload = await response.json()
          payload.wallpaper = {
            key: 'r0/configured.jpg', kind: 'image', name: '设置里的壁纸',
            streamUrl: '/reel/stream?k=r0%2Fconfigured.jpg',
            thumbUrl: '/reel/thumb?k=r0%2Fconfigured.jpg',
          }
          return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
        })
      }
    })()`,
  })
  await send('Page.navigate', { url: `${origin}/reel` })
  await sleep(1400)
  check('重画网格（设置里的壁纸）', await waitFor('document.querySelectorAll(".card").length > 0', 25000))
  const configured = await evaluate(STATE)
  console.log('⑥ 设置里的壁纸:', JSON.stringify({ hidden: configured.hidden, tag: configured.tag, src: configured.src, stored: configured.stored }))
  check('本机没选过时用设置里那张', configured.hidden === false && configured.tag === 'img' && configured.src.includes('configured.jpg'), JSON.stringify(configured))
  check('用设置里那张时不写本机记录', configured.stored === null, String(configured.stored))

  await evaluate(`localStorage.setItem('mv.wallpaper', 'off')`)
  await send('Page.navigate', { url: `${origin}/reel` })
  await sleep(1400)
  check('重画网格（本机关掉）', await waitFor('document.querySelectorAll(".card").length > 0', 25000))
  const suppressed = await evaluate(STATE)
  check('本机说 off 时设置里那张也不显示', suppressed.hidden === true && suppressed.body === '', JSON.stringify(suppressed))

  check('没有控制台异常', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
} catch (error) {
  failures.push(`执行异常：${error.message}`)
} finally {
  try {
    socket?.close()
    await fetch(`http://127.0.0.1:${port}/json/close/${created?.id}`).catch(() => {})
    chrome.kill('SIGKILL')
    await sleep(400)
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    /* Chrome 有时还攥着 profile 目录，删不掉不该让测试结果变成崩栈 */
  }
}

console.log(`\n通过 ${passes} 项`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全屏壁纸验证通过 ✓')
