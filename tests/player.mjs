import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'

const source = readFileSync(new URL('../lib/assets/player.js', import.meta.url), 'utf8')
let passes = 0
const equal = (name, actual, expected) => { assert.deepEqual(actual, expected, name); passes += 1 }
const check = (name, value) => { assert.ok(value, name); passes += 1 }

// Exercise the complete shipped controller, with deterministic media events and timers.
// No source extraction: lifecycle, listener cleanup and source transitions run together.
function harness(saved = {}, options = {}) {
  const store = new Map(Object.entries(saved).map(([key, value]) => [key, JSON.stringify(value)]))
  const timers = new Map()
  const frames = [], revoked = []
  let nextTimer = 0, clock = 1000, closes = 0
  class Node {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id
      this.children = []; this.dataset = {}; this.style = {}; this.attributes = new Map()
      this.events = new Map(); this.hidden = false; this.textContent = ''; this.isConnected = true
      this.clientHeight = 500
      const classes = new Set()
      this.classList = { add: (...keys) => keys.forEach((key) => classes.add(key)), remove: (...keys) => keys.forEach((key) => classes.delete(key)), contains: (key) => classes.has(key), toggle: (key, on = !classes.has(key)) => { if (on) classes.add(key); else classes.delete(key) } }
      if (tag === 'track') this.track = { language: '', mode: 'disabled', cues: [] }
    }
    addEventListener(type, fn) { const list = this.events.get(type) ?? []; list.push(fn); this.events.set(type, list) }
    removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) ?? []).filter((entry) => entry !== fn)) }
    fire(type, details = {}) { const event = { target: this, preventDefault() { this.prevented = true }, stopPropagation() { this.stopped = true }, ...details }; for (const fn of [...this.events.get(type) ?? []]) fn(event); return event }
    appendChild(child) { child.parent = this; this.children.push(child); return child }
    set innerHTML(value) { this.children = []; this.markup = value; if (value === '<div class="bubble"></div>') this.appendChild(new Node()) }
    get innerHTML() { return this.markup ?? '' }
    get firstChild() { return this.children[0] ?? null }
    set src(value) { this.attributes.set('src', value); this.sources?.push(value); this.onSourceAssignment?.(value) }
    get src() { return this.attributes.get('src') ?? '' }
    set srclang(value) { this.track.language = value }
    setAttribute(name, value) { this.attributes.set(name, value) }
    getAttribute(name) { return this.attributes.get(name) ?? null }
    removeAttribute(name) { this.attributes.delete(name) }
    querySelectorAll(selector) {
      if (selector === 'track') return this.children.filter((node) => node.tagName === 'TRACK')
      if (selector === 'button') return this.children.filter((node) => node.tagName === 'BUTTON')
      return []
    }
    querySelector(selector) { return selector === '.bubble-flash' ? this.children.find(node => node.className?.split(' ').includes('bubble-flash')) ?? null : null }
    contains(node) { return node === this || node?.parent === this }
    closest(selector) { return selector.includes('button') && this.tagName === 'BUTTON' ? this : null }
    getBoundingClientRect() { return this.rect ?? { left: 0, width: 100 } }
    getClientRects() { return this.hidden ? [] : [{}] }
    setPointerCapture(pointer) { this.capture = pointer }
    releasePointerCapture(pointer) { if (this.capture === pointer) { this.capture = null; this.fire('lostpointercapture', { pointerId: pointer }) } }
    focus() { doc.activeElement = this }
    canPlayType() { return 'probably' }
    remove() { this.isConnected = false }
  }
  class Video extends Node {
    constructor(id) { super('video', id); this.sources = []; this.paused = true; this.currentTime = 0; this.duration = NaN; this.videoWidth = 0; this.videoHeight = 0; this.readyState = 0; this.playCalls = 0; this.playbackRate = 1; this.buffered = { length: 0 } }
    get textTracks() { return this.querySelectorAll('track').map((node) => node.track) }
    pause() { if (!this.paused) { this.paused = true; this.fire('pause') } }
    play() { this.paused = false; this.playCalls += 1; this.fire('play'); return Promise.resolve() }
    load() { this.currentTime = 0; this.duration = NaN; this.videoWidth = 0; this.videoHeight = 0; this.readyState = 0; this.buffered = { length: 0 } }
    metadata(duration = 200) { this.duration = duration; this.readyState = 1; this.fire('loadedmetadata') }
  }
  const ids = [...readFileSync(new URL('../lib/assets/index.html', import.meta.url), 'utf8').matchAll(/id="([^"]+)"/g)].map((match) => match[1])
  const nodes = Object.fromEntries(ids.map((id) => [id, ['video', 'nextVideo', 'progressTipVideo'].includes(id) ? new Video(id) : new Node('div', id)]))
  for (const id of ['player', 'speedMenu', 'subtitleMenu', 'playerMoreMenu', 'playerPeek', 'progressTip', 'scrubImage']) nodes[id].hidden = true
  nodes.video.parent = nodes.player
  const doc = new Node('document')
  doc.activeElement = new Node('button'); doc.fullscreenElement = null; doc.pictureInPictureElement = null
  doc.getElementById = (id) => nodes[id] ?? null
  doc.createElement = (tag) => tag === 'video' ? new Video('probe') : new Node(tag)
  const win = new Node('window')
  const schedule = (fn, delay = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id }
  win.innerWidth = 1200; win.matchMedia = () => ({ matches: false }); win.setTimeout = schedule
  class BrowserURL extends URL { static createObjectURL() { return `blob:frame-${frames.length}` } static revokeObjectURL(url) { revoked.push(url) } }
  const context = createContext({ window: win, document: doc, localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }, setTimeout: schedule, clearTimeout: (id) => timers.delete(id), requestAnimationFrame: (fn) => schedule(fn, 16), cancelAnimationFrame: (id) => timers.delete(id), performance: { now: () => clock, getEntriesByName: () => [] }, HTMLElement: Node, Element: Node, Image: class {}, URL: BrowserURL, AbortController, fetch: (url, init) => new Promise(resolve => frames.push({ url, signal: init.signal, resolve })) })
  runInContext(source, context)
  const api = win.Reel.createPlayer({ items: [], onClose: () => { closes += 1 }, ...options })
  return {
    api, nodes, video: nodes.video, doc, win, store, root: win.Reel, frames, revoked,
    progress: () => JSON.parse(store.get('mv.progress') ?? '{}'),
    closes: () => closes,
    advance(ms) {
      const end = clock + ms
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next; clock = timer.at; timers.delete(id); timer.fn()
      }
      clock = end
    },
  }
}

const item = (key, name = `${key}.mp4`, extra = {}) => ({ key, name, kind: 'video', streamUrl: `/reel/stream?k=${key}`, transcodeUrl: `/reel/transcode?k=${key}`, ...extra })
{
  const h = harness({ 'mv.progress': { A: 40, B: 85 } })
  h.api.open([item('A'), item('B')], 0)
  equal('opening requests playback within the click before metadata arrives', h.video.playCalls, 1)
  h.api.next()
  equal('only the current source owns a metadata callback', h.video.events.get('loadedmetadata').length, 1)
  h.video.metadata()
  equal('rapid switching resumes B, never the stale A callback', h.video.currentTime, 85)
  equal('each source requests autoplay once; metadata cannot request another play', h.video.playCalls, 2)
  h.video.currentTime = 92; h.api.prev(); h.video.metadata()
  equal('switch saves B under its own key', h.progress().B, 92)
  equal('A retains its own resume position', h.video.currentTime, 40)
  h.video.currentTime = 51; h.api.open([item('A'), item('B')], 1); h.video.metadata()
  equal('opening another queue saves the old current item before seating', h.progress().A, 51)
  equal('reopened B keeps its independent progress', h.video.currentTime, 92)
  h.api.close(); h.video.fire('timeupdate'); h.api.close()
  equal('close fires once per opening', h.closes(), 1)
  equal('reset timeupdate does not erase the saved progress', h.progress().B, 92)
  equal('close cancels pending metadata handlers', h.video.events.get('loadedmetadata').length, 0)
}
{
  const h = harness({ 'mv.resume': false, 'mv.progress': { A: 60 } })
  h.api.open([item('A')], 0); h.video.metadata()
  equal('disabled resume starts from zero', h.video.currentTime, 0)
  const nearEnd = harness({ 'mv.progress': { A: 198 } })
  nearEnd.api.open([item('A', 'a.avi', { duration: 200 })], 0)
  check('a completed transcode restarts at the beginning', !nearEnd.video.src.includes('&t='))
}
{
  const h = harness()
  h.api.open([item('A', 'movie.mp4', { subtitles: [{ name: 'movie.zh.vtt', label: '中文', url: '/zh.vtt' }, { name: 'movie.en.vtt', label: 'English', url: '/en.vtt' }] })], 0)
  h.nodes.subtitleMenu.children[2].fire('click')
  equal('subtitle selection uses the actual track identity', h.video.textTracks[1].mode, 'showing')
  equal('other subtitles stay disabled', h.video.textTracks[0].mode, 'disabled')
  h.nodes.subtitleMenu.children[0].fire('click')
  equal('turning subtitles off disables all tracks', h.video.textTracks[1].mode, 'disabled')
}
{
  const h = harness()
  h.api.open([item('A', 'a.avi', { duration: 200, subtitles: [{ name: 'a.zh.vtt', url: '/zh.vtt' }] })], 0); h.video.metadata(5)
  const track = h.video.querySelectorAll('track')[0]
  track.track.cues = [{ startTime: 80, endTime: 90 }]
  const scrub = (pointerId, clientX) => {
    h.nodes.progress.fire('pointerdown', { pointerId, clientX, button: 0 })
    h.nodes.progress.fire('pointerup', { pointerId, clientX })
  }
  scrub(1, 25)
  equal('transcode subtitles use the source timeline offset', track.track.cues[0].startTime, 30)
  track.fire('load')
  equal('repeat track loads do not accumulate the offset', track.track.cues[0].startTime, 30)
  track.track.cues = [{ startTime: 80, endTime: 90 }]; track.fire('load')
  equal('new cues on a reloaded track receive the existing offset', track.track.cues[0].startTime, 30)
  scrub(2, 10)
  equal('seeking backwards restores the correct subtitle time', track.track.cues[0].startTime, 60)
}
{
  const h = harness()
  h.api.open([item('A', 'a.avi', { duration: 200 })], 0); h.video.metadata(5)
  const before = h.video.sources.length
  h.nodes.progress.fire('pointerdown', { pointerId: 1, clientX: 20, button: 0 })
  for (const clientX of [30, 40, 50, 60]) h.nodes.progress.fire('pointermove', { pointerId: 1, clientX })
  h.advance(16)
  equal('drag preview opens no new transcode streams', h.video.sources.length, before)
  check('drag preview displays the target time', h.nodes.timeLabel.textContent.startsWith('2:00'))
  h.nodes.progress.fire('pointerup', { pointerId: 1, clientX: 60 })
  h.win.fire('pointerup', { pointerId: 1, clientX: 60 })
  equal('release commits exactly one transcode stream', h.video.sources.length, before + 1)
  check('stream restart uses the released absolute target', h.video.src.endsWith('&t=120'))
  h.video.metadata(6)
  h.nodes.progress.fire('pointerdown', { pointerId: 2, clientX: 10, button: 0 })
  h.nodes.progress.fire('pointercancel', { pointerId: 2 })
  equal('pointer cancellation does not commit a jump', h.video.sources.length, before + 1)
  h.nodes.progress.fire('pointermove', { pointerId: 2, clientX: 90 })
  h.video.currentTime = 3; h.video.fire('timeupdate')
  check('timeline follows playback again after cancellation', h.nodes.timeLabel.textContent.startsWith('2:03'))
}
{
  const h = harness()
  h.api.open([item('A')], 0); h.video.metadata(200)
  h.video.currentTime = 20; h.video.fire('timeupdate')
  const down = h.nodes.progress.fire('pointerdown', { pointerId: 11, pointerType: 'touch', clientX: 50, button: 0 })
  check('scrub gesture prevents page actions and feed swipe propagation', down.prevented && down.stopped)
  check('scrubbing keeps playback running without showing the central play overlay', !h.video.paused && !h.nodes.player.classList.contains('show-center'))
  h.advance(16)
  equal('the picture seeks while the pointer is still held', h.video.currentTime, 100)
  h.video.seeking = true
  h.nodes.progress.fire('pointermove', { pointerId: 11, pointerType: 'touch', clientX: 70 })
  for (const type of ['progress', 'durationchange', 'timeupdate']) h.video.fire(type)
  h.win.fire('resize'); h.api.refreshMeta()
  h.advance(16)
  equal('buffer, duration, metadata and resize events cannot overwrite the scrub target', h.nodes.progressPlayed.style.width, '70.000%')
  equal('target time remains stable during media events', h.nodes.timeLabel.textContent, '2:20 / 3:20')
  equal('touch dragging never starts a second preview decoder', h.nodes.progressTipVideo.sources.length, 0)
  equal('the slider exposes seconds and a readable target instead of an unlabelled percentage', h.nodes.progress.getAttribute('aria-valuetext'), '2:20 / 3:20')
  equal('in-flight decoding is not cancelled by every pointer move', h.video.currentTime, 100)
  h.video.seeking = false; h.advance(60); h.video.fire('seeked')
  equal('when decoding completes it takes the latest target', h.video.currentTime, 140)
  h.nodes.progress.fire('pointerup', { pointerId: 99, clientX: 10 })
  check('another finger cannot finish the active gesture', h.nodes.progress.classList.contains('is-scrubbing'))
  h.nodes.progress.fire('pointerup', { pointerId: 11, clientX: 75 })
  equal('release commits the final pointer position', h.video.currentTime, 150)
  check('release restores playback and hides the dragging time bubble', !h.video.paused && h.nodes.progressTip.hidden)
  equal('release does not pause and restart already playing media', h.video.playCalls, 1)
  equal('release clears pointer capture', h.nodes.progress.capture, null)
  h.nodes.progress.parent = h.nodes.player
  h.nodes.progress.matches = () => false
  h.advance(2700)
  check('pointer focus after seeking does not keep controls on screen forever', h.nodes.player.classList.contains('chrome-hidden'))
  h.nodes.progress.matches = () => true
  h.nodes.player.fire('focusin'); h.advance(2700)
  check('keyboard focus keeps the controls visible for the next action', !h.nodes.player.classList.contains('chrome-hidden'))
}
{
  const h = harness({}, { autoplay: false })
  h.api.open([item('A')], 0); h.video.metadata(200)
  h.video.currentTime = 40; h.video.fire('timeupdate')
  // The outer hit area can differ from the actual painted track.
  h.nodes.progress.rect = { left: 0, width: 200 }
  h.nodes.progressTrack.rect = { left: 20, width: 100 }
  h.nodes.progress.fire('pointerdown', { pointerId: 12, clientX: 44, button: 0 })
  h.advance(16)
  equal('grabbing near the thumb preserves the exact current position', h.nodes.timeLabel.textContent, '0:40 / 3:20')
  h.win.fire('pointermove', { pointerId: 12, clientX: 64 })
  h.advance(64)
  equal('drag geometry follows the painted track and grab offset', h.nodes.timeLabel.textContent, '1:20 / 3:20')
  h.win.fire('pointerup', { pointerId: 12, clientX: 64 })
  equal('window fallback commits using the final coordinate', h.video.currentTime, 80)
  equal('seeking a paused video keeps it paused', h.video.playCalls, 0)
  h.nodes.progress.fire('pointerdown', { pointerId: 13, clientX: 80, button: 0 })
  h.win.fire('pointermove', { pointerId: 13, clientX: -200 })
  h.advance(16)
  equal('dragging beyond the left edge clamps to zero', h.nodes.progressPlayed.style.width, '0.000%')
  h.win.fire('pointermove', { pointerId: 13, clientX: 999 })
  h.advance(64)
  equal('dragging beyond the right edge clamps to the end', h.nodes.progressPlayed.style.width, '100.000%')
  h.win.fire('pointercancel', { pointerId: 13 })
  equal('system cancellation restores the actual position without a seek', h.video.currentTime, 80)
  equal('cancel hides the tooltip and releases capture', [h.nodes.progressTip.hidden, h.nodes.progress.capture], [true, null])
  h.doc.fire('keydown', { key: 'ArrowRight', target: h.nodes.progress })
  h.doc.fire('keyup', { key: 'ArrowRight', target: h.nodes.progress })
  equal('focused slider supports a precise one-second keyboard step', h.video.currentTime, 81)
  h.doc.fire('keydown', { key: 'ArrowLeft', shiftKey: true, target: h.nodes.progress })
  h.doc.fire('keyup', { key: 'ArrowLeft', target: h.nodes.progress })
  equal('shift gives a ten-second keyboard step', h.video.currentTime, 71)
  h.nodes.btnFwd10.fire('click'); h.nodes.btnBack10.fire('click')
  equal('visible forward/back buttons operate the same absolute timeline', h.video.currentTime, 71)
}
{
  const h = harness()
  h.api.open([item('A'), item('B')], 0); h.video.metadata(200)
  h.video.currentTime = 30; h.video.fire('timeupdate')
  h.nodes.progress.fire('pointerdown', { pointerId: 14, clientX: 60, button: 0 })
  h.nodes.progress.fire('lostpointercapture', { pointerId: 14 })
  check('lost capture resumes the original playback state without seeking', !h.video.paused && h.video.currentTime === 30)
  h.nodes.progress.fire('pointerdown', { pointerId: 15, clientX: 60, button: 0 })
  h.win.fire('blur')
  check('window blur clears the gesture and restores playback', !h.video.paused && !h.nodes.progress.classList.contains('is-scrubbing'))
  h.nodes.progress.fire('pointerdown', { pointerId: 16, clientX: 60, button: 0 })
  h.doc.fire('keydown', { key: 'Escape', target: h.nodes.progress })
  check('escape cancels a drag while keeping the player open', h.api.isOpen() && !h.nodes.progress.classList.contains('is-scrubbing'))
  h.nodes.progress.fire('pointerdown', { pointerId: 17, clientX: 60, button: 0 })
  h.api.next(); h.video.metadata(200)
  equal('switching files releases the old pointer capture', h.nodes.progress.capture, null)
  h.win.fire('pointerup', { pointerId: 17, clientX: 90 })
  equal('late release from an old file cannot seek the new file', h.video.currentTime, 0)
}
{
  const h = harness()
  h.api.open([item('A', 'a.avi', { duration: 200 })], 0); h.video.metadata(5)
  h.video.currentTime = 8
  const transitionTimes = []
  h.video.onSourceAssignment = () => { h.video.fire('progress'); transitionTimes.push(h.nodes.timeLabel.textContent) }
  h.nodes.progress.fire('pointerdown', { pointerId: 18, clientX: 60, button: 0 })
  h.nodes.progress.fire('pointerup', { pointerId: 18, clientX: 60 })
  equal('src replacement cannot add the old segment time to the committed target', transitionTimes, ['2:00 / 3:20'])
  check('transcode restart retains the release gesture for play', !h.video.paused)
  h.video.metadata(5)
  equal('metadata keeps the absolute target after a transcode seek', h.nodes.timeLabel.textContent, '2:00 / 3:20')
  const paused = harness({}, { autoplay: false })
  paused.api.open([item('A', 'a.avi', { duration: 200 })], 0); paused.video.metadata(5)
  paused.nodes.progress.fire('pointerdown', { pointerId: 19, clientX: 60, button: 0 })
  paused.nodes.progress.fire('pointerup', { pointerId: 19, clientX: 60 }); paused.video.metadata(5)
  equal('paused transcode seeking never starts playback', paused.video.playCalls, 0)
  const unknown = harness()
  unknown.api.open([item('A', 'a.avi')], 0); unknown.video.metadata(5)
  unknown.nodes.progress.fire('pointerdown', { pointerId: 20, clientX: 60, button: 0 })
  check('unknown duration disables the slider instead of creating an invalid gesture', unknown.nodes.progress.getAttribute('aria-disabled') === 'true' && !unknown.nodes.progress.classList.contains('is-scrubbing'))
}
{
  const h = harness()
  h.api.open([item('A', 'a.avi', { duration: 200, scrubUrl: '/reel/frame?k=A&v=1' }), item('B')], 0); h.video.metadata(5)
  const streams = h.video.sources.length
  h.nodes.progress.fire('pointerdown', { pointerId: 31, clientX: 25, button: 0 }); h.advance(16)
  equal('transcode dragging requests the selected frame', h.frames[0].url, '/reel/frame?k=A&v=1&t=50')
  for (let x = 30; x <= 70; x++) h.nodes.progress.fire('pointermove', { pointerId: 31, clientX: x })
  h.advance(16)
  equal('many pointer moves keep one frame request in flight', h.frames.length, 1)
  equal('the full playback stream keeps running during frame preview', [h.video.sources.length, h.video.paused], [streams, false])
  h.frames[0].resolve({ ok: true, blob: async () => ({}) })
  await new Promise(done => setImmediate(done))
  check('decoded scrub frame replaces the main picture while held', !h.nodes.scrubImage.hidden && h.nodes.scrubImage.src.startsWith('blob:'))
  h.advance(100)
  equal('the next request uses the latest target rather than queued old positions', h.frames[1].url, '/reel/frame?k=A&v=1&t=140')
  h.api.next()
  check('switching aborts the pending frame read and removes the overlay', h.frames[1].signal.aborted && h.nodes.scrubImage.hidden)
  h.frames[1].resolve({ ok: true, blob: async () => ({}) })
  await new Promise(done => setImmediate(done))
  check('a late frame cannot cover the new file', h.nodes.scrubImage.hidden)
  equal('closing the preview releases the object URL', h.revoked.length, 1)
}
{
  for (const pointerType of ['mouse', 'touch']) {
    const h = harness({ 'mv.rate': 1.25 })
    h.api.open([item('A', 'a.avi', { duration: 200 })], 0); h.video.metadata(5)
    const streams = h.video.sources.length
    h.nodes.btnFwd10.fire('pointerdown', { pointerId: 32, pointerType, button: 0 })
    h.advance(300)
    equal(`${pointerType} long hold changes playback rate, not position`, [h.video.playbackRate, h.video.currentTime], [3, 0])
    h.advance(2000); h.video.fire('waiting')
    equal(`${pointerType} continuous forward never pauses or restarts the stream`, [h.video.paused, h.video.sources.length, h.video.playCalls], [false, streams, 1])
    check(`${pointerType} long forward suppresses the central loading indicator`, h.nodes.playerSpinner.hidden)
    h.win.fire('pointerup', { pointerId: 999 })
    equal('another finger cannot stop the active speed hold', h.video.playbackRate, 3)
    h.win.fire('pointerup', { pointerId: 32 }); h.nodes.btnFwd10.fire('click')
    equal(`${pointerType} release restores preferred speed without pausing or an extra seek`, [h.video.playbackRate, h.video.paused, h.video.sources.length], [1.25, false, streams])
    equal('temporary speed never overwrites the saved speed', JSON.parse(h.store.get('mv.rate')), 1.25)
  }
  const paused = harness({}, { autoplay: false })
  paused.api.open([item('A'), item('B')], 0); paused.video.metadata()
  paused.nodes.btnFwd10.fire('pointerdown', { pointerId: 33, pointerType: 'touch', button: 0 }); paused.advance(300)
  check('holding forward on a paused video starts visible accelerated playback', !paused.video.paused && paused.video.playbackRate === 3)
  paused.win.fire('pointercancel', { pointerId: 33 })
  check('system cancellation restores the original pause and speed', paused.video.paused && paused.video.playbackRate === 1)
  paused.nodes.btnFwd10.fire('pointerdown', { pointerId: 34, pointerType: 'touch', button: 0 }); paused.api.next(); paused.advance(300)
  equal('file switch cancels an unactivated speed timer', paused.video.playbackRate, 1)
  paused.nodes.btnFwd10.fire('keydown', { key: 'Enter' }); paused.advance(300)
  equal('keyboard hold also enables continuous accelerated playback', paused.video.playbackRate, 3)
  paused.nodes.btnFwd10.fire('keyup', { key: 'Enter' })
  equal('keyboard release restores normal speed', paused.video.playbackRate, 1)
  const tap = harness()
  tap.api.open([item('A')], 0); tap.video.metadata()
  tap.nodes.btnFwd10.fire('pointerdown', { pointerId: 35, button: 0 }); tap.advance(100); tap.win.fire('pointerup', { pointerId: 35 }); tap.nodes.btnFwd10.fire('click')
  equal('a short forward tap remains a single ten-second jump', tap.video.currentTime, 10)
  tap.video.fire('waiting')
  check('ordinary forward seeks suppress central loading as well', tap.nodes.playerSpinner.hidden)
}
{
  const h = harness()
  h.api.open([item('A')], 0); h.video.metadata(200)
  h.video.currentTime = 100
  h.nodes.btnBack10.fire('pointerdown', { pointerId: 41, pointerType: 'touch', button: 0 }); h.advance(300)
  h.advance(1000); h.advance(16)
  check('held rewind updates the picture before release', h.video.currentTime < 98 && h.video.currentTime > 90)
  const earlier = h.video.currentTime
  h.advance(1000); h.advance(16)
  check('rewind continues for as long as the pointer is held', h.video.currentTime < earlier - 2)
  check('rewind keeps frames running and hides central loading', !h.video.paused && h.nodes.player.classList.contains('is-rewinding'))
  h.video.fire('waiting')
  check('rewind cannot show the central loading indicator', h.nodes.playerSpinner.hidden)
  h.win.fire('pointerup', { pointerId: 41 })
  const released = h.video.currentTime
  h.nodes.btnBack10.fire('click')
  equal('release after held rewind does not add another ten-second jump', h.video.currentTime, released)
  check('rewind restores sound and ordinary forward playback', !h.video.paused && h.video.muted === false && !h.nodes.player.classList.contains('is-rewinding'))
  h.advance(1000)
  equal('released rewind cannot continue moving the timeline', h.video.currentTime, released)
  equal('back and forward actions leave no central +/-10s bubble', h.nodes.playerCenter.children.length, 0)
  const stream = harness({}, { autoplay: false })
  stream.api.open([item('A', 'a.avi', { duration: 200 })], 0); stream.video.metadata(5)
  stream.video.currentTime = 50
  const before = stream.video.sources.length
  stream.nodes.btnBack10.fire('pointerdown', { pointerId: 42, pointerType: 'mouse', button: 0 }); stream.advance(300)
  stream.advance(1000); stream.advance(16)
  equal('held reverse never repeatedly reopens the transcode stream', stream.video.sources.length, before)
  stream.win.fire('pointerup', { pointerId: 42 })
  equal('transcode rewind commits only once on release', stream.video.sources.length, before + 1)
  check('rewind release restores the original paused state even after a new stream version', stream.video.paused)
  equal('paused transcode rewind never autoplays the committed stream', stream.video.playCalls, 1)
  check('rewind release keeps its absolute target', stream.video.src.includes('&t=46'))
  const keyboard = harness()
  keyboard.api.open([item('A')], 0); keyboard.video.metadata(); keyboard.video.currentTime = 40
  keyboard.nodes.btnBack10.fire('keydown', { key: ' ' }); keyboard.advance(300); keyboard.advance(1000); keyboard.advance(16)
  keyboard.doc.fire('keyup', { key: ' ', target: keyboard.nodes.btnPlay })
  check('keyup after keyboard focus moves still ends the held action', !keyboard.nodes.player.classList.contains('is-rewinding'))
  const focused = keyboard.doc.createElement('button')
  const beforeKey = keyboard.video.currentTime
  keyboard.doc.fire('keydown', { key: 'ArrowRight', target: focused }); keyboard.doc.fire('keyup', { key: 'ArrowRight', target: focused })
  equal('right arrow still seeks after a playback button takes focus', keyboard.video.currentTime, beforeKey + 5)
  keyboard.doc.fire('keydown', { key: 'ArrowLeft', target: focused }); keyboard.advance(300); keyboard.advance(1000)
  check('held left arrow continuously rewinds rather than repeatedly opening sources', keyboard.nodes.player.classList.contains('is-rewinding'))
  keyboard.doc.fire('keyup', { key: 'ArrowLeft', target: focused })
  check('left arrow release ends continuous rewind', !keyboard.nodes.player.classList.contains('is-rewinding'))
}
{
  const h = harness({ 'mv.loop': true })
  h.api.open([item('A', 'a.avi', { duration: 200 })], 0); h.video.metadata(5)
  equal('native looping is disabled on fragmented transcodes', h.video.loop, false)
  h.video.paused = true; h.video.fire('ended'); h.video.metadata(5)
  equal('ended restarts and plays the transcode loop', h.video.playCalls, 2)
  equal('loop keeps the same item', h.api.currentItem().key, 'A')
  h.api.open([item('B')], 0); h.video.metadata()
  equal('direct files retain native looping', h.video.loop, true)
}
{
  const h = harness()
  h.api.open([item('A', 'a.avi')], 0); h.video.metadata(5)
  check('received fragment length is not reported as total duration', h.nodes.timeLabel.textContent.endsWith('--:--'))
  h.api.open([item('B')], 0); h.video.metadata()
  h.video.buffered = { length: 1, start: () => 0, end: () => 50 }; h.video.fire('progress')
  equal('buffer range is shown', h.nodes.progressBuffer.style.width, '25.00%')
  h.video.buffered = { length: 0 }; h.video.fire('progress')
  equal('empty buffers clear the previous bar', h.nodes.progressBuffer.style.width, '0%')
}
{
  const h = harness()
  h.api.open([item('A')], 0); h.video.error = { code: 3 }; h.video.fire('error')
  check('unsupported MP4 codec falls back to transcode', h.video.src.includes('/reel/transcode'))
  const count = h.video.sources.length
  h.video.fire('error')
  equal('failed transcode does not retry in a loop', h.video.sources.length, count)
}
{
  const h = harness()
  h.api.open([item('A'), item('B')], 0); h.video.metadata()
  h.nodes.player.fire('wheel', { deltaY: 30 }); h.advance(1); h.advance(300)
  equal('ordinary window scrolling does not switch the playing file', h.api.currentItem().key, 'A')
  h.api.open([item('A'), item('B')], 0, { fullPage: true, feed: true }); h.video.metadata()
  h.nodes.player.fire('wheel', { deltaY: 30 }); h.advance(1); h.api.close(); h.advance(300)
  equal('closing cancels the pending wheel transition', h.api.currentItem().key, 'A')
  equal('closing cannot restart media through a delayed animation', h.video.src, '')
  h.api.open([item('A')], 0); h.video.metadata()
  h.nodes.player.fire('pointerdown', { pointerType: 'mouse', button: 0, target: h.video })
  h.advance(400)
  equal('held pointer enables temporary speed', h.video.playbackRate, 2)
  h.win.fire('pointercancel')
  equal('cancel restores the preferred speed', h.video.playbackRate, 1)
  const count = h.video.playCalls
  h.video.fire('click')
  equal('release after a hold does not toggle playback', h.video.playCalls, count)
  const button = h.doc.createElement('button')
  const key = h.doc.fire('keydown', { key: ' ', target: button })
  check('space on a focused button retains native activation', !key.prevented)
  h.api.destroy()
  equal('destroy removes global pointer listeners', h.win.events.get('pointerup').length, 0)
  equal('destroy removes media listeners', h.video.events.get('timeupdate').length, 0)
  h.api.open([item('B')], 0)
  check('a destroyed controller cannot reopen', h.nodes.player.hidden)
}
{
  const h = harness({ 'mv.volume': 500, 'mv.rate': -8, 'mv.progress': null })
  h.api.open([item('A')], 0)
  equal('invalid stored volume is clamped', h.video.volume, 1)
  equal('invalid stored playback rate uses the default', h.video.playbackRate, 1)
  equal('invalid progress store is tolerated', h.root.progressStore.get('A'), 0)
}
{
  const h = harness({ 'mv.progress': { A: 60 } })
  h.api.open([item('A', 'a.mp4', { thumbUrl: '/poster-a' }), item('B')], 0, { feed: true, fullPage: true, order: 'seq' })
  h.video.metadata()
  equal('feed starts each clip from zero instead of resuming long-video history', h.video.currentTime, 0)
  equal('feed loops the current direct-play clip', h.video.loop, true)
  equal('poster is available while the first frame loads', h.video.poster, '/poster-a')
  equal('feed shows its position and dedicated controls', h.nodes.feedPosition.textContent, '1 / 2')
  check('feed is exposed as an explicit mode', h.api.isFeed() && !h.nodes.feedActions.hidden)
  h.video.fire('canplay')
  equal('only the direct-play next file is prepared', h.nodes.nextVideo.src, '/reel/stream?k=B')
  equal('next preparation never plays a second video', h.nodes.nextVideo.playCalls, 0)
  const wasPaused = h.video.paused
  h.nodes.player.fire('pointerdown', { pointerType: 'touch', pointerId: 7, clientX: 50, clientY: 350, target: h.video })
  h.nodes.player.fire('pointermove', { pointerId: 7, clientX: 52, clientY: 180, target: h.video })
  h.nodes.player.fire('pointerup', { pointerId: 7, target: h.video })
  h.video.fire('click')
  equal('synthetic click after a swipe cannot pause the video', h.video.paused, wasPaused)
  h.advance(250)
  equal('vertical swipe switches exactly one clip', h.api.currentItem().key, 'B')
  equal('switch updates the feed position', h.nodes.feedPosition.textContent, '2 / 2')
  h.api.close()
  equal('close releases next-video preparation', h.nodes.nextVideo.src, '')
  h.api.open([item('A'), item('B')], 0)
  check('ordinary playback has no feed overlay', h.nodes.feedActions.hidden && !h.api.isFeed())
  equal('feed looping does not leak into ordinary player preferences', h.video.loop, false)
  h.video.metadata()
  h.nodes.player.fire('pointerdown', { pointerType: 'touch', pointerId: 8, clientX: 50, clientY: 350, target: h.video })
  h.nodes.player.fire('pointermove', { pointerId: 8, clientX: 50, clientY: 100, target: h.video })
  h.nodes.player.fire('pointerup', { pointerId: 8, target: h.video }); h.advance(250)
  equal('ordinary touch playback cannot accidentally swipe to a different file', h.api.currentItem().key, 'A')
}
{
  const h = harness()
  h.api.open([item('A'), item('B', 'b.avi')], 0, { feed: true }); h.video.metadata(); h.video.fire('canplay')
  equal('preparation never launches a next-file transcode', h.nodes.nextVideo.src, '')
  h.video.error = { code: 2 }; h.video.fire('error')
  check('network errors persist with a usable retry action', !h.nodes.playerError.hidden && h.nodes.playerErrorText.textContent.includes('网络'))
  const before = h.video.sources.length
  h.nodes.playerRetry.fire('click')
  equal('retry reopens exactly one current source', h.video.sources.length, before + 1)
  check('retry clears the stale error panel', h.nodes.playerError.hidden)
}
{
  const h = harness({ 'mv.order': 'random', 'mv.progress': { A: 60 } })
  h.api.open([item('A'), item('B')], 0, { feed: true, order: 'seq' }); h.video.metadata()
  h.video.currentTime = 12; h.api.close()
  equal('short-video browsing cannot overwrite ordinary resume history', h.progress().A, 60)
  equal('feed sequence does not overwrite the saved ordinary playlist preference', JSON.parse(h.store.get('mv.order')), 'random')
  h.api.open([item('A'), item('B')], 0); h.video.metadata()
  check('ordinary playback restores its random-order preference after leaving the feed', h.nodes.btnOrder.classList.contains('is-on'))
  equal('ordinary playback still resumes its independent position', h.video.currentTime, 60)
}
{
  const h = harness()
  const queue = [item('A'), item('B'), item('C')]
  h.api.open(queue, 0, { order: 'random' })
  h.api.next(); h.api.next()
  const tail = h.api.currentItem().key
  h.api.prev()
  h.api.replaceItems([...queue, item('D')])
  h.api.next()
  equal('appending a library page preserves the remaining shuffled playlist order', h.api.currentItem().key, tail)
}
{
  const h = harness({ 'mv.autoplay': false })
  h.api.open([item('A')], 0)
  equal('disabled autoplay does not play during opening', h.video.playCalls, 0)
  h.video.metadata()
  equal('metadata respects disabled autoplay', h.video.playCalls, 0)
}
console.log(`播放器生命周期回归通过 ${passes} 项 ✓`)
