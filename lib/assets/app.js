/*
 * dsh-reel — 页面逻辑。
 *
 * 两种模式共用一份「条目」数据：列表模式把它画成网格或列表，刷视频模式把它
 * 画成一屏一条的纵向流。两种模式都从 host 的 JSON 接口取数据，媒体字节统一
 * 走 /reel/stream 的范围响应。
 *
 * 交互约定：所有网络失败都变成一句可读的提示，不留空白页；目录配置只有一份
 * 真相（host 的 reel 设置命名空间），页面只是它的一层编辑器。
 */
(() => {
  'use strict'

  const root = (window.Reel = window.Reel || {})
  const { toast, fmtTime, fmtBytes, progressStore, createPlayer } = root

  const BASE = '/reel'
  const $ = (id) => document.getElementById(id)

  const el = {
    body: document.body,
    search: $('searchInput'),
    viewToggle: $('viewToggle'),
    sortToggle: $('sortToggle'),
    refresh: $('refreshBtn'),
    settings: $('settingsBtn'),
    tree: $('tree'),
    crumbs: $('crumbs'),
    summary: $('summary'),
    folders: $('folders'),
    grid: $('grid'),
    content: $('content'),
    more: $('more'),
    empty: $('empty'),
    sidebar: $('sidebar'),
    sidebarRail: $('sidebarRail'),
    collapseSidebar: $('collapseSidebar'),
    sidebarResizer: $('sidebarResizer'),
    feedAll: $('feedAllBtn'),
    feedPane: $('feedPane'),
    feedScroller: $('feedScroller'),
    feedEmpty: $('feedEmpty'),
    feedScope: $('feedScope'),
    feedProgress: $('feedProgress'),
    feedMute: $('feedMute'),
    feedMore: $('feedMore'),
    feedExit: $('feedExit'),
    viewer: $('viewer'),
    viewerStage: $('viewerStage'),
    viewerImage: $('viewerImage'),
    viewerMeta: $('viewerMeta'),
    imagePrev: $('imagePrev'),
    imageNext: $('imageNext'),
    imageZoomIn: $('imageZoomIn'),
    imageZoomOut: $('imageZoomOut'),
    imageZoomReset: $('imageZoomReset'),
    imageDownload: $('imageDownload'),
    imageClose: $('imageClose'),
    drawer: $('drawer'),
    drawerClose: $('drawerClose'),
    drawerNote: $('drawerNote'),
    drawerStatus: $('drawerStatus'),
    drawerReload: $('drawerReload'),
    rootList: $('rootList'),
    rootAdd: $('rootAdd'),
    rootInput: $('rootInput'),
    rootError: $('rootError'),
    pickerUp: $('pickerUp'),
    pickerPath: $('pickerPath'),
    pickerList: $('pickerList'),
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  const state = {
    /** 会话信息：可用根目录与能力位。 */
    session: null,
    /** 当前模式的目录键；'' 表示第一个根目录。 */
    key: '',
    /** 列表模式数据。 */
    listing: null,
    /** 当前网格里的媒体条目（已过滤、已排序）。 */
    media: [],
    /** 刷视频模式的条目流。 */
    feedItems: [],
    feedLoaded: 0,
    feedTruncated: false,
    feedSources: [],
    /** 搜索词，只作用于当前目录。 */
    filter: '',
    /** 排序：new / old / name / size / kind。 */
    sort: localStorage.getItem('mv.sort') ?? 'new',
    /** 视图：grid / list。 */
    view: localStorage.getItem('mv.view') ?? 'grid',
    /** 列出范围：dir（当前这一层）或 all（递归所有层级，且不显示文件夹）。 */
    scope: localStorage.getItem('mv.scope') ?? 'dir',
    /** 列出内容：all（图片+视频）或 video（只看视频）。 */
    kinds: localStorage.getItem('mv.kinds') ?? 'all',
    /** 分组方式：flat（直接平铺）或 folder（每个子文件夹一张卡片）。 */
    group: localStorage.getItem('mv.group') ?? 'flat',
    /** all 模式的递归扫描结果，按扫描出的条目缓存。 */
    scanned: [],
    scannedKey: null,
    scannedTruncated: false,
    /** 刷取范围：folder（当前目录递归）或 root（整棵根目录）。 */
    feedScope: localStorage.getItem('mv.feedScope') ?? 'folder',
  }

  /** 根目录键（'' → 第一个根）。 */
  const rootKeyOf = (key) => String(key ?? '').replace(/^r(\d+).*$/, 'r$1')

  const currentRoot = () => {
    const index = Number(rootKeyOf(state.key).slice(1)) || 0
    return state.session?.roots?.find((item) => item.index === index) ?? state.session?.roots?.[0] ?? null
  }

  // ── 网络 ────────────────────────────────────────────────────────────────

  /** 统一的 JSON 请求；失败时抛出带可读信息或携带 status 的错误。 */
  const api = async (path, options) => {
    const response = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, ...options })
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new Error(`服务返回了非 JSON 内容（HTTP ${response.status}）`)
    }
    return { ok: response.ok, status: response.status, payload }
  }

  /**
   * 包一层：任何未捕获的失败都变成一句提示。
   *
   * 这里**刻意不做任何加载指示**。原来每次拉数据都会亮一个半透明全屏遮罩 +
   * 转圈，而页面本来就有懒加载的封面、静默续页、以及秒级返回的接口——遮罩
   * 只是不停地闪，纯属干扰。数据慢就慢，画面保持可用。
   */
  const guard = async (label, task) => {
    try {
      return await task()
    } catch (error) {
      toast(`${label}失败：${error?.message ?? error}`, 'error')
      return undefined
    }
  }

  // ── 通用渲染 ────────────────────────────────────────────────────────────

  const clear = (node) => {
    while (node.firstChild !== null) node.removeChild(node.firstChild)
  }

  const button = (className, label, onClick) => {
    const node = document.createElement('button')
    node.type = 'button'
    node.className = className
    if (label !== undefined) node.textContent = label
    if (onClick !== undefined) node.addEventListener('click', onClick)
    return node
  }

  /** 媒体条目的比较器。 */
  const comparators = {
    new: (left, right) => right.mtimeMs - left.mtimeMs,
    old: (left, right) => left.mtimeMs - right.mtimeMs,
    name: (left, right) => String(left.name).localeCompare(String(right.name), 'zh-Hans-CN', { numeric: true }),
    size: (left, right) => right.size - left.size,
    kind: (left, right) => String(left.kind).localeCompare(String(right.kind)) || String(left.name).localeCompare(String(right.name), 'zh-Hans-CN', { numeric: true }),
  }

  const sortLabel = { new: '最新优先', old: '最旧优先', name: '名称', size: '体积', kind: '类型' }

  // ── 列表模式 ────────────────────────────────────────────────────────────

  /**
   * 载入当前目录。
   *
   * 两个范围共用同一次载入：`dir` 取这一层（文件 + 文件夹），`all` 递归取
   * 所有层级（只要文件）。两者都先拿一次 `list`，因为递归模式也需要它来画
   * 面包屑和根目录信息。
   */
  const loadListing = async () => {
    const payload = await guard('载入目录', async () => {
      const result = await api(`/api/list?k=${encodeURIComponent(state.key)}`)
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) {
      state.listing = null
      state.media = []
      renderAll()
      return
    }
    state.listing = payload
    if (payload.key !== state.key) {
      // host 把目录地址规范化过（例如去掉了尾部斜杠），以它为准。
      state.key = payload.key
    }
    if (state.scope === 'all') {
      await loadScanned(payload.key)
    } else {
      state.scanned = []
      state.scannedKey = null
      state.scannedTruncated = false
    }
    recomputeMedia()
    renderAll()
  }

  /**
   * 递归取这个目录下的所有文件。
   *
   * 只在这一个模式下发生，并且按 key 缓存：在「本目录 / 全部」之间来回切
   * 不会重复扫盘。扫描上限由服务端约束，超出时返回截断标记。
   *
   * @param {string} key - 要递归扫描的目录键。
   */
  const loadScanned = async (key) => {
    if (state.scannedKey === key && state.scanned.length > 0) return
    const payload = await guard('扫描子目录', async () => {
      const result = await api(`/api/scan?k=${encodeURIComponent(key)}&kinds=image,video,audio&limit=3000&depth=24`)
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return
    state.scanned = payload.items ?? []
    state.scannedKey = key
    state.scannedTruncated = payload.truncated === true
  }

  /** 过滤 + 排序出当前要画的媒体列表。 */
  const recomputeMedia = () => {
    const source = state.scope === 'all' ? state.scanned : state.listing?.files ?? []
    const needle = state.filter.trim().toLowerCase()
    const byKind =
      state.kinds === 'video'
        ? source.filter((item) => item.kind === 'video')
        : source.filter((item) => item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')
    const filtered = needle === '' ? byKind : byKind.filter((item) => String(item.name).toLowerCase().includes(needle))
    state.media = filtered.slice().sort(comparators[state.sort] ?? comparators.new)
  }

  /**
   * 重新画整个列表模式。
   *
   * **不含目录树。** 目录树和右边这个列表是两件独立的事：树只在「配置的目录
   * 变了」时建一次，之后只有折展和高亮会动它。早先这里调了 renderTree()，于是
   * 右边每加载一次列表（切目录、切范围、翻页）就顺带重画一遍左树——用户看到的
   * 就是「左边的树随着右边的列表一起在加载」。树的加载由它自己的入口负责：
   * 根建好时各拉一次自己的子目录，此后不再自动重来。
   */
  const renderAll = () => {
    renderCrumbs()
    renderSummary()
    renderFolders()
    renderGrid()
    renderMore()
    // 只有「当前目录是哪一行」需要跟着导航走，那是一个 class。
    syncTreeActive()
  }

  const renderCrumbs = () => {
    clear(el.crumbs)
    const listing = state.listing
    if (listing === null) return
    if (state.scope === 'all') {
      // 递归模式下当前位置不再是一个目录，用「根 + 全部层级」表达。
      const rootCrumb = button('crumb', listing.root.label, () => navigate(listing.key))
      rootCrumb.title = listing.root.path
      const sep = document.createElement('span')
      sep.className = 'crumb-sep'
      sep.textContent = '/'
      const all = document.createElement('span')
      all.className = 'crumb is-current'
      all.textContent = '全部层级'
      el.crumbs.append(rootCrumb, sep, all)
      return
    }
    const crumbs = [{ key: listing.key, name: listing.root.label }, ...(listing.crumbs ?? []).slice(1)]
    crumbs.forEach((crumb, index) => {
      if (index > 0) {
        const sep = document.createElement('span')
        sep.className = 'crumb-sep'
        sep.textContent = '/'
        el.crumbs.appendChild(sep)
      }
      const node = button(`crumb${index === crumbs.length - 1 ? ' is-current' : ''}`, crumb.name, () => navigate(crumb.key))
      node.title = crumb.name
      el.crumbs.appendChild(node)
    })
  }

  const renderSummary = () => {
    const listing = state.listing
    if (listing === null) {
      el.summary.textContent = ''
      return
    }
    const parts = []
    if (state.scope === 'all') {
      parts.push(`${state.media.length} 个${state.kinds === 'video' ? '视频' : '媒体文件'}（含所有子目录）`)
      if (state.scannedTruncated) parts.push('已达上限，仅显示一部分')
    } else {
      parts.push(`${listing.folders?.length ?? 0} 个文件夹`)
      parts.push(`${state.kinds === 'video' ? listing.files?.filter((item) => item.kind === 'video').length ?? 0 : listing.fileCount} 个${state.kinds === 'video' ? '视频' : '媒体文件'}`)
    }
    if (state.filter.trim() !== '') parts.push(`筛选出 ${state.media.length} 个`)
    parts.push(`排序：${sortLabel[state.sort] ?? state.sort}`)
    el.summary.textContent = parts.join(' · ')
  }

  /** 子文件夹：一行一个，紧凑可扫；递归模式下整块不显示。 */
  const renderFolders = () => {
    clear(el.folders)
    if (state.scope === 'all') return
    const folders = state.listing?.folders ?? []
    for (const folder of folders) {
      const row = document.createElement('div')
      row.className = `folder-row${folder.hidden ? ' is-hidden' : ''}`
      row.tabIndex = 0
      row.title = folder.name
      row.setAttribute('role', 'button')

      const icon = document.createElement('span')
      icon.className = 'ico'
      icon.textContent = '📁'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = folder.name
      const chev = document.createElement('span')
      chev.className = 'chev'
      chev.textContent = '›'
      row.append(icon, name, chev)

      const open = () => navigate(folder.key)
      row.addEventListener('click', open)
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      })
      el.folders.appendChild(row)
    }
  }

  /** 视频元数据探测器：卡片进入视口时才建 <video>，避免一次性打满请求。 */
  const cardProbes = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      cardProbes.unobserve(entry.target)
      entry.target.probe?.()
    }
  }, { rootMargin: '400px' })

  // ── 元数据批量探测 ───────────────────────────────────────────────────────
  //
  // 一次 ffprobe 要起一个进程，逐个文件问会让一屏卡片打出一串请求。这里把
  // 视野内的条目攒成一批（最多 200）再发，服务端也在那边限并发。

  /** 服务端有没有 ffprobe；没有就退回浏览器自己的 metadata 预读。 */
  let probeCapability = null
  const probingAvailable = () => probeCapability === true
  /** 服务端能不能生成悬停动画（需要 ffmpeg）。 */
  let previewCapability = null
  /** 服务端的生成配方版本，用来给悬停动画 URL 加缓存后缀；来自 /api/session。 */
  let previewVersion = '1'
  /** 待探测的条目，key → item，便于回填。 */
  const probeQueue = new Map()
  /** 已问过的 key，避免来回滚动反复请求。 */
  const probedKeys = new Set()
  let probeTimer = 0

  /** 把一条媒体排进批量探测队列。 */
  const queueProbe = (item) => {
    if (probedKeys.has(item.key)) return
    probeQueue.set(item.key, item)
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => void flushProbes(), 120)
  }

  /** 发出这一批探测请求，并把结果写回条目与卡片。 */
  const flushProbes = async () => {
    if (probeQueue.size === 0) return
    const batch = [...probeQueue.entries()].slice(0, 200)
    for (const [key] of batch) {
      probeQueue.delete(key)
      probedKeys.add(key)
    }
    const payload = await guard('读取视频信息', async () => {
      const result = await api('/api/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keys: batch.map(([key]) => key) }),
      })
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return
    for (const [key, item] of batch) {
      const meta = payload.results?.[key]
      if (meta === undefined) continue
      if (meta.duration !== undefined) item.duration = meta.duration
      if (meta.width !== undefined) {
        item.width = meta.width
        item.height = meta.height
      }
      refreshCard(key)
    }
    if (probeQueue.size > 0) probeTimer = setTimeout(() => void flushProbes(), 120)
  }

  /** 按 key 找到已渲染的卡片并刷新它的派生显示。 */
  const refreshCard = (key) => {
    const card = el.grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`)
    card?.applyMeta?.()
  }

  /** 媒体卡片：图片直接懒加载，视频先显示元数据徽标。 */
  const buildCard = (item, index, options = {}) => {
    const compact = options.compact === true
    const card = document.createElement('article')
    card.className = `card card-${item.kind}${compact ? ' is-compact' : ''}`
    card.dataset.index = String(index)
    card.dataset.key = item.key
    card.tabIndex = 0

    const media = document.createElement('div')
    media.className = 'card-media'

    const image = document.createElement('img')
    image.alt = item.name
    image.loading = 'lazy'
    image.decoding = 'async'
    image.addEventListener('load', () => {
      image.classList.add('is-loaded')
    }, { once: true })
    image.addEventListener('error', () => {
      // 拿不到封面就退成图标，但**不做任何加载指示**：静默换掉就好。
      image.remove()
      media.classList.add('no-poster')
      const fallback = document.createElement('div')
      fallback.className = 'poster-fallback'
      fallback.textContent = item.kind === 'video' ? '🎬' : item.kind === 'audio' ? '♪' : '🖼️'
      media.appendChild(fallback)
    })
    // 有封面就用封面（服务端取视频中间帧），否则退回范围流：浏览器只为
    // 第一帧取它需要的字节，不会下载整集。
    image.src = item.thumbUrl ?? item.streamUrl ?? ''
    if (image.src === '') media.classList.add('no-poster')
    media.appendChild(image)

    const badge = document.createElement('span')
    badge.className = 'kind-badge'
    badge.textContent = item.kind === 'video' ? '▶ 视频' : item.kind === 'audio' ? '♪ 音频' : '🖼 图片'
    media.appendChild(badge)

    const duration = document.createElement('span')
    duration.className = 'duration-badge'
    if (item.duration !== undefined) duration.textContent = fmtTime(item.duration)
    duration.hidden = item.duration === undefined
    media.appendChild(duration)

    if (item.kind === 'video' || item.kind === 'audio') {
      const overlay = document.createElement('div')
      overlay.className = 'play-overlay'
      overlay.innerHTML = '<span class="ring"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg></span>'
      media.appendChild(overlay)
    }

    card.appendChild(media)

    const info = document.createElement('div')
    info.className = 'card-info'
    const name = document.createElement('div')
    name.className = 'card-name'
    name.textContent = item.name
    name.title = item.rel
    const meta = document.createElement('div')
    meta.className = 'card-meta'
    meta.textContent = `${fmtBytes(item.size)} · ${new Date(item.mtimeMs).toLocaleString()}`
    info.append(name, meta)

    // 递归模式下列表是混在一起的，必须告诉用户这是哪一层来的文件。
    if (state.scope === 'all') {
      const parent = String(item.rel).split('/').slice(0, -1).join('/')
      if (parent !== '') {
        const where = document.createElement('div')
        where.className = 'card-where'
        where.textContent = parent
        where.title = parent
        where.addEventListener('click', (event) => {
          event.stopPropagation()
          navigate(`r${item.root}/${parent.split('/').map(encodeURIComponent).join('/')}`)
        })
        info.appendChild(where)
      }
    }
    card.appendChild(info)

    let side = null
    if (state.view === 'list') {
      side = document.createElement('div')
      side.className = 'card-side'
      side.textContent = item.duration ? `${fmtTime(item.duration)} · ${fmtBytes(item.size)}` : fmtBytes(item.size)
      card.appendChild(side)
    }

    const saved = item.kind === 'video' || item.kind === 'audio' ? progressStore.get(item.key) : 0
    let progressFill = null
    if (saved > 0) {
      const bar = document.createElement('div')
      bar.className = 'card-progress'
      progressFill = document.createElement('i')
      bar.appendChild(progressFill)
      media.appendChild(bar)
    }

    /**
     * 元数据到达后统一刷新卡片上的派生显示。
     *
     * 三个来源都走这里：服务端的批量 ffprobe、浏览器自己的 metadata 预读、
     * 以及播放器回填。写在一处才不会出现「时长显示了但进度条没更新」。
     */
    const applyMeta = () => {
      if (item.duration !== undefined) {
        duration.textContent = fmtTime(item.duration)
        duration.hidden = false
      }
      const bits = [fmtBytes(item.size)]
      if (item.width > 0 && item.height > 0) bits.push(`${item.width}×${item.height}`)
      else bits.push(new Date(item.mtimeMs).toLocaleString())
      meta.textContent = bits.join(' · ')
      if (side !== null) side.textContent = item.duration ? `${fmtTime(item.duration)} · ${fmtBytes(item.size)}` : fmtBytes(item.size)
      if (progressFill !== null && item.duration) {
        progressFill.style.width = `${Math.min((saved / item.duration) * 100, 100).toFixed(1)}%`
      }
    }
    card.applyMeta = applyMeta
    if (item.duration !== undefined) applyMeta()

    if (item.kind === 'video' || item.kind === 'audio') {
      card.probe = () => {
        if (card.dataset.probed === '1') return
        card.dataset.probed = '1'
        // 优先问服务端（MKV 之类的容器浏览器根本打不开，只有 ffprobe 知道），
        // 没有 ffprobe 时退回浏览器自己的 metadata 预读。
        if (probingAvailable()) {
          queueProbe(item)
          return
        }
        const reader = document.createElement('video')
        reader.preload = 'metadata'
        reader.muted = true
        reader.src = item.streamUrl
        reader.addEventListener('loadedmetadata', () => {
          item.duration = reader.duration
          item.width = reader.videoWidth
          item.height = reader.videoHeight
          applyMeta()
          reader.removeAttribute('src')
          reader.load()
        }, { once: true })
      }
      cardProbes.observe(card)
    }

    const open = () => {
      if (item.kind === 'image') openImage(index)
      else openPlayer(index)
    }
    card.addEventListener('click', open)
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        open()
      }
    })

    // 鼠标停在卡片上就放一小段「视频中间那几秒」的静音动画。
    if (item.kind === 'video') armHoverPreview(card, media, item)
    return card
  }

  // ── 悬停预览 ────────────────────────────────────────────────────────────
  //
  // 指针在卡片上停一会儿就放一小段动画：几秒钟的动态比任何一帧静图都更能
  // 说明这是什么视频，而且服务端是从**中间**截的，所以永远不会是开头的标
  // 题卡。只有指针真的停住时才请求——扫描时不生成，触摸端根本不启用。

  /** 指针要停多久才开始请求（毫秒）。 */
  const HOVER_PREVIEW_DELAY = 350

  // ── 分组卡片的自适应参数 ─────────────────────────────────────────────────
  //
  // 卡片内部仍然是普通的平铺网格，只是这个网格的「列宽下限」由所属文件夹的
  // 文件数算出来：文件少 → 列少 → 每个缩略图更大；文件多 → 列多 → 更小。
  // 三者配合的结果是：卡片高度大致可控，且不会缩到看不清。

  /** 列宽基准值；除以列数得到这一组的列宽下限。 */
  const GROUP_TILE_BASE = 264
  /** 列宽下限的绝对底线，防止缩略图变成米粒。 */
  const GROUP_TILE_MIN = 84
  /** 一张卡片最多排几列。 */
  const GROUP_MAX_COLUMNS = 6
  /** 同时读取几个分组的内容。 */
  const GROUP_LOAD_CONCURRENCY = 4

  /** 静默续页的哨兵观察者。 */
  let moreSentinel = null

  /**
   * 已经装了悬停预览的卡片 → 它的清理函数。
   *
   * 卡片被重画时要把正在播放的动画停掉，否则那些 `<video>` 会留在后台继续
   * 解码——一屏几十张卡片来回滚动就会积起来。
   */
  const cardDisposers = new Map()

  /**
   * 给一张视频卡片装上悬停播放。
   *
   * @param {HTMLElement} card - 卡片节点。
   * @param {HTMLElement} media - 封面容器。
   * @param {object} item - 条目。
   */
  const armHoverPreview = (card, media, item) => {
    if (previewCapability !== true) return
    // 触摸端没有 hover；强行做只会白耗流量。
    if (!window.matchMedia('(hover: hover)').matches) return

    let timer = 0
    let node = null

    /** 起播：先加载好再加可见类，避免闪一下黑。 */
    const start = () => {
      if (node !== null || !card.isConnected) return
      node = document.createElement('video')
      node.className = 'card-preview'
      node.muted = true
      node.loop = true
      node.playsInline = true
      node.preload = 'auto'
      node.setAttribute('aria-hidden', 'true')
      node.src = `${BASE}/preview?k=${encodeURIComponent(item.key)}&v=${previewVersion}`
      node.addEventListener('canplay', () => {
        if (node === null) return
        node.classList.add('is-ready')
        node.play().catch(() => {
          /* 自动播放被拒就只留静帧封面 */
        })
      })
      node.addEventListener('error', () => {
        // 服务端也拿不到动画（没有 ffmpeg，或这个文件解不开）：安静退回封面。
        node?.remove()
        node = null
        media.classList.remove('is-previewing')
      })
      media.appendChild(node)
      media.classList.add('is-previewing')
    }

    /** 停播并拆掉，把静态封面露回来。 */
    const stop = () => {
      clearTimeout(timer)
      if (node === null) return
      node.pause()
      node.removeAttribute('src')
      node.load()
      node.remove()
      node = null
      media.classList.remove('is-previewing')
    }

    media.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return
      clearTimeout(timer)
      timer = setTimeout(start, HOVER_PREVIEW_DELAY)
    })
    media.addEventListener('pointerleave', stop)
    // 卡片被重画或滚出视野时也要停，否则动画会在后台一直解码。
    card.addEventListener('mv-dispose', stop)
    cardDisposers.set(card, stop)
  }

  /** 平铺渲染：所有符合条件的文件直接铺成网格。 */
  const renderFlatGrid = (host = el.grid) => {
    el.empty.hidden = state.media.length > 0 || state.listing === null
    if (!el.empty.hidden) {
      const only = state.kinds === 'video' ? '视频' : '图片或视频'
      const where = state.scope === 'all' ? '这个目录及其所有子目录里' : '这个目录里'
      el.empty.querySelector('.empty-title').textContent = `${where}没有${only}`
    }
    state.media.forEach((item, index) => host.appendChild(buildCard(item, index)))
  }

  /**
   * 按文件夹分组画：每个文件夹包成**一张卡片**，卡片**内部照旧平铺**。
   *
   * 两个范围都支持：
   *  · `本目录` —— 一个子文件夹一张卡，内容按需加载（滚动到才读那一层）。
   *  · `全部` —— 按每条文件所在的目录分组，组从扫描结果里现成推导，不再
   *    发请求。所以「全部 + 分组」等于「每个目录一张卡，直接铺开」。
   *
   * 卡片内的列宽按该组的文件数自适应（写 `--group-min`）：文件少的缩略图大、
   * 文件多的自动变小，一屏里不会出现「一张卡里两个巨图」或者「几十粒米」。
   */
  const renderGrouped = (host = el.grid) => {
    const listing = state.listing
    if (listing === null) return

    /** 待渲染的分组：{ key, name, files }。 */
    let units = []

    if (state.scope === 'all') {
      // 从扫描结果按父目录归堆；组内保持当前排序。
      const byParent = new Map()
      for (const item of state.media) {
        const parent = String(item.rel ?? '').split('/').slice(0, -1).join('/')
        const key = `r${item.root}/${parent}`
        const bucket = byParent.get(key)
        if (bucket === undefined) byParent.set(key, { key, name: parent === '' ? listing.root.label : parent.split('/').pop(), files: [item] })
        else bucket.files.push(item)
      }
      units = [...byParent.values()]
      // 组之间按文件数降序：内容多的目录更值得先看。
      units.sort((a, b) => b.files.length - a.files.length)
    } else {
      const groups = listing.folders ?? []
      if (groups.length === 0) {
        // 这一层没有子文件夹，分组没有意义，直接平铺。
        renderFlatGrid()
        return
      }
      units = groups.map((folder) => ({ key: folder.key, name: folder.name, files: null }))
    }

    el.empty.hidden = units.length > 0

    const queue = []
    let running = 0
    /** 让排队的分组读取依次进行。 */
    const pump = () => {
      while (running < GROUP_LOAD_CONCURRENCY && queue.length > 0) {
        const next = queue.shift()
        running += 1
        void next().finally(() => {
          running -= 1
          pump()
        })
      }
    }

    for (const unit of units) {
      const group = document.createElement('section')
      group.className = 'folder-group'
      group.dataset.key = unit.key
      const clickable = unit.files === null

      const head = document.createElement('header')
      head.className = 'group-head'
      const icon = document.createElement('span')
      icon.className = 'ico'
      icon.textContent = '📁'
      const title = document.createElement('span')
      title.className = 'group-name'
      title.textContent = unit.name
      title.title = unit.name
      const tally = document.createElement('span')
      tally.className = 'group-tally'
      const opener = document.createElement('button')
      opener.type = 'button'
      opener.className = 'group-open'
      opener.textContent = '打开 ›'
      opener.title = '进入这个文件夹'
      if (clickable) {
        head.addEventListener('click', () => navigate(unit.key))
        opener.addEventListener('click', (event) => {
          event.stopPropagation()
          navigate(unit.key)
        })
      } else {
        opener.hidden = true
      }
      head.append(icon, title, tally, opener)

      const body = document.createElement('div')
      body.className = 'group-body'
      group.append(head, body)
      host.appendChild(group)

      /** 把这一分组的文件铺进卡片。 */
      const paint = (items) => {
        clear(body)
        if (items.length === 0) {
          const none = document.createElement('div')
          none.className = 'group-empty'
          none.textContent = '这里没有符合条件的文件'
          body.appendChild(none)
          tally.textContent = '0'
          return
        }
        tally.textContent = `${items.length} 个`
        // 自适应列宽：列数随数量增长，但设置一个下限，别让缩略图变成米粒。
        const columns = items.length <= 2 ? items.length : Math.min(GROUP_MAX_COLUMNS, Math.ceil(Math.sqrt(items.length)))
        const min = Math.max(GROUP_TILE_MIN, Math.round(GROUP_TILE_BASE / columns))
        body.style.setProperty('--group-min', `${min}px`)
        for (const item of items) {
          const at = state.media.indexOf(item)
          body.appendChild(buildCard(item, at === -1 ? 0 : at, { compact: true }))
        }
      }

      if (unit.files !== null) {
        paint(unit.files)
        continue
      }

      // 未加载：先占位，等它进入视野再读那一层。
      tally.textContent = '…'
      const placeholder = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        placeholder.disconnect()
        queue.push(async () => {
          const result = await api(`/api/list?k=${encodeURIComponent(unit.key)}`).catch(() => null)
          if (result === null || !result.ok) {
            paint([])
            return
          }
          const wanted = (result.payload.files ?? []).filter((item) =>
            state.kinds === 'video' ? item.kind === 'video' : item.kind !== 'other',
          )
          paint(wanted.sort(comparators[state.sort] ?? comparators.new))
        })
        pump()
      }, { root: el.content, rootMargin: '400px' })
      placeholder.observe(group)
    }
  }

  /**
   * 画媒体区：按当前分组方式选路。
   *
   * 新内容先在**游离的 fragment 里**建好，最后一次性换掉旧的，而不是
   * 「先清空、再一个个 append」。
   *
   * 差别在观感上很实在：切目录时旧卡片和新卡片长得不一样，清空到填满之间
   * 会有一瞬间是空的（滚动条也会跟着跳），用户看到的就是「先清空再显示」。
   * 换成一次替换，浏览器只做一次重排，中间没有空的那一帧。
   */
  const renderGrid = () => {
    // 重画前先把上一批卡片的悬停动画停掉。
    for (const dispose of cardDisposers.values()) dispose()
    cardDisposers.clear()
    const grouped = state.group === 'folder'
    // 先取好新内容，再动现有的 DOM：任何中途抛错都还留着上一屏，而不是留一屏空白。
    const next = document.createDocumentFragment()
    if (grouped) renderGrouped(next)
    else renderFlatGrid(next)
    el.grid.replaceChildren(next)
    el.grid.classList.toggle('is-grouped', grouped)
    el.body.dataset.view = state.view
    el.viewToggle.classList.toggle('is-on', state.view === 'list')
    el.viewToggle.title = state.view === 'list' ? '切换为网格 (V)' : '切换为列表 (V)'
  }

  /**
   * 静默续页：滚到底部自动把下一页拉回来。
   *
   * 原来这里是一个「载入更多」按钮——但用户要的是浏览，不是手动翻页。现在
   * 底部只放一个哨兵，进入视野就自动加载；**加载过程完全不可见**，没有按钮
   * 也没有转圈。缩略图同理，本来就只有懒加载没有指示器。
   */
  const renderMore = () => {
    clear(el.more)
    const listing = state.listing
    if (listing === null || listing.nextOffset === null) return
    moreSentinel?.disconnect()
    moreSentinel = null

    const sentinel = document.createElement('div')
    sentinel.className = 'more-sentinel'
    el.more.appendChild(sentinel)

    /** 拉下一页并合并进来。 */
    const loadNext = async () => {
      if (listing.nextOffset === null) return
      const payload = await guard('继续载入', async () => {
        const result = await api(`/api/list?k=${encodeURIComponent(state.key)}&offset=${listing.nextOffset}`)
        if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
        return result.payload
      })
      if (payload === undefined) return
      listing.files = [...(listing.files ?? []), ...(payload.files ?? [])]
      listing.nextOffset = payload.nextOffset
      recomputeMedia()
      renderSummary()
      renderAll()
    }

    moreSentinel = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      void loadNext()
    }, { root: el.content, rootMargin: '600px' })
    moreSentinel.observe(sentinel)
  }

  // ── 目录树 ──────────────────────────────────────────────────────────────

  /** 树的展开状态，按 key 记录；刷新页面后保持。 */
  const treeOpen = new Set(JSON.parse(localStorage.getItem('mv.treeOpen') ?? '[]'))
  /** 用户显式折起来的分支。没有它就无法区分「没展开过」和「我折起来了」。 */
  const treeClosed = new Set(JSON.parse(localStorage.getItem('mv.treeClosed') ?? '[]'))

  const persistTree = () => {
    localStorage.setItem('mv.treeOpen', JSON.stringify([...treeOpen].slice(-200)))
    localStorage.setItem('mv.treeClosed', JSON.stringify([...treeClosed].slice(-200)))
  }

  /**
   * 树的每个可折展节点的「切换」函数，按 key 存一份。
   *
   * 树每次重画都是全新 DOM，键盘导航手里只剩一个 `data-key`，所以需要一张
   * 从 key 到动作的表——否则键盘和鼠标就得写两套折展逻辑，两边迟早不一致。
   */
  const openers = new Map()

  /** 上一次键盘聚焦的树行键；重画后把 roving tabindex 还给它。 */
  let treeKeyboardKey = null
  /** 键盘监听是否已经委托到树容器上（只需一次，因为用的是委托）。 */
  let treeKeyboardBound = false
  /** 上一次渲染时树的「形状」（根｜范围｜分组），用来判断这次重画是否换了根。 */
  let treeShape = null
  /** 上一次建出来的根键列表。它没变就说明树的结构没变，可以只更新状态、不重建。 */
  let treeRootKeys = null
  /** 上一次建出来的根节点（复用路径靠它找到现有 DOM）。 */
  let treeRootNodes = []
  /** 正在执行的「钉住滚动位置」任务（观察者 + 摘除函数）。 */
  let treePin = null
  /** 钉住任务的兜底定时器：观察者万一没停手，也不能一直挂着。 */
  let treePinTimer = null

  /**
   * 把某个目录的祖先链展开，并加载沿途的子级。
   *
   * 只在**明确导航**时调用（点行浏览、面包屑、行尾 ›），不在渲染时无条件
   * 调用——渲染时展开会把用户的「收起」动作直接抹掉。这样「我进了这个目录」
   * 一定能看到自己在哪，而「我把它折起来」也不会被下一次渲染反悔。
   *
   * @param {string} key - 目标目录键。
   */
  const expandPathTo = async (key) => {
    for (const ancestor of [rootKeyOf(key), ...ancestorKeysOf(key)]) {
      if (ancestor === key) continue
      applyTreeOpen(ancestor, true)
      const opener = openers.get(ancestor)
      if (opener !== undefined) await opener(true, false)
    }
  }

  /** 记录一个节点的展开/收起状态（不动 DOM）。 */
  const applyTreeOpen = (key, next) => {
    if (next) {
      treeOpen.add(key)
      treeClosed.delete(key)
    } else {
      treeOpen.delete(key)
      treeClosed.add(key)
    }
    persistTree()
  }

  /**
   * 把展开状态画到 DOM 上（三角 + 子层显隐），并记在节点自己身上。
   *
   * `data-open` 是「当前 DOM 是展开还是收起」的**唯一权威**。幂等判断必须读它，
   * 不能读 `host.hidden` 或内部的 treeOpen 集合：前者会被浏览器的 hidden 语义
   * 影响，后者只记「用户想让它开着」，节点刚建出来还没加载时两者并不一致。
   * 状态记在节点上，重建节点时自然从零开始，不会出现「状态说是开的、DOM 是空的」。
   */
  const paintTreeBranch = (key, twisty, host, next) => {
    if (twisty !== null && twisty !== undefined) twisty.textContent = next ? '▾' : '▸'
    if (host !== null && host !== undefined) {
      host.hidden = !next
      host.dataset.open = next ? '1' : '0'
    }
    void key
  }

  /**
   * 画目录树。
   *
   * 每个配置的目录都是一个可展开的根：只画「当前根」的子目录会让别的根
   * 在视觉上消失（用户配了多目录却看不到内容，就是这么来的）。每个根的
   * 子目录仍然按需请求——展开时才拉那一层。
   */
  const renderTree = () => {
    // 滚动位置只在「树还是那棵树」时还原。
    //
    // 判断依据是**树自己的形状**：哪个根、什么范围、什么分组。这里绝不能用
    // state.key——点一行目录时 state.key 会变成那个子目录，可树的形状一点没变
    // （行、缩进、展开状态全一样）。早先按 state.key 判断，于是「点一行目录」
    // 被判成「换了内容」，还原被跳过，目录栏每次点都弹回顶部；而渲染日志里看到
    // 的正是 sameContent: false + 树高完全没变。
    //
    // 形状的重画由各自的入口负责：折展与懒加载只改 DOM 不改形状，所以它们
    // 走的是同一个 shape；换个根（r0 → r1）才真正换形状。
    //
    // 位置在读**之前**取，直接读 el.tree.scrollTop：清理 DOM 会把 scrollTop 归零，
    // 清理后再读永远是 0。缩到滚不动时必须读成 0，否则会把上一次的位置当成当前
    // 位置还原——「滚到一半之后收起分支，再展开就凭空跳走」就是这么来的。
    const shape = `${rootKeyOf(state.key)}|${state.scope}|${state.group}`
    const sameShape = shape === treeShape
    treeShape = shape
    const canScroll = el.tree.scrollHeight > el.tree.clientHeight + 1
    const scrollTop = sameShape && canScroll ? el.tree.scrollTop : 0
    recordTreeRender({ shape, sameShape, canScroll, scrollTop })
    const roots = state.session?.roots ?? []
    const rootKeys = roots.map((item) => `r${item.index}`).join(',')

    // 根列表没变就**不重建**，只更新状态。
    //
    // 早先这里无条件 clear + 重建：点一下目录（navigate → renderAll → renderTree）
    // 就把几十个已加载的子目录行整个删掉再建一遍，一进一出之间那一瞬间是空的，
    // 看上去就是「子目录全部消失、然后又重新出现」闪一下。重建还顺带把懒加载
    // 建好的分支全丢了，用户白等一次请求。
    //
    // 树里唯一会因导航而变的东西是「哪一行是当前目录」，而那只是一个 class。
    if (treeRootKeys === rootKeys && treeRootNodes.length === roots.length) {
      reuseTree()
      return
    }
    treeRootKeys = rootKeys
    clearTree()
    if (roots.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'tree-empty'
      hint.textContent = '还没有配置目录。点右上角设置添加一个。'
      el.tree.appendChild(hint)
      return
    }
    const activeRootKey = rootKeyOf(state.key)

    // 当前路径**不**在这里强制展开。
    //
    // 早先为了让「展开了却在树里看不见自己」不再发生，我让渲染时无条件展开
    // 当前路径——结果就是根永远收不起来，而这恰恰是用户最直接的抱怨。折展
    // 是用户的动作，渲染不该覆盖它。取而代之的做法是：点开一个目录时，只
    // 展开**它自己**（由点击处完成），不碰祖先；行尾的 › 则完全不折展。

    // 先把所有根都建出来并接进文档，再逐个挂交互。这样做是因为每个根的
    // 子目录加载是异步的、可能失败，而「配了多个目录却只看到一个」这种
    // 症状不该由渲染顺序或某个根的错误来决定：结构先全部到位，之后再补
    // 细节，任何一个根出问题都不会吃掉其它根。
    treeRootNodes = []
    for (const item of roots) {
      const rootKey = `r${item.index}`
      const wrapper = document.createElement('div')
      wrapper.className = 'tree-root'

      const children = document.createElement('div')
      children.className = 'tree-children'

      const name = document.createElement('div')
      name.className = 'tree-root-name'
      name.title = item.path
      name.tabIndex = 0

      const twisty = document.createElement('span')
      twisty.className = 'twisty'
      const icon = document.createElement('span')
      icon.textContent = '🗂'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = item.label
      name.append(twisty, icon, label)
      name.dataset.label = item.label
      name.dataset.rootIndex = String(item.index)
      name.dataset.key = rootKey
      wrapper.append(name, children)
      el.tree.appendChild(wrapper)

      // 每个根默认展开（第一次看到时就把它记成「展开过」），此后由用户的点击
      // 决定。「当前根强制展开」那种写法会让人怎么点都收不起来，所以这里只在
      // 首次渲染时播种一次。
      if (activeRootKey === rootKey && !treeOpen.has(rootKey) && !treeClosed.has(rootKey)) {
        treeOpen.add(rootKey)
      }
      armTreeRoot({ item, rootKey, wrapper, children, name, twisty })
    }
    persistTree()
    applyTreeOpenState()

    // 重建完把滚动位置放回去，并让树整体可以被方向键导航。
    // 顺序很关键：`focus()` 会把聚焦的元素滚进视野，所以必须**先接键盘、
    // 再还原滚动**，否则目录栏每次重画都会跳回顶部。
    armTreeKeyboard({ restoreScroll: sameShape ? scrollTop : null })
    keepTreeScroll(scrollTop)
  }

  /**
   * 把状态同步到已有的根节点上，不碰 DOM 结构。
   *
   * 这是「根列表没变」时的渲染路径：根的顺序和数量都没变，那唯一可能变的就是
   * 折展状态和「当前目录是哪一行」。这两样都只是改属性/class，代价接近零，
   * 而重建整棵树会把懒加载出来的分支全部丢掉，还要重新发请求。
   */
  const reuseTree = () => {
    applyTreeOpenState()
    syncTreeActive()
  }

  /** 把折展状态刷到所有根节点上（不重建）。 */
  const applyTreeOpenState = () => {
    for (const node of treeRootNodes) {
      const open = treeOpen.has(node.rootKey) && !treeClosed.has(node.rootKey)
      paintTreeBranch(node.rootKey, node.twisty, node.children, open)
    }
  }

  /**
   * 只更新「当前目录」的高亮。
   *
   * 导航是树里最常见的变化，而它影响的只有一个 class。把这一步从重建里拆出来，
   * 点一行目录就不会再动到其它任何节点——既不闪，也不丢已加载的分支。
   */
  const syncTreeActive = () => {
    const activeKey = state.key
    for (const node of treeRootNodes) {
      node.name.classList.toggle('is-active', node.rootKey === activeKey)
    }
    for (const row of el.tree.querySelectorAll('.tree-folder')) {
      row.classList.toggle('is-active', row.dataset.key === activeKey)
    }
  }

  /** 清掉树里现有的全部节点，并让折展动作表跟着失效。 */
  const clearTree = () => {
    clear(el.tree)
    treeRootNodes = []
    treeRootKeys = null
    // 折展动作表现在指向的是上一批（已脱离文档的）节点。
    openers.clear()
  }

  /**
   * 给一个根节点接上交互（折展、点击浏览、按钮进入）。
   *
   * 抽成函数是为了让「重建」和「复用」两条路共用同一套接线，而不是只在重建时
   * 接一次——复用路径一旦漏接，点击就会没反应。
   *
   * @param {{item: object, rootKey: string, wrapper: HTMLElement, children: HTMLElement, name: HTMLElement, twisty: HTMLElement}} node - 这个根的节点集合。
   */
  const armTreeRoot = ({ item, rootKey, children, name, twisty }) => {
    treeRootNodes.push({ item, rootKey, children, name, twisty })

    const loadRootChildren = async () => {
      if (children.dataset.loaded === '1' || children.dataset.loading === '1') return
      children.dataset.loading = '1'
      const payload = await guard('载入目录', async () => {
        const result = await api(`/api/list?k=${encodeURIComponent(rootKey)}`)
        if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
        return result.payload
      })
      children.dataset.loading = '0'
      if (payload === undefined) return
      children.dataset.loaded = '1'
      clear(children)
      renderBranch(children, rootKey, payload.folders ?? [], 1)
    }

    /**
     * 切换这个根的展开状态。
     *
     * 幂等：要的状态已经是当前状态就直接返回，**绝不重复拉数据**。
     *
     * 这一点很要紧。早先这个函数不看当前状态，只要 next 为真就往下走，而
     * 最后一步是无条件的 clear(children) + 重新请求——于是任何一条「已经展开
     * 了却又调用一次 toggle(true)」的路径，都会把已经加载好的整棵子树清空、
     * 再重新加载一遍。用户看到的就是「点展开的时候数据先清掉、然后又出来」。
     * 折展是切换动作，不是「重新加载」动作，所以重复的同一方向不再当成切换。
     *
     * @param {boolean} next - true 展开，false 收起。
     * @param {boolean} [browse] - 展开时是否同时把右侧列表切到这个根。
     */
    const toggle = async (next, browse = false) => {
      const isOpen = children.dataset.open === '1'
      // 方向没变就返回。这一条挡住了「已经展开还被要求展开」——那正是把整棵
      // 子树清空重载的来源。
      if (next === isOpen) {
        // 例外：开着但上一次没加载成功（loading 失败时 loaded 不会置位），
        // 这时再点展开应该重试，而不是因为「DOM 已经开着」就永远装不上内容。
        if (next !== true || children.dataset.loaded === '1' || children.dataset.loading === '1') return
      }
      applyTreeOpen(rootKey, next)
      // 明确要「进这个根」时，把沿途（根自己）打开再导航。
      if (browse && next) await expandPathTo(rootKey)
      // 先写状态再导航：navigate 会重画整棵树，而重画照着 treeOpen 渲染，
      // 顺序反了就会把刚展开的这一支又收回去。
      if (browse && next) navigate(rootKey)
      paintTreeBranch(rootKey, twisty, children, next)
      if (next) await loadRootChildren()
    }
    // 供键盘导航按 key 调用（那时闭包里的节点已经不在文档里了）。
    openers.set(rootKey, toggle)

    twisty.addEventListener('click', (event) => {
      event.stopPropagation()
      // 三角是纯折展，不动右侧列表。
      void toggle(children.hidden)
    })

    // 点根名 = 展开它并浏览它（收起时只收起）。
    //
    // 展开一个目录的意图本来就是「看这个目录里的东西」，所以展开即浏览：
    // 右侧列表切过去，树停在展开状态，两边同步。收起则什么都不影响。
    //
    // 和子目录行同样的道理：双击会先送两次 click，连点两下根名就会
    // 「展开+导航、收起+再导航」，目录被开两遍、树还闪一下。第二下 click
    // （detail > 1）不处理，双击直接当「进这个根」。
    name.addEventListener('click', (event) => {
      if (event.detail > 1) return
      void toggle(children.hidden, true)
    })
    name.addEventListener('dblclick', () => {
      if (navigatedJustNow(rootKey)) return
      navigate(rootKey)
    })

    if (treeOpen.has(rootKey) && !treeClosed.has(rootKey)) void loadRootChildren()
    void item
  }

  /**
   * 一次性把目录栏的滚动位置钉住。
   *
   * 只在这一次渲染的 DOM 上有效，所以它刻意**不是**一个持久的滚动监听：一个
   * 永久监听会把位置记成「用户上次滚到哪」，可用户滚到底之后收起一个分支，容器
   * 缩到滚不动、scrollTop 被浏览器钳成 0，那个监听就把 0 当成用户的选择记下来，
   * 之后还原上去，整棵树凭空跳回顶部。
   *
   * 写入时机比写入值更容易搞错：`renderTree` 返回时 DOM 还没稳定，此时写的
   * scrollTop 会被随后的 DOM 变动丢掉——实测「写 400 → 12ms 后归 0」，而那次
   * 变动来自子目录懒加载（数据回来才建的行）。定时器补齐只能赌一次时机
   * （试过两帧 rAF，照样被数据回来那次重画抹掉），所以这里改成盯着这棵树本身：
   * 只要它还在被改写，位置掉了就补回去；两秒后兜底摘掉观察者。
   *
   * 补写还带一个容差：只有位置**确实**掉到目标附近以外才动手。用户自己在观察
   * 期间滚到别处（超过一屏）就不再干预，所以「钉住」不会变成「锁死」。
   *
   * @param {number} wanted - 目标滚动位置。
   */
  const keepTreeScroll = (wanted) => {
    if (wanted <= 0) return
    releaseTreePin()
    let pinned = true
    const release = () => {
      if (!pinned) return
      pinned = false
      releaseTreePin()
    }
    const reconcile = () => {
      // 换了根就没必要再钉着旧位置了。
      if (treeShape !== shape) return release()
      const tree = el.tree
      // 内容塌到滚不动：没有「位置」可言，更不能趁这个瞬间把位置写进去。
      if (!(tree.scrollHeight > tree.clientHeight + 1)) return
      if (Math.abs(tree.scrollTop - wanted) <= 8) return
      // 用户自己滚走了一屏以上，尊重他。
      if (Math.abs(tree.scrollTop - wanted) > tree.clientHeight) return release()
      tree.scrollTop = wanted
    }
    const shape = treeShape
    const observer = new MutationObserver(reconcile)
    observer.observe(el.tree, { childList: true, subtree: true, characterData: true })
    treePin = { observer, release }
    treePinTimer = setTimeout(release, 2000)
    tree.scrollTop = wanted
    requestAnimationFrame(reconcile)
  }

  /** 摘掉 `keepTreeScroll` 布下的观察者与兜底定时器。 */
  const releaseTreePin = () => {
    if (treePinTimer !== null) {
      clearTimeout(treePinTimer)
      treePinTimer = null
    }
    if (treePin === null) return
    treePin.observer.disconnect()
    treePin = null
  }

  /**
   * 记一笔「谁在什么时候重画了树、当时读到的滚动位置是多少」。
   *
   * 只在测试打开 window.__mvDebug 时才记，生产环境什么都不做。存在的理由很具体：
   * 「滚动位置被谁抹掉了」这类问题，光看 DOM 是查不出来的——追溯到的都是
   * 「scrollTop 变成了 0」，而看不出是哪一次重画、按什么判断读成 0 的。
   *
   * @param {{shape: string, sameShape: boolean, canScroll: boolean, scrollTop: number}} info - 本次渲染的决策输入。
   */
  function recordTreeRender(info) {
    if (window.__mvDebug !== true) return
    const log = (window.__mvRenderLog ??= [])
    log.push({ t: Math.round(performance.now()), ...info })
    if (log.length > 40) log.splice(0, log.length - 40)
  }

  /**
   * 把目录树接上方向键。
   *
   * 树是「一行一个节点」的结构，用户对它最自然的期待就是文件管理器那套：
   * ↑↓ 在可见行之间移动、→ 展开、← 收起、Enter 进目录、Space 折展。之前只有
   * 鼠标能操作，键盘党只能按 Tab 一个个跳，这也是「手感不舒服」的一部分。
   *
   * 用 roving tabindex：只有当前聚焦的那一行 tabindex=0，其余 -1，所以 Tab
   * 是「进出整棵树」而不是「逐行走一遍」。
   */
  const armTreeKeyboard = (options = {}) => {
    const rows = () => [...el.tree.querySelectorAll('.tree-root-name, .tree-folder')]
    /**
     * 移动键盘焦点。
     *
     * @param {HTMLElement|undefined} node - 目标行。
     * @param {boolean} [scroll] - 是否把它滚进视野。
     * @param {boolean} [preventScroll] - 聚焦时不触发浏览器自动滚动。
     */
    const focusRow = (node, scroll = true, preventScroll = false) => {
      if (node === undefined || node === null) return
      for (const other of rows()) other.tabIndex = other === node ? 0 : -1
      treeKeyboardKey = node.dataset.key ?? null
      node.focus({ preventScroll })
      if (scroll) node.scrollIntoView({ block: 'nearest' })
    }
    // 至少留一行可以 Tab 进来；优先还给它上次聚焦的那一行。
    const all = rows()
    const remembered = treeKeyboardKey === null ? undefined : all.find((node) => node.dataset.key === treeKeyboardKey)
    if (remembered !== undefined) {
      for (const node of all) node.tabIndex = node === remembered ? 0 : -1
      // 还原焦点时用 preventScroll：否则浏览器会把这一行滚进视野，把调用方
      // 刚要还原的滚动位置顶掉——「点一下目录栏就跳回顶部」就是这么来的。
      if (options.restoreScroll !== null && options.restoreScroll !== undefined) {
        remembered.focus({ preventScroll: true })
      }
    } else if (all.length > 0 && all.every((node) => node.tabIndex !== 0)) {
      all[0].tabIndex = 0
    }

    const onKey = (event) => {
      // 委托：事件源才是那一行，不是容器。
      const node = event.target instanceof Element ? event.target.closest('.tree-root-name, .tree-folder') : null
      if (node === null || node === undefined || !el.tree.contains(node)) return
      const list = rows()
      const index = list.indexOf(node)
      if (index === -1) return
      const childHost = node.classList.contains('tree-root-name')
        ? node.parentElement?.querySelector('.tree-children')
        : node.nextElementSibling
      const expanded = childHost !== null && childHost !== undefined && childHost.hidden === false
      const opener = openers.get(node.dataset.key)
      /** 折展当前行（键盘和鼠标共用同一套状态）。 */
      const toggleSelf = (next) => {
        if (opener === undefined) return
        void opener(next, false)
      }

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault()
          focusRow(list[index + 1])
          break
        case 'ArrowUp':
          event.preventDefault()
          focusRow(list[index - 1])
          break
        case 'ArrowRight':
          event.preventDefault()
          if (!expanded) toggleSelf(true)
          else focusRow(list[index + 1])
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (expanded) {
            toggleSelf(false)
            break
          }
          {
            const parent = node.closest('.tree-children')?.previousElementSibling
            if (parent !== null && parent !== undefined) focusRow(parent)
          }
          break
        case 'Enter':
          event.preventDefault()
          navigate(node.dataset.key)
          break
        case ' ':
          event.preventDefault()
          toggleSelf(!expanded)
          break
        case 'Home':
          event.preventDefault()
          focusRow(list[0])
          break
        case 'End':
          event.preventDefault()
          focusRow(list[list.length - 1])
          break
        default:
          break
      }
    }

    // 用**事件委托**挂一次，而不是给每行单独挂。
    //
    // 子目录是懒加载的：展开一个文件夹之后才创建它的子行，那时渲染早已结束。
    // 早先在这里逐行 addEventListener，后生成的行一个都没接上键盘——现象就是
    // 「方向键只在根那一行有效」。委托给容器就与生成时机无关了。
    if (treeKeyboardBound !== true) {
      el.tree.addEventListener('keydown', onKey)
      treeKeyboardBound = true
    }
  }

  /** 一个目录键的所有祖先键（根之后逐级），用于把当前路径展开出来。 */
  const ancestorKeysOf = (key) => {
    const match = /^r(\d+)(?:\/(.*))?$/.exec(String(key))
    if (match === null) return []
    const parts = (match[2] ?? '').split('/').filter((part) => part !== '')
    const keys = []
    for (let depth = 1; depth <= parts.length; depth += 1) {
      keys.push(`r${match[1]}/${parts.slice(0, depth).join('/')}`)
    }
    return keys
  }

  /**
   * 递归画一层目录分支。子目录在展开时才请求，所以打开一个深目录不会
   * 让 host 把整棵树读一遍。
   */
  const renderBranch = (host, parentKey, folders, depth) => {
    for (const folder of folders) {
      const row = document.createElement('div')
      row.className = `tree-folder${state.key === folder.key ? ' is-active' : ''}`
      row.title = folder.name
      const twisty = document.createElement('span')
      twisty.className = 'twisty'
      const open = treeOpen.has(folder.key) && !treeClosed.has(folder.key)
      twisty.textContent = open ? '▾' : '▸'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = folder.name
      row.dataset.label = folder.name
      row.tabIndex = -1
      // 进目录的动作做成一个明确的按钮：点击是切换展开，双击是进目录，这两件
      // 事光靠文字行说不清楚，得给个看得见的入口。
      const enter = document.createElement('button')
      enter.type = 'button'
      enter.className = 'tree-enter'
      enter.textContent = '›'
      enter.title = '进入这个文件夹'
      enter.setAttribute('aria-label', `进入 ${folder.name}`)
      enter.addEventListener('click', (event) => {
        event.stopPropagation()
        navigate(folder.key)
      })
      row.append(twisty, label, enter)

      const childHost = document.createElement('div')
      childHost.className = 'tree-children'
      // 用 paintTreeBranch 落初始状态，好让 data-open 从一开始就与 DOM 一致。
      paintTreeBranch(folder.key, twisty, childHost, open)

      const loadChildren = async () => {
        if (childHost.dataset.loaded === '1' || childHost.dataset.loading === '1') return
        childHost.dataset.loading = '1'
        const payload = await guard('载入子目录', async () => {
          const result = await api(`/api/list?k=${encodeURIComponent(folder.key)}`)
          if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
          return result.payload
        })
        childHost.dataset.loading = '0'
        if (payload === undefined) return
        childHost.dataset.loaded = '1'
        clear(childHost)
        renderBranch(childHost, folder.key, payload.folders ?? [], depth + 1)
      }

      twisty.addEventListener('click', async (event) => {
        event.stopPropagation()
        const next = !treeOpen.has(folder.key) || treeClosed.has(folder.key)
        await setChildrenOpen(next)
        // 三角是纯折展，不动右侧列表。
      })

      /**
       * 切换这一行子目录的展开状态。
       *
       * 和根一样是幂等的：要的状态已经是当前状态就直接返回，绝不重复拉数据。
       * 否则「已经展开却又被要求展开」的路径会把已加载的子树清空重来。
       *
       * @param {boolean} next - true 展开，false 收起。
       * @param {boolean} [browse] - 展开时是否同时把右侧列表切到这个目录。
       */
      async function setChildrenOpen(next, browse = false) {
        const isOpen = childHost.dataset.open === '1'
        // 和根同样的幂等判断：方向没变就不再当成切换，免得把已加载的子树清空重载。
        // 同样留「开着但没加载成功」的重试口子。
        if (next === isOpen) {
          if (next !== true || childHost.dataset.loaded === '1' || childHost.dataset.loading === '1') return
        }
        applyTreeOpen(folder.key, next)
        // 明确要「进这个目录」时，沿途祖先也要打开，否则进去之后树里看不到
        // 自己在哪、也没法再点它收起。这是导航动作的一部分，不是渲染规则。
        if (browse && next) await expandPathTo(folder.key)
        // 先写状态再导航：navigate 会重画整棵树，而重画照着 treeOpen 渲染，
        // 顺序反了就会把刚展开的这一支又收回去。
        if (browse && next) navigate(folder.key)
        paintTreeBranch(folder.key, twisty, childHost, next)
        if (next) await loadChildren()
      }
      // 供键盘导航按 key 调用（那时闭包里的节点已经不在文档里了）。
      openers.set(folder.key, setChildrenOpen)

      // 点这一行 = 展开它并浏览它。
      //
      // 展开一个目录的意图本来就是「看这个目录里的东西」，所以展开即浏览：
      // 右侧列表切到该目录，树也停在展开状态，两边保持同步。收起则什么都不
      // 影响——用户只是想把它折起来。要单独折展而不动列表，点左边的三角；
      // 要直接进目录，用行尾的 › 或双击。
      //
      // 但「双击 = 进目录」和「单击 = 展开并浏览」会打架：浏览器发 dblclick 之前
      // 必定先发两次 click，于是双击一次目录的实际效果是
      //
      //   点1：展开 + 导航 → 点2：hidden 已翻转，变成收起 + 再导航 → dblclick：第三次导航
      //
      // 目录被连开三遍，而每次导航都重建整棵树，用户看到的就是「打开一次、闪一下、
      // 又打开一次」。所以这里按 event.detail 过滤：detail > 1 说明这是连击的第二下，
      // 交给 dblclick 处理就够了。dblclick 本身再用「刚导航过就跳过」去重，避免和
      // 第一下 click 重复加载同一个目录。
      row.addEventListener('click', (event) => {
        if (event.detail > 1) return
        void setChildrenOpen(childHost.hidden, true)
      })
      row.addEventListener('dblclick', () => {
        if (navigatedJustNow(folder.key)) return
        navigate(folder.key)
      })
      row.addEventListener('auxclick', (event) => {
        // 中键也当「进入」——浏览器里的通用直觉。
        if (event.button === 1) navigate(folder.key)
      })
      row.dataset.key = folder.key

      host.appendChild(row)
      if (open) void loadChildren()
      host.appendChild(childHost)
    }
    void parentKey
  }

  // ── 导航 ────────────────────────────────────────────────────────────────

  /** 上次导航发生的时间，用来给「单击即浏览 + 双击进目录」去重。 */
  let lastNavigationAt = 0

  /**
   * 刚刚是不是已经导航到这个目录了。
   *
   * 用来把「单击即浏览」和「双击进目录」这两条路去重：双击的第一下 click 已经
   * 载入了这个目录，紧跟其后的 dblclick 再载入一次就是白跑一遍（还会让整棵树
   * 重建、列表闪一下）。窗口取 400ms——比系统的双击间隔上限略宽，又短到不会
   * 误吞用户「点进去、看完、再点一次刷新」的第二次意图。
   *
   * @param {string} key - 目录键。
   * @returns {boolean} 400ms 内已经导航过这个目录则为 true。
   */
  const navigatedJustNow = (key) => state.key === key && performance.now() - lastNavigationAt < 400

  /** 切换目录并同步地址栏，方便收藏和刷新。 */
  const navigate = (key) => {
    state.key = key ?? ''
    lastNavigationAt = performance.now()
    const url = new URL(window.location.href)
    url.searchParams.set('k', state.key)
    url.searchParams.set('mode', state.mode ?? 'browse')
    if (state.filter.trim() !== '') url.searchParams.set('q', state.filter)
    else url.searchParams.delete('q')
    window.history.replaceState(null, '', url)
    void loadListing()
  }

  /** 切换模式（列表 / 刷视频）。 */
  const setMode = (mode) => {
    state.mode = mode
    el.body.dataset.mode = mode
    for (const node of document.querySelectorAll('[data-mode-btn]')) {
      const active = node.dataset.modeBtn === mode
      node.classList.toggle('is-active', active)
      node.setAttribute('aria-selected', String(active))
    }
    const url = new URL(window.location.href)
    url.searchParams.set('mode', mode)
    window.history.replaceState(null, '', url)
    // 面板的显隐是这里唯一的真相：CSS 里的 body[data-mode] 规则只是兜底，
    // 只改 dataset 而忘了 hidden 会让刷视频模式渲染在一个隐藏容器里。
    el.feedPane.hidden = mode !== 'feed'
    if (mode === 'feed') {
      el.feedScroller.focus()
      void loadFeed(true)
    } else {
      teardownFeed()
      el.viewer.hidden = true
    }
  }

  // ── 图片查看器 ──────────────────────────────────────────────────────────

  const imageState = { index: 0, scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 }

  const imageItems = () => state.media.filter((item) => item.kind === 'image')

  const applyImageTransform = () => {
    el.viewerImage.style.transform = `translate(${imageState.x}px, ${imageState.y}px) scale(${imageState.scale})`
  }

  const showImage = (position) => {
    const images = imageItems()
    if (images.length === 0) return
    imageState.index = ((position % images.length) + images.length) % images.length
    imageState.scale = 1
    imageState.x = 0
    imageState.y = 0
    const item = images[imageState.index]
    el.viewerImage.src = item.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item.key)}`
    el.viewerImage.alt = item.name
    el.viewerMeta.textContent = `${imageState.index + 1}/${images.length} · ${item.name} · ${fmtBytes(item.size)}`
    el.viewer.hidden = false
    applyImageTransform()
  }

  const openImage = (index) => {
    const item = state.media[index]
    if (item === undefined) return
    const images = imageItems()
    showImage(images.findIndex((candidate) => candidate.key === item.key))
  }

  const zoomImage = (factor) => {
    imageState.scale = Math.min(Math.max(imageState.scale * factor, 0.2), 12)
    applyImageTransform()
  }

  // ── 播放器与连播列表 ────────────────────────────────────────────────────

  /** 连播列表：当前目录（或整棵根目录）里的图片 + 视频 + 音频，按当前排序。 */
  const playlist = () => state.media.filter((item) => item.kind !== 'other')

  const player = createPlayer({
    items: [],
    onClose: () => {
      if (state.mode === 'feed') resumeFeed()
    },
  })

  const openPlayer = (index) => {
    const items = playlist()
    const item = state.media[index]
    const target = items.findIndex((candidate) => candidate.key === item?.key)
    player.open(items, target === -1 ? 0 : target)
  }

  // ── 刷视频模式 ──────────────────────────────────────────────────────────

  /** 当前 feed 的 IntersectionObserver 与已挂载的 slide。 */
  const feed = { observer: null, slides: [], sentinel: null, current: undefined }
  let feedMuted = localStorage.getItem('mv.feedMuted') !== '0'
  let feedPaused = true
  /** 当前所在 slide 的下标；手势和自动推进共用它。 */
  const feedPosition = () => (Number.isInteger(feed.current) ? feed.current : 0)

  /** 跳到相对位置的 slide；越界就停住，不循环。 */
  const feedGoTo = (position) => {
    const target = feed.slides[position]
    if (target === undefined) return false
    target.scrollIntoView({ block: 'start' })
    return true
  }

  /** 左右滑动切换上一条 / 下一条（触摸端的主要导航方式）。 */
  const feedSwipe = { active: false, x: 0, y: 0, id: -1 }

  const bindFeedGestures = () => {
    el.feedScroller.addEventListener('pointerdown', (event) => {
      if (player.isOpen()) return
      feedSwipe.active = true
      feedSwipe.x = event.clientX
      feedSwipe.y = event.clientY
      feedSwipe.id = event.pointerId
    })

    /**
     * 判定一次滑动。横滑翻页；竖滑交给浏览器自己的滚动吸附，这里不管。
     * 触摸端一旦被判定为竖向滚动，浏览器会发 pointercancel，所以 up 和
     * cancel 都要走这一套。
     */
    const settle = (event) => {
      if (!feedSwipe.active || event.pointerId !== feedSwipe.id) return
      feedSwipe.active = false
      const dx = event.clientX - feedSwipe.x
      const dy = event.clientY - feedSwipe.y
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        feedGoTo(feedPosition() + (dx < 0 ? 1 : -1))
      }
    }

    el.feedScroller.addEventListener('pointerup', settle)
    el.feedScroller.addEventListener('pointercancel', (event) => {
      if (!feedSwipe.active || event.pointerId !== feedSwipe.id) return
      feedSwipe.active = false
    })
  }

  /**
   * 首屏载入整段列表（递归扫描当前目录）。
   *
   * 手机上少要一些：这段 JSON 走的是同一个端口，条目越多首屏越慢，而一次
   * 会话里真正能刷完几十条就不错了。触摸/窄屏取 250 条，桌面取 600。
   */
  const feedLimit = () => (window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 720 ? 250 : 600)

  const loadFeed = async (reset) => {
    if (reset) {
      state.feedItems = []
      state.feedLoaded = 0
      state.feedTruncated = false
    }
    const scopeKey = state.feedScope === 'root' ? rootKeyOf(state.key) : state.key
    const payload = await guard('载入播放列表', async () => {
      const result = await api(`/api/scan?k=${encodeURIComponent(scopeKey)}&kinds=image,video&limit=${feedLimit()}&depth=10`)
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return
    const needle = state.filter.trim().toLowerCase()
    const items = (payload.items ?? []).filter((item) => needle === '' || String(item.name).toLowerCase().includes(needle))
    state.feedItems = items
    state.feedTruncated = payload.truncated === true
    state.feedSources = [{ name: payload.root?.label ?? '根目录', rel: payload.rel ?? '' }]
    renderFeed(true)
    const label = currentRoot()?.label ?? ''
    el.feedScope.textContent = state.feedScope === 'root' ? `范围：${label}（整个目录）` : `范围：${payload.rel === '' ? label : String(payload.rel).split('/').pop()}`
  }

  /** 重建 slide 列表；追加时只补新增的部分。 */
  const renderFeed = (reset) => {
    if (reset) {
      teardownFeed()
      clear(el.feedScroller)
      feed.slides = []
      state.feedLoaded = 0
      el.feedEmpty.hidden = state.feedItems.length > 0
      feed.observer = new IntersectionObserver(onFeedIntersect, { root: el.feedScroller, threshold: [0.15, 0.6] })
    }
    const batch = state.feedItems.slice(state.feedLoaded, state.feedLoaded + 12)
    for (const item of batch) {
      const slide = buildSlide(item, state.feedLoaded)
      el.feedScroller.appendChild(slide)
      feed.slides.push(slide)
      feed.observer.observe(slide)
      state.feedLoaded += 1
    }
    updateFeedHud()
    if (state.feedLoaded < state.feedItems.length) {
      feed.sentinel?.remove()
      feed.sentinel = document.createElement('div')
      feed.sentinel.style.height = '1px'
      const sentinelObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          sentinelObserver.disconnect()
          renderFeed(false)
        }
      }, { root: el.feedScroller, rootMargin: '600px' })
      sentinelObserver.observe(feed.sentinel)
      el.feedScroller.appendChild(feed.sentinel)
    }
  }

  /** 一条 slide：图片走定时推进，视频自己播完切下一条。 */
  const buildSlide = (item, position) => {
    const slide = document.createElement('section')
    slide.className = 'slide'
    slide.dataset.position = String(position)
    slide.dataset.key = item.key

    const stage = document.createElement('div')
    stage.className = 'slide-stage'
    slide.appendChild(stage)

    const tap = document.createElement('div')
    tap.className = 'slide-tap'
    const toggleTarget = document.createElement('button')
    toggleTarget.type = 'button'
    toggleTarget.setAttribute('aria-label', '播放 / 暂停')
    tap.appendChild(toggleTarget)
    slide.appendChild(tap)

    const overlay = document.createElement('div')
    overlay.className = 'slide-overlay'
    const meta = document.createElement('div')
    meta.className = 'slide-meta'
    const title = document.createElement('h2')
    title.className = 'slide-title'
    title.textContent = item.name
    const sub = document.createElement('div')
    sub.className = 'slide-sub'
    sub.textContent = `${fmtBytes(item.size)} · ${new Date(item.mtimeMs).toLocaleString()}`
    meta.append(title, sub)

    const rail = document.createElement('div')
    rail.className = 'slide-rail'
    const railButton = (glyph, titleText, onClick) => {
      const node = button('rail-btn', glyph, onClick)
      node.title = titleText
      node.setAttribute('aria-label', titleText)
      return node
    }
    const exit = railButton('▣', '全屏播放（点击后进入完整播放器）', () => openFeedItem(position))
    const download = railButton('⤓', '下载', () => {
      const anchor = document.createElement('a')
      anchor.href = `${BASE}/download?k=${encodeURIComponent(item.key)}`
      anchor.download = item.name
      anchor.click()
    })
    const info = railButton('ⓘ', '文件信息', () => {
      appendActionLog(slide, `${item.rel}\n${item.kind} · ${fmtBytes(item.size)} · ${new Date(item.mtimeMs).toLocaleString()}`)
    })
    rail.append(exit, download, info)
    overlay.append(meta, rail)
    slide.appendChild(overlay)

    const center = document.createElement('div')
    center.className = 'slide-center'
    center.innerHTML = '<span class="bubble"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 4l10 6-10 6z"/></svg></span>'
    slide.appendChild(center)

    const progress = document.createElement('div')
    progress.className = 'slide-progress'
    const fill = document.createElement('i')
    progress.appendChild(fill)
    slide.appendChild(progress)

    // 内容在 slide 进入视口时才挂载，滚动很远的列表不会同时占住几十个解码器。
    slide.mount = () => {
      if (stage.dataset.mounted === '1') return
      stage.dataset.mounted = '1'
      if (item.kind === 'video') {
        const video = document.createElement('video')
        video.playsInline = true
        video.loop = true
        video.preload = 'metadata'
        video.muted = feedMuted
        video.src = item.streamUrl
        video.addEventListener('loadedmetadata', () => {
          slide.duration = video.duration
          const parts = [`${fmtBytes(item.size)}`]
          if (video.videoWidth > 0) parts.push(`${video.videoWidth}×${video.videoHeight}`)
          if (Number.isFinite(video.duration)) parts.push(fmtTime(video.duration))
          sub.textContent = parts.join(' · ')
        }, { once: true })
        video.addEventListener('error', () => {
          const message = document.createElement('div')
          message.style.cssText = 'color:#fff;opacity:.8;text-align:center;padding:0 24px'
          message.textContent = '这个文件的编码浏览器无法直接播放。可以在完整播放器里查看详情，或用支持该编码的播放器打开。'
          stage.appendChild(message)
        })
        stage.appendChild(video)
        slide.video = video
      } else {
        const image = document.createElement('img')
        image.className = 'contain'
        image.loading = position < 4 ? 'eager' : 'lazy'
        image.decoding = 'async'
        image.alt = item.name
        image.src = item.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item.key)}`
        stage.appendChild(image)
        slide.image = image
      }
    }

    slide.unmount = () => {
      if (slide.video !== undefined) {
        slide.video.pause()
        slide.video.removeAttribute('src')
        slide.video.load()
        slide.video.remove()
        slide.video = undefined
      }
      if (slide.image !== undefined) {
        slide.image.remove()
        slide.image = undefined
      }
      stage.dataset.mounted = ''
    }

    slide.activate = () => {
      slide.mount()
      if (slide.video !== undefined) {
        slide.video.muted = feedMuted
        slide.video.currentTime = 0
        slide.video.play().catch(() => {
          slide.video.muted = true
          slide.video.play().catch(() => {})
        })
      }
      feedPaused = false
      slide.classList.add('is-active')
    }

    slide.deactivate = () => {
      slide.classList.remove('is-active')
      if (slide.video !== undefined) slide.video.pause()
    }

    toggleTarget.addEventListener('click', () => {
      if (slide.video === undefined) return
      if (slide.video.paused) {
        slide.video.play().catch(() => {})
        center.classList.remove('show')
      } else {
        slide.video.pause()
        center.classList.add('show')
      }
      feedPaused = slide.video?.paused ?? false
    })
    title.addEventListener('click', () => openFeedItem(position))

    slide.tick = (ratio) => {
      fill.style.width = `${Math.min(ratio * 100, 100).toFixed(2)}%`
    }
    return slide
  }

  /** 右侧「文件信息」气泡。 */
  const appendActionLog = (slide, text) => {
    let node = slide.querySelector('.action-log')
    if (node === null) {
      node = document.createElement('pre')
      node.className = 'action-log stats'
      node.style.left = 'auto'
      node.style.right = '16px'
      slide.appendChild(node)
    }
    node.textContent = text
    node.hidden = false
    clearTimeout(node.timer)
    node.timer = setTimeout(() => {
      node.hidden = true
    }, 5000)
  }

  /** 进入完整播放器播放 feed 里的这一条。 */
  const openFeedItem = (position) => {
    const items = state.feedItems
    const item = items[position]
    if (item === undefined) return
    feedPaused = true
    pauseFeed()
    player.open(items, position)
  }

  /** 视口内可见度最高的 slide 成为「当前」，其余暂停。 */
  const onFeedIntersect = () => {
    const height = el.feedScroller.clientHeight || 1
    let active = null
    let bestRatio = 0
    for (const slide of feed.slides) {
      const rect = slide.getBoundingClientRect()
      const visible = Math.min(rect.bottom, height) - Math.max(rect.top, 0)
      const ratio = visible / height
      if (ratio > bestRatio) {
        bestRatio = ratio
        active = slide
      }
    }
    // 可见度不过半就不切换：滚动过程中不会来回抢播放权。
    if (active === null || bestRatio < 0.55) return
    feed.current = Number(active.dataset.position)
    for (const slide of feed.slides) {
      if (slide === active) slide.activate()
      else slide.deactivate()
    }
    // 只保留当前条前后各一条挂载：留一条是为了滑动时不闪黑，其余立刻拆掉
    // <video>。否则滚过几百条会同时握着几百个解码器，内存直接爆掉。
    const activePosition = feed.current
    for (const slide of feed.slides) {
      const distance = Math.abs(Number(slide.dataset.position) - activePosition)
      if (distance <= 1) slide.mount()
      else if (slide.video !== undefined || slide.image !== undefined) slide.unmount()
    }
    prefetchNeighbours(activePosition)
    updateFeedHud()
  }

  /** 预取邻近图片。 */
  const prefetched = new Map()
  const prefetchNeighbours = (position) => {
    for (const offset of [1, 2]) {
      const item = state.feedItems[position + offset]
      if (item === undefined || item.kind !== 'image') continue
      const url = item.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item.key)}`
      if (prefetched.has(url)) continue
      const image = new Image()
      image.decoding = 'async'
      image.src = url
      prefetched.set(url, image)
      if (prefetched.size > 40) {
        const first = prefetched.keys().next().value
        prefetched.delete(first)
      }
    }
  }

  const updateFeedHud = () => {
    const total = state.feedItems.length
    const position = Number(feed.current ?? 0) + 1
    el.feedProgress.textContent = `${Math.min(position, total)} / ${total}${state.feedTruncated ? '+' : ''}`
  }

  const pauseFeed = () => {
    for (const slide of feed.slides) slide.deactivate()
  }

  const resumeFeed = () => {
    const current = feed.slides.find((slide) => Number(slide.dataset.position) === Number(feed.current))
    current?.activate()
    updateFeedHud()
  }

  const teardownFeed = () => {
    feed.observer?.disconnect()
    feed.observer = null
    for (const slide of feed.slides) slide.unmount?.()
    feed.slides = []
    feed.current = undefined
  }

  /**
   * 刷视频的节拍器：给当前条推进度，图片到点自动切下一条。
   *
   * 后台标签页里没必要跑（手机上一挂后台还烧电），所以隐藏时直接跳过这一
   * 拍；播放器打开时也不碰，免得两个进度条抢同一个 slide。
   */
  const startFeedClock = () => {
    const tick = () => {
      if (document.hidden || state.mode !== 'feed' || player.isOpen()) {
        window.setTimeout(tick, 500)
        return
      }
      const slide = feed.slides.find((candidate) => candidate.classList.contains('is-active'))
      if (slide !== undefined) {
        if (slide.video !== undefined) {
          const duration = slide.video.duration
          if (Number.isFinite(duration) && duration > 0) slide.tick(slide.video.currentTime / duration)
        } else if (slide.image !== undefined) {
          slide.elapsed = (slide.elapsed ?? 0) + 0.25
          const hold = 6
          slide.tick(slide.elapsed / hold)
          // 图片播完自动推进，这就是「刷」的节奏；到末尾时停住。
          if (slide.elapsed >= hold) {
            slide.elapsed = 0
            feedGoTo(feedPosition() + 1)
          }
        }
      }
      window.setTimeout(tick, 250)
    }
    tick()
  }

  /** 刷视频模式的快捷键：上下切换、空格暂停、M 静音等。 */
  const feedKey = (event) => {
    if (state.mode !== 'feed' || player.isOpen()) return
    const target = event.target
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.isContentEditable)) return
    switch (event.key) {
      case 'ArrowDown':
      case 'PageDown':
        feedGoTo(feedPosition() + 1)
        break
      case 'ArrowUp':
      case 'PageUp':
        feedGoTo(feedPosition() - 1)
        break
      case ' ':
        event.preventDefault()
        toggleFeedPlayback()
        break
      case 'm':
      case 'M':
        toggleFeedMute()
        break
      case 'Escape':
        setMode('browse')
        break
      default:
        break
    }
  }

  const toggleFeedPlayback = () => {
    const slide = feed.slides.find((candidate) => candidate.classList.contains('is-active'))
    if (slide?.video === undefined) return
    if (slide.video.paused) slide.video.play().catch(() => {})
    else slide.video.pause()
  }

  const toggleFeedMute = () => {
    feedMuted = !feedMuted
    localStorage.setItem('mv.feedMuted', feedMuted ? '1' : '0')
    for (const slide of feed.slides) {
      if (slide.video !== undefined) slide.video.muted = feedMuted
    }
    el.feedMute.classList.toggle('is-on', feedMuted)
    toast(feedMuted ? '已静音' : '已开启声音')
  }

  // ── 设置抽屉 ────────────────────────────────────────────────────────────

  const drawer = { path: '', writable: false }

  const openDrawer = async () => {
    el.drawer.hidden = false
    await refreshConfig()
    await browseTo(drawer.path || state.session?.roots?.[0]?.path || '')
  }

  const refreshConfig = async () => {
    const payload = await guard('读取配置', async () => {
      const result = await api('/api/config')
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return
    drawer.writable = payload.writable === true
    el.drawerNote.innerHTML = payload.writable
      ? `这里的修改会写进 <code>settings.yaml</code> 的 <code>${payload.namespace}</code> 段，和 dsh 设置页里的「插件配置」是同一份数据。`
      : '当前组合没有挂载设置服务，目录只能在插件的 cordis 补丁行里配置。'
    el.drawerStatus.textContent = payload.writable ? '可编辑' : '只读'
    renderRoots(payload.roots ?? [], payload.configured ?? [], payload.env ?? [])
  }

  const renderRoots = (active, configured, env) => {
    clear(el.rootList)
    if (active.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'root-item'
      empty.innerHTML = '<span class="path">还没有可用的目录</span>'
      el.rootList.appendChild(empty)
    }
    for (const item of active) {
      const row = document.createElement('li')
      row.className = 'root-item'
      const path = document.createElement('span')
      path.className = 'path'
      path.textContent = item.path
      const badge = document.createElement('span')
      badge.className = 'badge'
      badge.textContent = configured.includes(item.path) ? '已配置' : env.includes(item.path) ? '来自环境变量' : '回退目录'
      row.append(path, badge)
      if (drawer.writable) {
        row.appendChild(button('link-btn', '移除', () => void saveRoots(active.filter((other) => other.path !== item.path).map((other) => other.path))))
      }
      el.rootList.appendChild(row)
    }
  }

  const saveRoots = async (paths) => {
    await guard('保存目录', async () => {
      const result = await api('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roots: paths }),
      })
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      await reloadSession()
      await refreshConfig()
      toast('已保存目录')
    })
  }

  const browseTo = async (path) => {
    const payload = await guard('读取目录', async () => {
      const result = await api(`/api/browse?path=${encodeURIComponent(path)}`)
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return
    drawer.path = payload.path
    el.pickerPath.textContent = payload.path === '' ? '选择一个目录（或从盘符开始）' : payload.path
    el.pickerUp.disabled = payload.parent === null
    clear(el.pickerList)
    const rows = payload.path === '' ? payload.folders ?? [] : [{ name: '⬆ 使用这个目录', path: payload.path, use: true }, ...(payload.folders ?? [])]
    for (const folder of rows) {
      const row = document.createElement('div')
      row.className = `picker-row${folder.hidden ? ' is-hidden' : ''}`
      const icon = document.createElement('span')
      icon.textContent = folder.use === true ? '✅' : '📁'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = folder.name
      row.append(icon, name)
      if (folder.configured === true) {
        const tag = document.createElement('span')
        tag.className = 'tag'
        tag.textContent = '已添加'
        row.appendChild(tag)
      }
      if (folder.use === true) {
        row.addEventListener('click', () => void addRoot(folder.path))
      } else {
        row.addEventListener('click', () => void browseTo(folder.path))
      }
      el.pickerList.appendChild(row)
    }
  }

  const addRoot = async (path) => {
    if (drawer.writable) {
      const existing = (state.session?.roots ?? []).map((item) => item.path)
      if (existing.includes(path)) {
        toast('这个目录已经在列表里了')
        return
      }
      await saveRoots([...existing, path])
      await browseTo(path)
      return
    }
    el.rootInput.value = path
    el.rootError.hidden = false
    el.rootError.textContent = '当前组合没有设置服务，请把这一行加到插件的 cordis 补丁里：'
    toast('请把该路径写入插件配置')
  }

  // ── 会话 ────────────────────────────────────────────────────────────────

  const reloadSession = async () => {
    const payload = await guard('读取会话', async () => {
      const result = await api('/api/session')
      if (!result.ok) throw new Error(result.payload.error ?? `HTTP ${result.status}`)
      return result.payload
    })
    if (payload === undefined) return false
    state.session = payload
    // 有没有 ffprobe 决定了卡片元数据走服务端还是浏览器自己读；
    // 有没有 ffmpeg 决定了能不能做封面和悬停动画。
    probeCapability = payload.capabilities?.probing === true
    previewCapability = payload.capabilities?.previews === true
    // 悬停动画的 URL 要带生成配方版本：这条路由也带 24 小时浏览器缓存，
    // URL 不变的话改了取帧位置也还是老片段的缓存。
    previewVersion = String(payload.capabilities?.renderVersion ?? 1)
    if ((payload.roots ?? []).length === 0) {
      el.empty.hidden = false
      el.empty.querySelector('.empty-title').textContent = '还没有配置任何媒体目录'
      el.empty.querySelector('.empty-hint').textContent = '点右上角的设置按钮，选一个装着图片或视频的目录。'
    }
    return true
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  /** 搜索输入的去抖句柄。 */
  let searchTimer = 0

  /** 让工具条上的按钮反映当前状态。 */
  const syncToolbar = () => {
    for (const node of document.querySelectorAll('[data-scope-btn]')) {
      node.classList.toggle('is-active', node.dataset.scopeBtn === state.scope)
    }
    for (const node of document.querySelectorAll('[data-kind-btn]')) {
      node.classList.toggle('is-active', node.dataset.kindBtn === state.kinds)
    }
    for (const node of document.querySelectorAll('[data-group-btn]')) {
      node.classList.toggle('is-active', node.dataset.groupBtn === state.group)
      node.title = node.dataset.groupBtn === 'folder' ? '每个文件夹包成一张卡片，卡片内部仍然平铺' : '文件直接平铺，不分组'
    }
  }

  /** 切换分组方式：平铺 ↔ 按文件夹分组。 */
  const setGroup = (group) => {
    state.group = group === 'folder' ? 'folder' : 'flat'
    localStorage.setItem('mv.group', state.group)
    syncToolbar()
    renderGrid()
    renderSummary()
  }

  /**
   * 切换列出范围：本目录 ↔ 全部层级。
   *
   * 「全部」会递归扫描，所以这里要 await；扫描结果按目录缓存，来回切不会
   * 反复扫盘。
   *
   * @param {'dir'|'all'} scope - 目标范围。
   */
  const setScope = async (scope) => {
    if (scope !== 'dir' && scope !== 'all') return
    if (state.scope === scope) return
    state.scope = scope
    localStorage.setItem('mv.scope', scope)
    syncToolbar()
    if (scope === 'all') await loadScanned(state.key)
    recomputeMedia()
    renderAll()
  }

  /** 切换列出内容：全部 ↔ 只看视频。 */
  const setKinds = (kinds) => {
    state.kinds = kinds === 'video' ? 'video' : 'all'
    localStorage.setItem('mv.kinds', state.kinds)
    syncToolbar()
    recomputeMedia()
    renderSummary()
    renderGrid()
  }

  const bindUi = () => {
    for (const node of document.querySelectorAll('[data-mode-btn]')) {
      node.addEventListener('click', () => setMode(node.dataset.modeBtn))
    }
    syncToolbar()
    for (const node of document.querySelectorAll('[data-scope-btn]')) {
      node.addEventListener('click', () => void setScope(node.dataset.scopeBtn))
    }
    for (const node of document.querySelectorAll('[data-kind-btn]')) {
      node.addEventListener('click', () => setKinds(node.dataset.kindBtn))
    }
    for (const node of document.querySelectorAll('[data-group-btn]')) {
      node.addEventListener('click', () => setGroup(node.dataset.groupBtn))
    }
    el.viewToggle.addEventListener('click', () => {
      state.view = state.view === 'list' ? 'grid' : 'list'
      localStorage.setItem('mv.view', state.view)
      renderGrid()
      renderSummary()
    })
    el.sortToggle.addEventListener('click', () => {
      const order = ['new', 'old', 'name', 'size', 'kind']
      state.sort = order[(order.indexOf(state.sort) + 1) % order.length]
      localStorage.setItem('mv.sort', state.sort)
      recomputeMedia()
      renderSummary()
      renderGrid()
      toast(`排序：${sortLabel[state.sort]}`)
    })
    el.refresh.addEventListener('click', () => {
      if (state.mode === 'feed') void loadFeed(true)
      else void loadListing()
    })
    el.settings.addEventListener('click', () => void openDrawer())
    for (const node of document.querySelectorAll('[data-open-settings]')) node.addEventListener('click', () => void openDrawer())
    bindSidebarResize()
    el.feedAll.addEventListener('click', () => {
      state.feedScope = 'folder'
      localStorage.setItem('mv.feedScope', state.feedScope)
      setMode('feed')
    })
    el.feedScope.addEventListener('click', () => {
      state.feedScope = state.feedScope === 'root' ? 'folder' : 'root'
      localStorage.setItem('mv.feedScope', state.feedScope)
      void loadFeed(true)
    })
    el.feedMute.addEventListener('click', toggleFeedMute)
    el.feedMore.addEventListener('click', () => void loadFeed(true))
    el.feedExit.addEventListener('click', () => setMode('browse'))
    for (const node of document.querySelectorAll('[data-back-browse]')) node.addEventListener('click', () => setMode('browse'))

    el.search.addEventListener('input', () => {
      state.filter = el.search.value
      const url = new URL(window.location.href)
      if (state.filter.trim() !== '') url.searchParams.set('q', state.filter)
      else url.searchParams.delete('q')
      window.history.replaceState(null, '', url)
      if (state.mode === 'feed') {
        // 刷视频模式的列表来自一次递归扫描，逐字触发会打出一串请求。
        clearTimeout(searchTimer)
        searchTimer = setTimeout(() => void loadFeed(true), 300)
        return
      }
      recomputeMedia()
      renderSummary()
      renderGrid()
    })

    // 图片查看器
    el.imageClose.addEventListener('click', () => {
      el.viewer.hidden = true
    })
    el.imagePrev.addEventListener('click', () => showImage(imageState.index - 1))
    el.imageNext.addEventListener('click', () => showImage(imageState.index + 1))
    el.imageZoomIn.addEventListener('click', () => zoomImage(1.25))
    el.imageZoomOut.addEventListener('click', () => zoomImage(0.8))
    el.imageZoomReset.addEventListener('click', () => {
      imageState.scale = 1
      imageState.x = 0
      imageState.y = 0
      applyImageTransform()
    })
    el.imageDownload.addEventListener('click', () => {
      const item = imageItems()[imageState.index]
      if (item === undefined) return
      const anchor = document.createElement('a')
      anchor.href = `${BASE}/download?k=${encodeURIComponent(item.key)}`
      anchor.download = item.name
      anchor.click()
    })
    el.viewerStage.addEventListener('wheel', (event) => {
      event.preventDefault()
      zoomImage(event.deltaY < 0 ? 1.12 : 0.9)
    }, { passive: false })

    // ── 查看器手势 ────────────────────────────────────────────────────────
    //
    // 一个 pointer 映射表同时支撑三件事，比分别监听 touch/mouse 可靠：
    //   · 单指拖动 → 平移（放大后才有意义，否则用来判定翻页）
    //   · 双指分离 → 捏合缩放，焦点保持在双指中心
    //   · 单指横滑（未放大时）→ 上一张 / 下一张
    // 判断「未放大」用 scale <= 1.02，避免浮点误差把翻页吃掉。
    const pointers = new Map()
    /** 手势开始时的 双指距离 / 缩放 / 中心点，捏合全程按它算比例。 */
    let pinchStart = null
    /**
     * 手势起点：记的是手指落下时的屏幕坐标与当时的平移量。翻页判定要用
     * 「手指在屏幕上真正移动了多少」，所以两个基准都要留着。
     */
    let gestureStart = null

    /** 双指当前距离。 */
    const spreadOf = () => {
      const list = [...pointers.values()]
      if (list.length < 2) return 0
      return Math.hypot(list[0].x - list[1].x, list[0].y - list[1].y)
    }

    /** 双指中心。 */
    const midpointOf = () => {
      const list = [...pointers.values()]
      return { x: (list[0].x + list[1].x) / 2, y: (list[0].y + list[1].y) / 2 }
    }

    el.viewerStage.addEventListener('pointerdown', (event) => {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      el.viewerStage.setPointerCapture?.(event.pointerId)
      if (pointers.size === 2) {
        pinchStart = { spread: spreadOf(), scale: imageState.scale, center: midpointOf(), x: imageState.x, y: imageState.y }
        gestureStart = null
        return
      }
      if (pointers.size > 2) return
      gestureStart = { clientX: event.clientX, clientY: event.clientY, baseX: imageState.x, baseY: imageState.y }
      imageState.dragging = true
      imageState.startX = event.clientX - imageState.x
      imageState.startY = event.clientY - imageState.y
      el.viewerStage.classList.add('is-panning')
    })

    el.viewerStage.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

      if (pinchStart !== null && pointers.size >= 2) {
        const spread = spreadOf()
        if (pinchStart.spread <= 0) return
        const ratio = spread / pinchStart.spread
        const next = Math.min(Math.max(pinchStart.scale * ratio, 0.2), 12)
        // 以捏合中心为不动点：先把该点的位置固定住，再按新比例反推平移量。
        const center = midpointOf()
        imageState.scale = next
        imageState.x = pinchStart.x + (center.x - pinchStart.center.x) * (1 - ratio)
        imageState.y = pinchStart.y + (center.y - pinchStart.center.y) * (1 - ratio)
        applyImageTransform()
        return
      }

      if (!imageState.dragging) return
      imageState.x = event.clientX - imageState.startX
      imageState.y = event.clientY - imageState.startY
      applyImageTransform()
    })

    el.viewerStage.addEventListener('pointerup', (event) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinchStart = null
      imageState.dragging = false
      el.viewerStage.classList.remove('is-panning')

      // 未放大时的横向滑动 = 翻页。位移要够大，否则当点击处理。
      if (gestureStart !== null && pointers.size === 0) {
        const dx = event.clientX - gestureStart.clientX
        const dy = event.clientY - gestureStart.clientY
        if (imageState.scale <= 1.02 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          showImage(imageState.index + (dx < 0 ? 1 : -1))
        } else if (imageState.scale <= 1.02) {
          // 没翻页就要把拖动产生的偏移收回去，否则图片会停在半路上。
          imageState.x = gestureStart.baseX
          imageState.y = gestureStart.baseY
          applyImageTransform()
        }
      }
      if (pointers.size === 0) gestureStart = null
    })

    el.viewerStage.addEventListener('pointercancel', (event) => {
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinchStart = null
      if (pointers.size === 0) {
        imageState.dragging = false
        gestureStart = null
        el.viewerStage.classList.remove('is-panning')
      }
    })

    el.viewerStage.addEventListener('dblclick', () => zoomImage(imageState.scale > 1 ? 0 : 2))

    // 设置抽屉
    el.drawerClose.addEventListener('click', () => {
      el.drawer.hidden = true
    })
    el.drawer.addEventListener('click', (event) => {
      if (event.target === el.drawer) el.drawer.hidden = true
    })
    el.drawerReload.addEventListener('click', () => void refreshConfig())
    el.pickerUp.addEventListener('click', async () => {
      const payload = await api(`/api/browse?path=${encodeURIComponent(drawer.path)}`)
      if (payload.ok && typeof payload.payload.parent === 'string') await browseTo(payload.payload.parent)
      else await browseTo('')
    })
    el.rootAdd.addEventListener('submit', (event) => {
      event.preventDefault()
      const value = el.rootInput.value.trim()
      if (value === '') return
      void addRoot(value)
    })

    document.addEventListener('keydown', (event) => {
      const target = event.target
      const typing = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (event.key === '/' && !typing) {
        event.preventDefault()
        el.search.focus()
        return
      }
      if (typing) {
        if (event.key === 'Escape') target.blur()
        return
      }
      if (player.isOpen()) return
      switch (event.key) {
        case 'Escape':
          if (!el.drawer.hidden) el.drawer.hidden = true
          else if (!el.viewer.hidden) el.viewer.hidden = true
          else if (state.mode === 'feed') setMode('browse')
          break
        case 'v':
        case 'V':
          el.viewToggle.click()
          break
        case 's':
        case 'S':
          el.sortToggle.click()
          break
        case 'r':
        case 'R':
          el.refresh.click()
          break
        case 'b':
        case 'B':
          // B 是切换：收起了也能按它回来。
          setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'))
          break
        case 'f':
        case 'F':
          el.feedAll.click()
          break
        default:
          break
      }
      if (!el.viewer.hidden) {
        if (event.key === 'ArrowLeft') showImage(imageState.index - 1)
        if (event.key === 'ArrowRight') showImage(imageState.index + 1)
        if (event.key === '+' || event.key === '=') zoomImage(1.25)
        if (event.key === '-') zoomImage(0.8)
        if (event.key === '0') el.imageZoomReset.click()
        if (event.key === 'd' || event.key === 'D') el.imageDownload.click()
      }
    })

    document.addEventListener('keydown', feedKey)
    window.addEventListener('popstate', () => {
      const url = new URL(window.location.href)
      state.key = url.searchParams.get('k') ?? ''
      state.filter = url.searchParams.get('q') ?? ''
      el.search.value = state.filter
      setMode(url.searchParams.get('mode') === 'feed' ? 'feed' : 'browse')
      void loadListing()
    })
  }

  /**
   * 启动前把所有 id 映射查一遍。
   *
   * 少写一个 id 的后果是「某个模式悄无声息地不工作」——例如漏掉 feedPane
   * 会让刷视频模式渲染完却始终不显示，而且只在运行时抛一句不指向根因的
   * 异常。启动时一次性报出来，比事后猜便宜得多。
   *
   * @returns {string[]} 页面里找不到的 id 列表。
   */
  const missingElements = () => Object.entries(el).filter(([, node]) => node === null || node === undefined).map(([key]) => key)

  // ── 目录栏宽度 ──────────────────────────────────────────────────────────

  // ── 目录栏宽度与折叠 ────────────────────────────────────────────────────

  /**
   * 展开 / 收起目录栏。
   *
   * 收起后左侧会留一条窄栏（`.sidebar-rail`）可以点回来，并且这个状态不再
   * 写进 localStorage——一个「上次收起、这次打开什么都没有」的状态对用户
   * 来说就是坏了。
   *
   * @param {boolean} collapsed - 是否收起。
   */
  const setSidebarCollapsed = (collapsed) => {
    document.body.classList.toggle('sidebar-collapsed', collapsed)
    if (!collapsed) applySidebarWidth(storedSidebarWidth())
  }

  /** 接上收起按钮、细栏和快捷键。 */
  const bindSidebarToggle = () => {
    el.collapseSidebar.addEventListener('click', () => setSidebarCollapsed(true))
    el.sidebarRail.addEventListener('click', () => setSidebarCollapsed(false))
  }
  /** 目录栏默认宽度，与 CSS 的 --sidebar-w 保持一致。 */
  const SIDEBAR_DEFAULT = 320
  /** 可拖动范围：再窄就装不下目录名，再宽就把内容挤没了。 */
  const SIDEBAR_MIN = 200
  const SIDEBAR_MAX = 560

  /** 读回用户上次拖出来的宽度。 */
  const storedSidebarWidth = () => {
    const raw = Number(localStorage.getItem('mv.sidebarW'))
    if (!Number.isFinite(raw) || raw <= 0) return SIDEBAR_DEFAULT
    return Math.min(Math.max(raw, SIDEBAR_MIN), SIDEBAR_MAX)
  }

  /** 把宽度写到根元素的自定义属性上（CSS 变量由 :root 继承给栅格）。 */
  const applySidebarWidth = (width) => {
    const clamped = Math.min(Math.max(Math.round(width), SIDEBAR_MIN), SIDEBAR_MAX)
    document.documentElement.style.setProperty('--sidebar-w', `${clamped}px`)
    return clamped
  }

  /**
   * 拖动分隔条调整目录栏宽度。
   *
   * 目录名常常很长（种子站风格的目录名上百字符），固定宽度必然有人嫌窄有人
   * 嫌宽，所以把这个决定交给用户：拖动改宽度、双击回默认，结果记在本地。
   */
  const bindSidebarResize = () => {
    applySidebarWidth(storedSidebarWidth())
    let dragging = false

    const setFromPointer = (clientX) => {
      // 目录栏从 0 开始，所以指针的 x 就是它想要的宽度。
      applySidebarWidth(clientX)
    }

    const stop = () => {
      if (!dragging) return
      dragging = false
      el.sidebarResizer.classList.remove('is-dragging')
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
      const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || SIDEBAR_DEFAULT
      localStorage.setItem('mv.sidebarW', String(Math.round(current)))
    }

    el.sidebarResizer.addEventListener('pointerdown', (event) => {
      if (document.body.classList.contains('sidebar-collapsed')) return
      dragging = true
      el.sidebarResizer.classList.add('is-dragging')
      // 拖到 iframe / 图片上时不要让指针事件被别的元素接走。
      el.sidebarResizer.setPointerCapture?.(event.pointerId)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      event.preventDefault()
    })
    el.sidebarResizer.addEventListener('pointermove', (event) => {
      if (dragging) setFromPointer(event.clientX)
    })
    el.sidebarResizer.addEventListener('pointerup', stop)
    el.sidebarResizer.addEventListener('pointercancel', stop)
    // 双击回到默认宽度，等于给了一个「我搞乱了怎么回来」的出口。
    el.sidebarResizer.addEventListener('dblclick', () => {
      localStorage.setItem('mv.sidebarW', String(SIDEBAR_DEFAULT))
      applySidebarWidth(SIDEBAR_DEFAULT)
      toast(`目录栏宽度已恢复 ${SIDEBAR_DEFAULT}px`)
    })

    // 窗口变窄时把超出可视范围的宽度收回来，避免内容区被压成一条缝。
    window.addEventListener('resize', () => {
      if (document.body.classList.contains('sidebar-collapsed')) return
      if (window.innerWidth <= 720) return
      const current = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || SIDEBAR_DEFAULT
      const ceiling = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, window.innerWidth - 360))
      if (current > ceiling) applySidebarWidth(ceiling)
    })
  }

  const boot = async () => {
    const missing = missingElements()
    if (missing.length > 0) {
      // 页面和脚本版本不匹配（缓存、半截部署）时最可能发生。
      toast(`页面元素缺失：${missing.join('、')}。请强制刷新（Ctrl+F5）。`, 'error')
      return
    }
    el.body.dataset.view = state.view
    // 折叠状态刻意**不跨会话、也不跨刷新记住**：上次收起来之后，下次打开只
    // 看到一片没有侧栏的页面，而且不知道去哪找回它——用户看到的现象就是
    // 「根本没有侧边栏」。所以每次加载都从展开开始，收起只在本页有效。
    localStorage.removeItem('mv.sidebar')
    sessionStorage.removeItem('mv.sidebar')
    bindUi()
    bindSidebarToggle()
    bindFeedGestures()
    startFeedClock()

    const url = new URL(window.location.href)
    state.key = url.searchParams.get('k') ?? ''
    state.filter = url.searchParams.get('q') ?? ''
    el.search.value = state.filter
    state.mode = url.searchParams.get('mode') === 'feed' ? 'feed' : 'browse'

    const ok = await reloadSession()
    if (!ok) {
      toast('无法连接插件接口，请确认 dsh 正在运行', 'error')
      return
    }
    // 目录树在这里建一次，而且**只**在这里建。
    //
    // 它是「配置了哪些目录」的视图，配置在页面存活期间不会变，所以建一次就够；
    // 之后只有折展（用户点击）和当前行高亮（导航）会动它。放在这里而不是放在
    // renderAll() 里，是因为 renderAll 每次右侧列表加载完都会跑，那样左树就会
    // 跟着右侧列表一遍遍重建——用户看到的现象是「树随着右边的列表在加载」。
    renderTree()
    // 先按 URL 恢复模式；列表模式下才需要先取目录内容。
    if (state.mode === 'feed') {
      setMode('feed')
      return
    }
    await loadListing()
    setMode('browse')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot())
  else void boot()
})()
