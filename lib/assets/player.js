/*
 * dsh-reel — 播放器。
 *
 * 一个自足的控制器：接管全屏浮层、控件、快捷键、字幕、续播、统计与连播，
 * 只依赖一个 <video> 元素和宿主的范围流式接口。宿主对每个请求都回 206 +
 * Content-Range，所以拖动进度条是即时起播，而不是重新缓冲整个文件。
 *
 * 对外的全部接口都在 window.Reel.Player 上。
 */
(() => {
  'use strict'

  const root = (window.Reel = window.Reel || {})

  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  const LS = {
    volume: 'mv.volume',
    muted: 'mv.muted',
    rate: 'mv.rate',
    loop: 'mv.loop',
    autoplay: 'mv.autoplay',
    resume: 'mv.resume',
    progress: 'mv.progress',
  }

  const read = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch {
      return fallback
    }
  }

  const write = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* 隐私模式下 localStorage 可能不可用 */
    }
  }

  /** 记录每个文件的观看进度，键是稳定的媒体 key。 */
  const progressStore = {
    all: () => read(LS.progress, {}),
    get(key) {
      const entry = this.all()[key]
      return typeof entry === 'number' && Number.isFinite(entry) ? entry : 0
    },
    set(key, seconds) {
      if (typeof key !== 'string' || key === '') return
      const all = this.all()
      if (seconds < 5) delete all[key]
      else all[key] = Math.round(seconds)
      const keys = Object.keys(all)
      // 只保留最近 800 条，避免 localStorage 无限增长。
      if (keys.length > 800) {
        for (const stale of keys.slice(0, keys.length - 800)) delete all[stale]
      }
      write(LS.progress, all)
    },
    clear(key) {
      const all = this.all()
      delete all[key]
      write(LS.progress, all)
    },
  }

  root.progressStore = progressStore

  /** 秒 → `h:mm:ss` / `m:ss`。 */
  const fmtTime = (seconds) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const total = Math.floor(seconds)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
  }

  root.fmtTime = fmtTime

  /** 字节 → 人类可读。 */
  const fmtBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
    const value = bytes / 1024 ** index
    return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
  }

  root.fmtBytes = fmtBytes

  /** 统一的轻提示。 */
  const toast = (message, kind) => {
    const host = document.getElementById('toasts')
    if (host === null) return
    const node = document.createElement('div')
    node.className = `toast${kind === 'error' ? ' is-error' : ''}`
    node.textContent = message
    host.appendChild(node)
    setTimeout(() => node.remove(), kind === 'error' ? 4200 : 2200)
  }

  root.toast = toast

  /** 是否是可播放的视频条目。 */
  const isVideo = (item) => item !== undefined && item !== null && item.kind === 'video'

  /**
   * 探测浏览器能否解码这个容器，避免给用户一个永远黑屏的播放按钮。
   * 扩展名是弱信号，但足以区分「Chrome 打不开 MKV」这类常见情况。
   */
  const canPlayContainer = (name, video) => {
    const ext = String(name ?? '').toLowerCase().replace(/^.*\./, '')
    const candidates = {
      mp4: ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4'],
      m4v: ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4'],
      mov: ['video/quicktime', 'video/mp4'],
      webm: ['video/webm; codecs="vp9, opus"', 'video/webm'],
      mkv: ['video/x-matroska', 'video/webm'],
      ogv: ['video/ogg'],
      ts: ['video/mp2t'],
      m2ts: ['video/mp2t'],
    }
    const list = candidates[ext]
    if (list === undefined) return 'maybe'
    for (const type of list) {
      if (video.canPlayType(type) !== '') return 'yes'
    }
    // 有些容器没有 MIME 声明，交给浏览器实际尝试。
    if (ext === 'mkv' || ext === 'mov' || ext === 'ts' || ext === 'm2ts') return 'maybe'
    return 'no'
  }

  root.canPlayContainer = canPlayContainer

  /**
   * 播放器。
   *
   * @param {{items: object[], index?: number, autoplay?: boolean, onIndexChange?: Function, onClose?: Function}} options
   * @returns {{open: Function, close: Function, next: Function, prev: Function, isOpen: Function, playIndex: Function}}
   */
  root.createPlayer = function createPlayer(options) {
    /** 播放列表；拖动进度或连播都在这个数组上推进。 */
    let items = Array.isArray(options.items) ? options.items.slice() : []
    let index = Number.isInteger(options.index) ? options.index : 0
    /** 关闭回调只应触发一次，用标志位挡住重复调用。 */
    let destroyed = false
    /** 静音状态来自上次会话，默认静音以便自动播放能成功。 */
    let muted = read(LS.muted, false)
    let volume = read(LS.volume, 0.9)
    let rate = read(LS.rate, 1)
    let loopOne = read(LS.loop, false)
    let statsOpen = false
    let hideTimer = 0
    /** 记录已保存的进度，避免在 0 秒时反复写入。 */
    let lastSaved = -1
    /** 拖动进度条时暂停自动跟随。 */
    let scrubbing = false

    const el = {
      player: document.getElementById('player'),
      video: document.getElementById('video'),
      chrome: document.getElementById('playerChrome'),
      center: document.getElementById('playerCenter'),
      bigPlay: document.getElementById('bigPlay'),
      spinner: document.getElementById('playerSpinner'),
      toast: document.getElementById('playerToast'),
      name: document.getElementById('playerName'),
      sub: document.getElementById('playerSub'),
      progress: document.getElementById('progress'),
      buffer: document.getElementById('progressBuffer'),
      played: document.getElementById('progressPlayed'),
      thumb: document.getElementById('progressThumb'),
      tip: document.getElementById('progressTip'),
      tipTime: document.getElementById('progressTipTime'),
      tipImage: document.getElementById('progressTipImage'),
      tipVideo: document.getElementById('progressTipVideo'),
      play: document.getElementById('btnPlay'),
      prev: document.getElementById('btnPrev'),
      next: document.getElementById('btnNext'),
      back10: document.getElementById('btnBack10'),
      fwd10: document.getElementById('btnFwd10'),
      mute: document.getElementById('btnMute'),
      volume: document.getElementById('volumeRange'),
      time: document.getElementById('timeLabel'),
      live: document.getElementById('statLive'),
      subtitles: document.getElementById('btnSubtitles'),
      subtitleMenu: document.getElementById('subtitleMenu'),
      speed: document.getElementById('btnSpeed'),
      speedLabel: document.getElementById('speedLabel'),
      speedMenu: document.getElementById('speedMenu'),
      statsBtn: document.getElementById('btnStats'),
      stats: document.getElementById('statsPanel'),
      loop: document.getElementById('btnLoop'),
      snapshot: document.getElementById('btnSnapshot'),
      pip: document.getElementById('btnPip'),
      fullscreen: document.getElementById('btnFullscreen'),
      download: document.getElementById('btnDownload'),
      close: document.getElementById('btnClose'),
      statBasic: document.getElementById('statBasic'),
    }

    const video = el.video

    /** 当前条目。 */
    const current = () => items[index]

    /** 该条目的可播放地址。 */
    const srcOf = (item) => item?.streamUrl ?? `/reel/stream?k=${encodeURIComponent(item?.key ?? '')}`

    /** 短暂显示一句提示。 */
    const flash = (message) => {
      if (message === undefined || message === null || message === '') return
      el.toast.textContent = String(message)
      el.toast.hidden = false
      clearTimeout(flash.timer)
      flash.timer = setTimeout(() => {
        el.toast.hidden = true
      }, 900)
    }

    /**
     * 让控件在空闲 2.6 秒后淡出，鼠标移动或按键时再出现。
     * 正在播放、菜单已收起时才隐藏，否则控件会在用户操作时突然消失。
     */
    const wake = () => {
      el.player.classList.remove('chrome-hidden')
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        if (video.paused) return
        if (!el.speedMenu.hidden || !el.subtitleMenu.hidden) return
        if (statsOpen) return
        el.player.classList.add('chrome-hidden')
      }, 2600)
    }

    /** 刷新播放/暂停图标与中央大按钮。 */
    const syncPlayState = () => {
      el.player.classList.toggle('is-playing', !video.paused)
      el.player.classList.toggle('show-center', video.paused)
      el.play.setAttribute('aria-label', video.paused ? '播放' : '暂停')
    }

    /** 刷新时间、进度、缓冲与统计行。 */
    const syncProgress = () => {
      const duration = video.duration
      const known = Number.isFinite(duration) && duration > 0
      const ratio = known ? Math.min(video.currentTime / duration, 1) : 0
      el.played.style.width = `${(ratio * 100).toFixed(3)}%`
      el.thumb.style.left = `${(ratio * 100).toFixed(3)}%`
      el.progress.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
      el.time.textContent = `${fmtTime(video.currentTime)} / ${known ? fmtTime(duration) : '--:--'}`
      el.live.hidden = known
      try {
        if (video.buffered.length > 0 && known) {
          // 只把「包含当前播放点的那一段」画成缓冲，跨越 seek 的空洞不会被误报。
          let end = 0
          for (let i = 0; i < video.buffered.length; i += 1) {
            if (video.buffered.start(i) <= video.currentTime + 0.25 && video.buffered.end(i) >= video.currentTime) {
              end = video.buffered.end(i)
              break
            }
          }
          el.buffer.style.width = `${Math.min((end / duration) * 100, 100).toFixed(2)}%`
        }
      } catch {
        /* buffered 在元数据就绪前会抛错 */
      }
      const item = current()
      const parts = []
      if (video.videoWidth > 0) parts.push(`${video.videoWidth}×${video.videoHeight}`)
      if (known) parts.push(fmtTime(duration))
      if (item?.size) parts.push(fmtBytes(item.size))
      el.statBasic.textContent = parts.join(' · ')
    }

    /** 中央提示的收起定时器。提示节点是复用的，定时器也必须只留一个。 */
    let bubbleTimer = null

    /**
     * 中央提示（快进/快退/倍速）。
     *
     * 提示节点**复用同一个**，并挂在 el.center 下——也就是下面查找它的地方。
     *
     * 早先这里查的是 `el.center.querySelector('.bubble-flash')`，但创建时却
     * `el.player.appendChild(node)`：查找的位置和挂载的位置不是同一个元素，于是
     * querySelector 永远返回 null，**每调用一次就新建一个节点**。而定时器只有
     * `bubble.timer` 一个，只记得最后一次创建的那个节点，前面新建出来的那些
     * 再也没有人去改它们的 opacity——连续点几次快进/快退，屏幕上就会留下几个
     * 永远停在 opacity:1 的圆圈。
     */
    const bubble = (glyph) => {
      let node = el.center.querySelector('.bubble-flash')
      if (node === null) {
        node = document.createElement('div')
        node.className = 'slide-center bubble-flash'
        node.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;opacity:0;transition:opacity .2s'
        node.innerHTML = '<div class="bubble"></div>'
        el.center.appendChild(node)
      }
      node.firstChild.textContent = glyph
      node.style.opacity = '1'
      clearTimeout(bubbleTimer)
      bubbleTimer = setTimeout(() => {
        bubbleTimer = null
        node.style.opacity = '0'
      }, 500)
    }

    /** 立刻收起中央提示（换片、退出等场景，避免它留在屏幕上）。 */
    const hideBubble = () => {
      clearTimeout(bubbleTimer)
      bubbleTimer = null
      for (const node of el.center.querySelectorAll('.bubble-flash')) node.style.opacity = '0'
    }

    // ── 进度条悬停预览 ────────────────────────────────────────────────────

    /**
     * 悬停预览用的第二个 video，只用来「定位到某一时刻取静帧」。
     *
     * 为什么不能用主 video 或封面图：
     *  · 主 video 不能动——用户正在看，改它的 currentTime 就是把播放进度拽走；
     *  · 封面图是一个固定 URL，整条进度条上都是同一张，**它不可能反映鼠标位置**，
     *    表现就是「预览图永远是同一帧」。
     * 所以另开一个静音的 video，把它的 currentTime 指到鼠标位置，画面就跟着走。
     *
     * 这一段刻意写在前面：`load()` / `close()` 都会调用 hideTip()，
     * 而这些函数声明在文件后半部分，晚于它们被引用的位置——放在后面会在
     * 打开播放器时踩到「未初始化」的暂时性死区。
     */
    let tipSrc = null
    /** 上一次真正发起 seek 的时刻，用来掐掉过于密集的定位。 */
    let tipSeekAt = 0
    /** 上一次请求定位到的时间点，少于 1% 时长就不重复 seek。 */
    let tipWanted = -1

    /**
     * 把提示图定位到某个时间点。
     *
     * @param {number} seconds - 目标时刻（秒）。
     * @param {string} source - 该媒体的播放地址。
     */
    const aimTipPreview = (seconds, source) => {
      const tip = el.tipVideo
      if (tip === null || source === undefined || source === '') return
      if (tipSrc !== source) {
        tipSrc = source
        tip.src = source
        tipWanted = -1
      }
      // 时长未知时无法按时长取 1% 的容差，就退化成「每 200ms 一次」。
      const gap = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 0.01 : 0
      if (tipWanted >= 0 && Math.abs(seconds - tipWanted) < Math.max(gap, 0.25)) return
      const now = performance.now()
      if (now - tipSeekAt < 90) return
      tipSeekAt = now
      tipWanted = seconds
      try {
        tip.currentTime = seconds
      } catch {
        /* 还没拿到元数据，下一帧再试 */
      }
    }

    /** 收起提示时顺带把预览 video 的来源断掉，别让它在后台继续解码。 */
    const releaseTipPreview = () => {
      const tip = el.tipVideo
      if (tip === null || tipSrc === null) return
      tipSrc = null
      tipWanted = -1
      try {
        tip.removeAttribute('src')
        tip.load()
      } catch {
        /* 忽略 */
      }
    }

    /**
     * 预览 video 真的解码出画面之后，把封面占位图换掉。
     *
     * 只在「已经能画出画面」时才切：提前切会看到一块黑，比放封面难看。
     * `readyState >= 2` 表示当前帧的数据已经到手。
     */
    const onTipFrameReady = () => {
      if (el.tipVideo.readyState < 2) return
      el.tip.classList.add('is-live')
    }

    /** 收起提示（离开进度条、退出播放器、换片）。 */
    const hideTip = () => {
      el.tip.hidden = true
      el.tip.classList.remove('is-live')
      releaseTipPreview()
    }

    /** 应用音量与静音，写回本地偏好。 */
    const applyVolume = (nextVolume, nextMuted) => {
      volume = Math.min(Math.max(nextVolume, 0), 1)
      muted = nextMuted
      video.volume = volume
      video.muted = muted
      el.volume.value = String(volume)
      el.mute.textContent = muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'
      el.mute.classList.toggle('is-on', muted)
      write(LS.volume, volume)
      write(LS.muted, muted)
    }

    /** 应用倍速，写回本地偏好。 */
    const applyRate = (nextRate) => {
      rate = nextRate
      video.playbackRate = rate
      el.speedLabel.textContent = `${rate}×`
      write(LS.rate, rate)
      const button = el.speedMenu.querySelector(`[data-rate="${rate}"]`)
      if (button !== null) {
        for (const other of el.speedMenu.querySelectorAll('button')) other.classList.toggle('is-on', other === button)
      }
    }

    /** 建立倍速菜单。 */
    const buildSpeedMenu = () => {
      el.speedMenu.innerHTML = ''
      for (const value of SPEEDS) {
        const button = document.createElement('button')
        button.type = 'button'
        button.dataset.rate = String(value)
        button.innerHTML = `<span>${value}×</span><span>${value === 1 ? '正常' : ''}</span>`
        button.addEventListener('click', () => {
          applyRate(value)
          el.speedMenu.hidden = true
          flash(`${value}×`)
        })
        el.speedMenu.appendChild(button)
      }
      applyRate(rate)
    }

    /** 建立字幕菜单：关闭 + 每条内嵌/外挂字幕轨道。 */
    const buildSubtitleMenu = () => {
      el.subtitleMenu.innerHTML = ''
      const item = current()
      const tracks = Array.isArray(item?.subtitles) ? item.subtitles : []
      const off = document.createElement('button')
      off.type = 'button'
      off.innerHTML = '<span>关闭字幕</span>'
      off.addEventListener('click', () => {
        for (const track of video.textTracks) track.mode = 'disabled'
        el.subtitleMenu.hidden = true
        el.subtitles.classList.remove('is-on')
      })
      el.subtitleMenu.appendChild(off)
      for (const track of tracks) {
        const button = document.createElement('button')
        button.type = 'button'
        button.innerHTML = `<span>${track.label || track.name}</span>`
        button.addEventListener('click', () => {
          for (const entry of video.textTracks) entry.mode = entry.language === track.name ? 'showing' : 'disabled'
          el.subtitleMenu.hidden = true
          el.subtitles.classList.add('is-on')
        })
        el.subtitleMenu.appendChild(button)
      }
      if (tracks.length === 0) {
        const note = document.createElement('div')
        note.className = 'menu-note'
        note.textContent = '这个文件没有找到同名字幕'
        el.subtitleMenu.appendChild(note)
      }
    }

    /** 用视频自身的时长与尺寸回填卡片，让列表里的角标随后补上。 */
    const rememberMetadata = () => {
      const item = current()
      if (item === undefined || !Number.isFinite(video.duration)) return
      item.duration = video.duration
      item.width = video.videoWidth
      item.height = video.videoHeight
    }

    /** 载入第 n 个条目；inPlace 为 true 时不重新插入 DOM。 */
    const load = (nextIndex, inPlace) => {
      if (items.length === 0) return
      index = ((nextIndex % items.length) + items.length) % items.length
      const item = current()
      if (item === undefined) return
      const audio = item.kind === 'audio'

      video.pause()
      video.removeAttribute('src')
      video.innerHTML = ''
      video.load()
      // 换片时把中央提示收掉：它说的是上一片的跳转量，留着就是错的信息。
      hideBubble()
      // 悬停预览也要断来源，否则它还在后台解码上一片。
      hideTip()
      el.subtitleMenu.innerHTML = ''
      el.subtitles.hidden = !isVideo(item)
      el.subtitles.classList.remove('is-on')

      el.name.textContent = item.name ?? ''
      const sub = []
      if (item.rel) sub.push(item.rel)
      if (item.size) sub.push(fmtBytes(item.size))
      el.sub.textContent = sub.join(' · ')
      document.title = `${item.name ?? '媒体'} · 媒体库`

      if (audio) {
        document.title = `${item.name} · 音频`
      }

      if (isVideo(item)) {
        const verdict = canPlayContainer(item.name, video)
        if (verdict === 'no') {
          flash('这个容器浏览器无法直接解码')
        }
      }

      video.src = srcOf(item)
      video.preload = 'auto'

      // 外挂字幕以 <track> 挂上，浏览器负责时间轴同步。
      for (const track of Array.isArray(item.subtitles) ? item.subtitles : []) {
        const node = document.createElement('track')
        node.kind = 'subtitles'
        node.label = track.label || track.name
        node.srclang = String(track.name).replace(/\.[^.]+$/, '').split('.').slice(1).join('-') || 'zh'
        node.src = track.url
        video.appendChild(node)
      }

      // 进度：有记录就续播，并把起点告诉用户。
      const resumeAt = progressStore.get(item.key)
      const onLoadedMetadata = () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata)
        rememberMetadata()
        const duration = video.duration
        if (resumeAt > 5 && (!Number.isFinite(duration) || resumeAt < duration - 8)) {
          video.currentTime = resumeAt
          flash(`已从 ${fmtTime(resumeAt)} 继续`)
        }
        syncProgress()
        if (options.autoplay !== false && read(LS.autoplay, true)) {
          void play()
        }
      }
      video.addEventListener('loadedmetadata', onLoadedMetadata)
      buildSubtitleMenu()
      syncProgress()
      void inPlace
    }

    /** 播放；自动播放被拒绝时给出可点击的提示而不是静默失败。 */
    const play = async () => {
      try {
        await video.play()
        syncPlayState()
      } catch (error) {
        syncPlayState()
        if (error?.name === 'NotAllowedError') flash('点一下画面开始播放')
        else if (error?.name === 'NotSupportedError') flash('浏览器不支持这个编码')
      }
    }

    const toggle = () => {
      if (video.paused) void play()
      else video.pause()
    }

    /** 相对跳转，负数后退。 */
    const seekBy = (delta) => {
      const duration = video.duration
      const target = video.currentTime + delta
      video.currentTime = Number.isFinite(duration) ? Math.min(Math.max(target, 0), Math.max(duration - 0.05, 0)) : Math.max(target, 0)
      bubble(delta > 0 ? `+${Math.round(delta)}s` : `${Math.round(delta)}s`)
      syncProgress()
    }

    /** 跳到列表里的另一条。 */
    const goto = (nextIndex, reason) => {
      if (items.length === 0) return
      load(nextIndex)
      if (typeof options.onIndexChange === 'function') options.onIndexChange(index, current(), reason)
    }

    // ── 事件绑定 ──────────────────────────────────────────────────────────

    const onProgressClick = (event) => {
      const duration = video.duration
      if (!Number.isFinite(duration) || duration <= 0) return
      const rect = el.progress.getBoundingClientRect()
      const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
      video.currentTime = ratio * duration
      syncProgress()
      wake()
    }

    const onProgressHover = (event) => {
      const duration = video.duration
      const rect = el.progress.getBoundingClientRect()
      const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1)
      if (!Number.isFinite(duration) || duration <= 0) {
        hideTip()
        return
      }
      el.tip.hidden = false
      el.tip.style.left = `${ratio * 100}%`
      const seconds = ratio * duration
      el.tipTime.textContent = fmtTime(seconds)
      // 封面图先顶上，它解码快、且已经有缓存；真正的画面由预览 video 定位后盖上。
      const item = current()
      if (item?.thumbUrl) {
        el.tipImage.hidden = false
        if (el.tipImage.getAttribute('src') !== item.thumbUrl) el.tipImage.src = item.thumbUrl
      } else {
        el.tipImage.hidden = true
      }
      aimTipPreview(seconds, srcOf(item))
    }

    const onKeyDown = (event) => {
      if (el.player.hidden) return
      const target = event.target
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const handled = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      switch (event.key) {
        case ' ':
        case 'k':
        case 'K':
          handled()
          toggle()
          break
        case 'ArrowLeft':
          handled()
          seekBy(-5)
          break
        case 'ArrowRight':
          handled()
          seekBy(5)
          break
        case 'j':
        case 'J':
          handled()
          seekBy(-10)
          break
        case 'l':
        case 'L':
          handled()
          seekBy(10)
          break
        case 'ArrowUp':
          handled()
          applyVolume(volume + 0.05, false)
          flash(`音量 ${Math.round(volume * 100)}%`)
          break
        case 'ArrowDown':
          handled()
          applyVolume(volume - 0.05, false)
          flash(`音量 ${Math.round(volume * 100)}%`)
          break
        case 'm':
        case 'M':
          handled()
          applyVolume(volume, !muted)
          flash(muted ? '已静音' : '取消静音')
          break
        case 'f':
        case 'F':
          handled()
          toggleFullscreen()
          break
        case 'q':
        case 'Q':
          handled()
          void togglePip()
          break
        case 'c':
        case 'C':
          handled()
          el.subtitleMenu.hidden = !el.subtitleMenu.hidden
          if (!el.subtitleMenu.hidden) buildSubtitleMenu()
          break
        case 'i':
        case 'I':
          handled()
          toggleStats()
          break
        case 'u':
        case 'U':
          handled()
          toggleLoop()
          break
        case 'p':
        case 'P':
          handled()
          void snapshot()
          break
        case 'd':
        case 'D':
          handled()
          download()
          break
        case '[':
          handled()
          applyRate(SPEEDS[Math.max(SPEEDS.indexOf(rate) - 1, 0)] ?? 1)
          flash(`${rate}×`)
          break
        case ']':
          handled()
          applyRate(SPEEDS[Math.min(SPEEDS.indexOf(rate) + 1, SPEEDS.length - 1)] ?? 1)
          flash(`${rate}×`)
          break
        case '0':
          handled()
          applyRate(1)
          break
        case 'Home':
          handled()
          video.currentTime = 0
          break
        case 'End':
          handled()
          if (Number.isFinite(video.duration)) video.currentTime = Math.max(video.duration - 0.1, 0)
          break
        case 'Escape':
          handled()
          if (!el.subtitleMenu.hidden) {
            el.subtitleMenu.hidden = true
            break
          }
          if (!el.speedMenu.hidden) {
            el.speedMenu.hidden = true
            break
          }
          if (statsOpen) {
            toggleStats()
            break
          }
          if (document.fullscreenElement !== null) void document.exitFullscreen()
          else api.close()
          break
        default:
          break
      }
      wake()
    }

    /** 全屏切换，优先让整个播放器浮层全屏，控件才不会被裁掉。 */
    const toggleFullscreen = () => {
      if (document.fullscreenElement !== null) {
        void document.exitFullscreen()
        return
      }
      const target = el.player
      const request = target.requestFullscreen?.bind(target)
      if (request === undefined) {
        flash('这个浏览器不支持全屏')
        return
      }
      request({ navigationUI: 'hide' }).catch(() => flash('全屏被拒绝'))
    }

    /** 画中画。 */
    const togglePip = async () => {
      try {
        if (document.pictureInPictureElement !== null) await document.exitPictureInPicture()
        else if (document.pictureInPictureEnabled) await video.requestPictureInPicture()
        else flash('这个浏览器不支持画中画')
      } catch {
        flash('画中画不可用')
      }
    }

    /** 单曲循环。 */
    const toggleLoop = () => {
      loopOne = !loopOne
      video.loop = loopOne
      el.loop.classList.toggle('is-on', loopOne)
      write(LS.loop, loopOne)
      flash(loopOne ? '单个循环开' : '单个循环关')
    }

    /** 播放统计面板。 */
    const toggleStats = () => {
      statsOpen = !statsOpen
      el.stats.hidden = !statsOpen
      el.statsBtn.classList.toggle('is-on', statsOpen)
      if (statsOpen) void refreshStats()
    }

    /** 采集一次播放质量数据。 */
    const refreshStats = async () => {
      if (!statsOpen) return
      const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null
      const item = current()
      const lines = [
        `文件      ${item?.name ?? '-'}`,
        `相对路径  ${item?.rel ?? '-'}`,
        `容器      ${item?.kind === 'audio' ? '音频' : '视频'}  大小 ${fmtBytes(item?.size ?? 0)}`,
        `画面      ${video.videoWidth}×${video.videoHeight}${video.videoHeight > 0 ? `  ${(video.videoWidth / video.videoHeight).toFixed(3)}:1` : ''}`,
        `时长      ${Number.isFinite(video.duration) ? `${video.duration.toFixed(2)}s` : '未知（可能是流）'}`,
        `播放位置  ${video.currentTime.toFixed(2)}s`,
        `缓冲区间  ${bufferedRanges()}`,
        `倍速/音量 ${rate}×  ${Math.round(volume * 100)}%${muted ? ' (静音)' : ''}`,
        `解码      ${video.readyState}/4  ${['', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][video.readyState] ?? ''}`,
        quality === null ? '质量统计  该浏览器不提供' : `已解码帧  ${quality.totalVideoFrames}`,
        quality === null ? '' : `丢帧      ${quality.droppedVideoFrames}${quality.totalVideoFrames > 0 ? `（${((quality.droppedVideoFrames / quality.totalVideoFrames) * 100).toFixed(2)}%）` : ''}`,
        `网络      ${networkLabel()}`,
        `流地址    ${srcOf(item ?? {})}`,
      ]
      el.stats.textContent = lines.filter((line) => line !== '').join('\n')
    }

    /** 缓冲区间摘要。 */
    const bufferedRanges = () => {
      const parts = []
      try {
        for (let i = 0; i < video.buffered.length; i += 1) {
          parts.push(`${fmtTime(video.buffered.start(i))}–${fmtTime(video.buffered.end(i))}`)
        }
      } catch {
        return '-'
      }
      return parts.length === 0 ? '-' : parts.join('  ')
    }

    /** 从 Resource Timing 里读这次媒体请求的实际传输情况。 */
    const networkLabel = () => {
      try {
        const entries = performance.getEntriesByName(video.currentSrc, 'resource')
        const last = entries[entries.length - 1]
        if (last === undefined) return '尚无记录'
        return `${fmtBytes(last.transferSize || last.encodedBodySize)} / ${Math.round(last.duration)}ms`
      } catch {
        return '不可读'
      }
    }

    /** 截取当前帧，同时把时间戳写进文件名。 */
    const snapshot = async () => {
      if (!isVideo(current()) || video.videoWidth === 0) {
        flash('当前没有可截取的画面')
        return
      }
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const context = canvas.getContext('2d')
      if (context === null) {
        flash('无法创建画布')
        return
      }
      try {
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
        if (blob === null) {
          flash('截图失败')
          return
        }
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        const stem = String(current()?.name ?? 'frame').replace(/\.[^.]+$/, '')
        anchor.href = url
        anchor.download = `${stem}@${fmtTime(video.currentTime).replace(/:/g, '-')}.png`
        anchor.click()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
        flash('已保存当前帧')
      } catch {
        // 跨源视频会污染画布；这里的流是同源，所以只在异常路径上提示。
        flash('截图被浏览器拒绝')
      }
    }

    /** 下载原文件。 */
    const download = () => {
      const item = current()
      if (item === undefined) return
      const anchor = document.createElement('a')
      anchor.href = `/reel/download?k=${encodeURIComponent(item.key)}`
      anchor.download = item.name ?? 'download'
      anchor.click()
      flash('开始下载')
    }

    // ── 媒体事件 ──────────────────────────────────────────────────────────

    const bind = () => {
      video.addEventListener('play', syncPlayState)
      video.addEventListener('pause', () => {
        syncPlayState()
        saveProgress()
        el.player.classList.remove('chrome-hidden')
      })
      video.addEventListener('timeupdate', () => {
        if (!scrubbing) syncProgress()
        saveProgress()
        if (statsOpen) void refreshStats()
      })
      video.addEventListener('progress', syncProgress)
      video.addEventListener('durationchange', syncProgress)
      video.addEventListener('loadedmetadata', () => {
        rememberMetadata()
        syncProgress()
      })
      video.addEventListener('waiting', () => {
        el.spinner.hidden = false
      })
      video.addEventListener('playing', () => {
        el.spinner.hidden = true
      })
      video.addEventListener('canplay', () => {
        el.spinner.hidden = true
      })
      video.addEventListener('ended', () => {
        saveProgress(true)
        // 播完自动跳下一条，这是「连续播放」的基本预期。
        goto(index + 1, 'ended')
      })
      video.addEventListener('error', () => {
        el.spinner.hidden = true
        const code = video.error?.code
        const message =
          code === 1 ? '播放被中止'
          : code === 2 ? '网络读取失败'
          : code === 3 ? '解码失败：这个编码浏览器可能不支持'
          : code === 4 ? '源不可播放：容器或编码不受支持'
          : '播放失败'
        flash(message)
      })
      video.addEventListener('ratechange', () => {
        el.speedLabel.textContent = `${video.playbackRate}×`
      })

      el.play.addEventListener('click', toggle)
      el.bigPlay.addEventListener('click', toggle)
      el.prev.addEventListener('click', () => goto(index - 1, 'prev'))
      el.next.addEventListener('click', () => goto(index + 1, 'next'))
      el.back10.addEventListener('click', () => seekBy(-10))
      el.fwd10.addEventListener('click', () => seekBy(10))
      el.mute.addEventListener('click', () => {
        applyVolume(volume, !muted)
        flash(muted ? '已静音' : '取消静音')
      })
      el.volume.addEventListener('input', () => applyVolume(Number(el.volume.value), Number(el.volume.value) === 0))
      el.speed.addEventListener('click', () => {
        el.speedMenu.hidden = !el.speedMenu.hidden
        el.subtitleMenu.hidden = true
      })
      el.subtitles.addEventListener('click', () => {
        buildSubtitleMenu()
        el.subtitleMenu.hidden = !el.subtitleMenu.hidden
        el.speedMenu.hidden = true
      })
      el.statsBtn.addEventListener('click', toggleStats)
      el.loop.addEventListener('click', toggleLoop)
      el.snapshot.addEventListener('click', () => void snapshot())
      el.pip.addEventListener('click', () => void togglePip())
      el.fullscreen.addEventListener('click', toggleFullscreen)
      el.download.addEventListener('click', download)
      el.close.addEventListener('click', () => api.close())

      // 进度条拖动。触摸端浏览器随时可能因为系统手势甩一个 pointercancel
      // 过来，所以除了 pointerup，还要挂 cancel 和一个窗口级的兜底：漏掉
      // 任何一次，「正在拖动」的标记就会永久留在打开状态，时间轴再也不更新。
      const endScrub = (event) => {
        if (!scrubbing) return
        scrubbing = false
        if (event !== undefined) {
          try {
            el.progress.releasePointerCapture?.(event.pointerId)
          } catch {
            /* 指针已经消失 */
          }
        }
      }
      el.progress.addEventListener('pointerdown', (event) => {
        scrubbing = true
        el.progress.setPointerCapture?.(event.pointerId)
        onProgressClick(event)
        wake()
      })
      el.progress.addEventListener('pointerup', (event) => {
        onProgressClick(event)
        endScrub(event)
      })
      el.progress.addEventListener('pointercancel', endScrub)
      // 拖到进度条外面松手时 pointerup 不会落在进度条上，靠窗口兜底。
      window.addEventListener('pointerup', endScrub)
      window.addEventListener('blur', () => endScrub())
      el.progress.addEventListener('pointermove', (event) => {
        onProgressHover(event)
        if (scrubbing) onProgressClick(event)
      })
      el.progress.addEventListener('pointerleave', () => {
        hideTip()
      })
      // 预览 video 解出画面后再盖掉封面占位图。
      el.tipVideo.addEventListener('loadeddata', onTipFrameReady)
      el.tipVideo.addEventListener('seeked', onTipFrameReady)
      el.tipVideo.addEventListener('error', () => {
        // 这个容器浏览器解不了（或流开不出来）时退回封面图，别留一块黑。
        el.tip.classList.remove('is-live')
      })
      el.progress.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') seekBy(5)
        else if (event.key === 'ArrowLeft') seekBy(-5)
        else return
        event.preventDefault()
      })

      el.player.addEventListener('pointermove', wake)
      el.player.addEventListener('pointerdown', wake)
      // 长按画面 = 2 倍速快进，鼠标上很顺手。触摸端不做：手指按住本来就会
      // 触发系统的选择/调用菜单，而且手机上「按住画面」的直觉是暂停。
      el.player.addEventListener('pointerdown', (event) => {
        if (event.pointerType !== 'mouse') return
        if (event.button !== 0) return
        if (event.target !== video) return
        video.dataset.holdRate = '1'
        video.playbackRate = rate * 2
        flash('2× 快进中')
      })
      el.player.addEventListener('pointerup', () => {
        if (video.dataset.holdRate !== undefined) {
          delete video.dataset.holdRate
          video.playbackRate = rate
        }
      })
      el.player.addEventListener('dblclick', (event) => {
        if (event.target === video) toggleFullscreen()
      })
      el.video.addEventListener('click', toggle)

      document.addEventListener('keydown', onKeyDown, true)
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveProgress()
      })
      window.addEventListener('beforeunload', () => saveProgress())
      window.addEventListener('resize', syncProgress)
    }

    /** 记录观看进度，节流到每 5 秒一次。 */
    const saveProgress = (force) => {
      const item = current()
      if (item === undefined) return
      const now = Math.floor(video.currentTime)
      if (now === lastSaved && force !== true) return
      lastSaved = now
      progressStore.set(item.key, now)
    }

    // ── 生命周期 ──────────────────────────────────────────────────────────

    const api = {
      /** 打开第 index 个条目。 */
      open(nextItems, nextIndex) {
        if (Array.isArray(nextItems) && nextItems.length > 0) items = nextItems.slice()
        index = Number.isInteger(nextIndex) ? nextIndex : index
        el.player.hidden = false
        el.spinner.hidden = true
        buildSpeedMenu()
        applyVolume(volume, muted)
        video.loop = loopOne
        el.loop.classList.toggle('is-on', loopOne)
        load(index)
        wake()
        syncPlayState()
      },

      /** 关闭浮层并清理播放状态，避免音轨在后台继续跑。 */
      close() {
        if (destroyed) return
        saveProgress(true)
        video.pause()
        video.removeAttribute('src')
        video.load()
        // 提示是「给这一次播放看的」，退出时收掉，免得下次打开还挂着。
        hideBubble()
        hideTip()
        el.player.hidden = true
        document.title = '媒体库 · dsh-reel'
        if (document.fullscreenElement !== null) void document.exitFullscreen()
        if (document.pictureInPictureElement !== null) void document.exitPictureInPicture()
        if (typeof options.onClose === 'function') options.onClose(index)
      },

      next() {
        goto(index + 1, 'next')
      },

      prev() {
        goto(index - 1, 'prev')
      },

      /** 直接播放下标；供刷视频模式点「播放」时调用。 */
      playIndex(nextItems, nextIndex) {
        api.open(nextItems, nextIndex)
      },

      isOpen() {
        return !el.player.hidden
      },

      /** 当前条目，供宿主刷新播放列表时定位。 */
      currentItem() {
        return current()
      },

      /** 更换播放列表但保留当前条目。 */
      replaceItems(nextItems) {
        if (!Array.isArray(nextItems)) return
        items = nextItems.slice()
      },

      destroy() {
        destroyed = true
        saveProgress(true)
        document.removeEventListener('keydown', onKeyDown, true)
        video.pause()
        video.removeAttribute('src')
      },
    }

    bind()
    return api
  }
})()
