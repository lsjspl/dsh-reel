/*
 * dsh-reel — 页面逻辑。
 *
 * 两种模式共用一份「条目」数据：列表模式把它画成网格或列表，刷视频模式把它
 * 画成一屏一条的纵向流。两种模式都从 host 的 JSON 接口取数据，媒体字节统一
 * 走 /reel/stream 的范围响应。
 *
 * 交互约定：所有网络失败都变成一句可读的提示，不留空白页；目录配置只有一份
 * 真相（host 的 reel 设置命名空间），编辑入口在 dsh 设置页的插件卡片里，页面
 * 自己只读。
 */
(() => {
  'use strict'

  const root = (window.Reel = window.Reel || {})
  const { toast, fmtTime, fmtBytes, progressStore, createPlayer } = root
  /**
   * 实际播放地址（player.js 提供）：浏览器不认的容器会改走服务端转码。
   * 页面版本不匹配时退回原始流，而不是让卡片一点就崩。
   */
  const playbackSrc = root.playbackSrc ?? ((item) => item?.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item?.key ?? '')}`)

  const BASE = '/reel'
  const $ = (id) => document.getElementById(id)

  /**
   * 网格瓦片大小：三档，值写成**CSS 表达式**而不是像素。
   *
   * 像素由 CSS 按设备基准算（桌面 200、窄屏 132、小屏 112），所以「中」在任何
   * 设备上都是刚好那一档；「小」是在基准上打折，桌面约 7 列、手机约 4 列。
   * 「大」用 `--tile-wide`：桌面上是 1.4 倍（1440 上 3 列），窄屏那边另有下限，
   * 手机上就是一屏一张（见 CSS 里 --tile-wide 的两条定义）。
   */
  const TILE_VALUES = ['calc(var(--tile-base) * 0.68)', 'var(--tile-base)', 'var(--tile-wide)']
  const TILE_LABELS = ['小', '中', '大']

  /**
   * 目录 / 库那一行的小图标：内联 SVG，不用 emoji。
   *
   * 📁/📚/🗂 这类 emoji 在有些系统字体里缺字形，渲染出来是豆腐块（用户报过
   * 「图标乱码」）。单色 SVG 跟着 currentColor 走，任何字体/主题下都是同一个样子。
   */
  // 文件夹：合着的是背板 + 前挡（上沿平），打开的是背板 + 往外翻的前挡（上沿斜出去，
  // 前面比后面低一档）——一眼能看出这层是开着的。
  const ICON_FOLDER = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.8 1h6.1c.6 0 1.1.5 1.1 1.1v5.9c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1z"/></svg>'
  const ICON_FOLDER_OPEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.1c.3 0 .6.1.8.4l.8 1h6.1c.6 0 1.1.5 1.1 1.1v1.5H1.5z"/><path d="M1.5 6.6h12.9c.5 0 .9.5.8 1l-1 3.9c-.1.6-.7 1-1.3 1H2.7c-.7 0-1.2-.6-1.1-1.3z"/></svg>'
  // 书堆：两本立着（一高一矮）+ 一本斜靠着，比三条竖杠像样得多。
  const ICON_LIBRARY = '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.8" width="3" height="8.8" rx=".7"/><rect x="6.3" y="2.8" width="3" height="9.8" rx=".7"/><rect x="10" y="3.7" width="3" height="8.9" rx=".7" transform="rotate(15 11.5 12.6)"/></svg>'

  const el = {
    body: document.body,
    wallpaper: $('wallpaper'),
    search: $('searchInput'),
    watchRandom: $('watchRandomBtn'),
    sortToggle: $('sortToggle'),
    refresh: $('refreshBtn'),
    tree: $('tree'),
    crumbs: $('crumbs'),
    crumbUp: $('crumbUp'),
    groupExpand: $('groupExpand'),
    groupCollapse: $('groupCollapse'),
    summary: $('summary'),
    grid: $('grid'),
    content: $('content'),
    more: $('more'),
    empty: $('empty'),
    sidebar: $('sidebar'),
    sidebarRail: $('sidebarRail'),
    collapseSidebar: $('collapseSidebar'),
    sidebarResizer: $('sidebarResizer'),
    playAll: $('playAllBtn'),
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
    imageWallpaper: $('imageWallpaper'),
    btnWallpaper: $('btnWallpaper'),
    imageClose: $('imageClose'),
    imageFullscreen: $('imageFullscreen'),
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  const state = {
    /** 会话信息：可用根目录与能力位。 */
    session: null,
    /** 当前目录键；'' 表示第一个根目录。 */
    key: '',
    /** 当前这一层的目录清单（文件 + 子文件夹 + 面包屑）。 */
    listing: null,
    /** 当前列表的媒体条目（已过滤、已排序）。 */
    media: [],
    /** 搜索词，只作用于当前目录。 */
    filter: '',
    /** 排序：new / old / name / size / kind。 */
    sort: localStorage.getItem('mv.sort') ?? 'new',
    /** 视图：grid / list。 */
    view: localStorage.getItem('mv.view') ?? 'grid',
    /** 网格瓦片大小档位（0 小 / 1 中 / 2 大）；实际像素由 CSS 的 --tile 算。 */
    tile: readTile(),
    /** 列出内容：all（图片+视频）、video（只看视频）或 image（只看图片）。 */
    kinds: localStorage.getItem('mv.kinds') ?? 'all',
    /** 递归扫描结果，按目录键缓存（「全部」和「分组」共用同一份）。 */
    scanned: [],
    scannedKey: null,
    scannedTruncated: false,
    /**
     * 内容模式，三选一：
     *  · `current` —— 当前这一层的文件，平铺；
     *  · `all`     —— 递归整棵子树，平铺成一屏；
     *  · `folder`  —— 递归整棵子树，按目录分成**可折展的嵌套分组**。
     *
     * 旧版本这里是 `mv.group`（flat / folder）：那时「递归」还挂在另一枚范围
     * 开关上，两者是正交的。现在合成一个三选一，所以顺手把老值迁过来——选过
     * 「分组」的人打开就是分组，其余人回到「当前」。
     */
    mode: readMode(),
  }

  /** 读回内容模式，并把旧的 `mv.group` 迁进来。 */
  function readMode() {
    const saved = localStorage.getItem('mv.mode')
    if (saved === 'current' || saved === 'all' || saved === 'folder') return saved
    const legacy = localStorage.getItem('mv.group')
    localStorage.removeItem('mv.group')
    return legacy === 'folder' ? 'folder' : 'current'
  }

  /**
   * 读回网格大小档位（见 TILE_VALUES）；没存过或存坏了都回到「中」。
   *
   * 键名是 `mv.tileSize` 而不是 `mv.tile`：早先那版把「没存过」读成了「小」
   * （`Number(null) === 0`），而且一启动就把这个错值写进了盘。换键名等于让
   * 那个错值作废——否则打开过页面的设备会一直停在「小」，光修默认值救不回来。
   */
  function readTile() {
    const raw = localStorage.getItem('mv.tileSize')
    const saved = raw === null ? Number.NaN : Number(raw)
    return Number.isInteger(saved) && saved >= 0 && saved < TILE_VALUES.length ? saved : 1
  }

  /** 「库」的目录键：所有配置目录的聚合视图，也是服务端认识的同一个键。 */
  const LIBRARY_KEY = 'lib'
  const isLibraryKey = (key) => String(key ?? '') === LIBRARY_KEY

  /** 根目录键（'' → 第一个根）。 */
  const rootKeyOf = (key) => String(key ?? '').replace(/^r(\d+).*$/, 'r$1')

  const currentRoot = () => {
    const index = Number(rootKeyOf(state.key).slice(1)) || 0
    return state.session?.roots?.find((item) => item.index === index) ?? state.session?.roots?.[0] ?? null
  }

  /**
   * 库是一个整体，没有「这一层」：选中它时把内容模式从「当前」升级为「全部」。
   *
   * 「当前」在库里的字面含义是「每个根目录这一层」，那几乎没有内容，而用户点
   * 「库」想看的就是全部。升级会写进 localStorage —— 从库再点回某个根目录时
   * 「全部」继续生效，那也正是用户刚才在看的东西。
   */
  const ensureLibraryMode = () => {
    if (!isLibraryKey(state.key) || state.mode !== 'current') return
    state.mode = 'all'
    localStorage.setItem('mv.mode', state.mode)
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

  /** 面包屑下拉的每层子文件夹缓存（key → folders）。 */
  const crumbFoldersCache = new Map()

  /**
   * 深路径里那枚「…」是否已经被用户点开。
   *
   * 只活到下一次导航：摊开是为了点一个中间层级，换目录之后又该回到紧凑形态，
   * 否则「我上次点开过」会一直让路径行变长。不写 localStorage，同上。
   */
  let crumbsExpanded = false

  /**
   * 载入当前目录：这一层的文件 + 子文件夹，以及画路径行要用的根信息。
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
    // 每层的直接子文件夹顺手进缓存：面包屑的下拉菜单要用，导航过的层
    // 再打开菜单就是零请求。
    crumbFoldersCache.set(state.key, payload.folders ?? [])
    // 「全部 / 分组」要先有递归结果才画得出东西。
    if (state.mode !== 'current') await loadRecursive(state.key)
    // 换了目录，分组视图回到「根 + 直接子目录展开」的默认形态：上一棵树的
    // 折展记录对新目录没有意义（键都不一样，留着只会让新树莫名全开着）。
    groupTouched = false
    groupOpen.clear()
    recomputeMedia()
    renderAll()
  }

  /**
   * 递归读这个目录下的全部媒体。
   *
   * 「全部」和「分组」是同一份数据的两种画法，所以只扫一次、按目录键缓存。
   * 上限由服务端兜住，超出时带 `truncated` 回来，摘要里会说明。
   *
   * @param {string} key - 要递归扫描的目录键。
   */
  const loadRecursive = async (key) => {
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

  /**
   * 过滤 + 排序出当前要画的媒体列表。
   *
   * @param {object[]} [pool] - 只在这一份里筛（分组视图按目录分别调用）；
   *   不传就用当前模式的整份来源。
   */
  const computeMedia = (pool) => {
    const source = pool ?? (state.mode === 'current' ? state.listing?.files ?? [] : state.scanned)
    const needle = state.filter.trim().toLowerCase()
    const byKind =
      state.kinds === 'video'
        ? source.filter((item) => item.kind === 'video')
        : state.kinds === 'image'
          ? source.filter((item) => item.kind === 'image')
          : source.filter((item) => item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')
    const filtered = needle === '' ? byKind : byKind.filter((item) => String(item.name).toLowerCase().includes(needle))
    return filtered.slice().sort(comparators[state.sort] ?? comparators.new)
  }

  /** 当前模式下的整份媒体列表（网格、「全部」模式都读它）。 */
  const recomputeMedia = () => {
    state.media = computeMedia()
  }

  /**
   * 重新画整个列表模式。
   *
   * **不含目录树。** 目录树和右边这个列表是两件独立的事：树只在「配置的目录
   * 变了」时建一次，之后只有折展和高亮会动它。早先这里调了 renderTree()，于是
   * 右边每加载一次列表（切目录、翻页）就顺带重画一遍左树——用户看到的
   * 就是「左边的树随着右边的列表一起在加载」。树的加载由它自己的入口负责：
   * 根建好时各拉一次自己的子目录，此后不再自动重来。
   */
  /** 搜索框在库里筛的是整个库，在目录里筛的是当前目录。 */
  const syncSearchPlaceholder = () => {
    el.search.placeholder = isLibraryKey(state.key) ? '筛选整个库（名称）' : '筛选当前目录（名称）'
  }

  const renderAll = () => {
    renderCrumbs()
    renderSummary()
    renderGrid()
    renderMore()
    syncSearchPlaceholder()
    // 只有「当前目录是哪一行」需要跟着导航走，那是一个 class。
    syncTreeActive()
  }

  /**
   * 面包屑：路径就是路径——**点名字直接进那一层**，子文件夹另有一个「▾」。
   *
   * 早先每一级只有一个按钮，点下去弹菜单，真正想去的目录藏在菜单第二行，
   * 于是「去上一级」这种最普通的动作要两步，而「我想去 X 的子目录」这种少见
   * 动作反而只有一步。现在两个动作各有各的按钮：名字走到那一层，▾ 只负责挑
   * 这一级的子文件夹。
   *
   * **每一级的画法只有一种**，当前层也不例外：能折起来的当前层长成
   * 「**名字** ▾」——根目录上就是「⌂ Downloads ▾」，进到子目录就是加粗的
   * 「**codex_tokens**」。早先当前层被单独画成「标记 + 范围徽章」，于是根目录
   * 会同时出现「可点的根」和「当前层标记」两枚同名路径，而子目录只有一枚——
   * 同一件事在两种层级的画法不一样，看着就乱。当前层只差一点：它不能点自己
   * （没有去处），所以不加粗以外的交互、也没有「进入」的提示。
   *
   * 路径深到一行放不下时，**收中间、保两头**：根、当前层，以及当前层的父级
   * 永远直给——它们是「我大概在哪」和「我怎么回去」。中间的层级折成一枚
   * 「…」，悬停是完整路径，点一下摊开；这一枚同时是深路径的兜底出口，所以
   * 路径行永远不会换行，吸顶容器的高度也就不会随路径深度跳。
   */
  const renderCrumbs = () => {
    clear(el.crumbs)
    const listing = state.listing
    // 「‹」能不能用看服务端给的 parent：配置目录根之上是库，库里就没有上一级了。
    // 早先按「当前 key 是不是某个根」判断，于是从根上不去库——可树里库就在根上面。
    el.crumbUp.disabled = listing === null || listing.parent === null || listing.parent === undefined
    if (listing === null) return
    // 服务端的契约：crumbs[0] 是库、crumbs[1] 是配置目录根、最后一级是当前目录。
    // 空数组只可能是旧缓存的服务端配新页面，用当前 key + 根标签兜底，恰好也是
    // 一枚合法的面包屑。
    const crumbs = (listing.crumbs?.length ?? 0) > 0
      ? listing.crumbs
      : [{ key: listing.key, name: listing.root.label }]
    const last = crumbs.length - 1

    /** 这一级值不值得挂「▾」：得真有子文件夹。 */
    const hasChildren = (key) => {
      const cached = crumbFoldersCache.get(key)
      return cached === undefined ? true : cached.length > 0
    }

    const sep = () => {
      const node = document.createElement('span')
      node.className = 'crumb-sep'
      node.textContent = '›'
      node.setAttribute('aria-hidden', 'true')
      el.crumbs.appendChild(node)
    }

    /**
     * 一级路径。**画法只有这一种**：可选图标 + 名字（+ 有子文件夹时的「▾」）。
     *
     * @param {object} crumb - 这一级面包屑 `{key, name}`。
     * @param {number} index - 层级下标：0 是库，1 是配置目录根，再往上才是子目录。
     * @param {boolean} current - 是不是当前所在的那一层。
     */
    const levelNode = (crumb, index, current) => {
      const isRoot = index === 0
      const node = document.createElement('span')
      node.className = `crumb${current ? ' is-current' : ''}`
      if (isRoot) {
        const icon = document.createElement('span')
        icon.className = 'crumb-ico'
        // 库不是文件系统里的房子：给它自己的书堆图标（`⌂` 是普通字形，不是 emoji）。
        icon.innerHTML = crumb.key === LIBRARY_KEY ? ICON_LIBRARY : '⌂'
        icon.setAttribute('aria-hidden', 'true')
        node.appendChild(icon)
      }
      const name = button('crumb-name', crumb.name, current ? undefined : () => navigate(crumb.key))
      // 悬停说明按层级给：库是聚合层，库下面那一枚是配置目录根，再往上才是子目录。
      name.title = current
        ? `${crumb.name}（当前目录）`
        : isRoot
          ? `${crumb.name}（整个库：所有配置目录）`
          : index === 1 && crumbs[0]?.key === LIBRARY_KEY
            ? `${crumb.name}（回到这个根目录）`
            : `进入 ${crumb.name}`
      name.dataset.crumb = crumb.key
      name.dataset.depth = String(index)
      // 当前层不是链接：它就是「你在这」，点了没有去处，所以不挂光标也不响应。
      if (current) name.disabled = true
      node.appendChild(name)
      if (hasChildren(crumb.key)) node.appendChild(foldersButton(crumb, name))
      return node
    }

    /** 折起来的中间层级：一个按钮，点开就把这一段摊平。 */
    const foldNode = (hidden) => {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = 'crumb-fold'
      node.textContent = '…'
      node.dataset.crumbFold = '1'
      // 悬停就把折起来的是哪几级说清楚，不用点也知道省略了什么。
      node.title = `中间还有 ${hidden.length} 级：${hidden.map((crumb) => crumb.name).join(' › ')}\n点击展开这几级`
      node.setAttribute('aria-label', `展开中间的 ${hidden.length} 级路径`)
      node.addEventListener('click', () => {
        crumbsExpanded = true
        renderCrumbs()
      })
      return node
    }

    const append = (crumb, index) => {
      if (index > 0) sep()
      el.crumbs.appendChild(levelNode(crumb, index, index === last))
    }

    // 收中间、保两头：**库、配置目录根、当前层，以及当前层的父级**永远保留——它们
    // 是「我在哪个库、哪个根下」和「我怎么回去」。中间的层级折成一枚「…」。
    const keep = new Set([0, 1, last, last - 1].filter((index) => index >= 0))
    if (!crumbsExpanded && crumbs.length > keep.size + 1) {
      const hidden = crumbs.filter((_, index) => !keep.has(index))
      // 先把要画的节点排好，再统一插分隔符。早先在遍历里无条件 sep()，折起来的
      // 每一级都留下一枚没人要的「›」，路径行就成了「› › › ›」；「…」还钉死在
      // 第二枚的位置上，保留下来的层级一变位置就错。
      const shown = []
      let folded = false
      crumbs.forEach((crumb, index) => {
        if (keep.has(index)) {
          shown.push({ crumb, index })
          return
        }
        if (!folded) {
          shown.push({ fold: foldNode(hidden) })
          folded = true
        }
      })
      shown.forEach((entry, position) => {
        if (position > 0) sep()
        el.crumbs.appendChild(entry.fold ?? levelNode(entry.crumb, entry.index, entry.index === last))
      })
      return
    }
    crumbs.forEach((crumb, index) => append(crumb, index))
  }

  /** 「▾」：只负责挑这一级的子文件夹，不负责导航。 */
  const foldersButton = (crumb, labelNode) => {
    const node = button('crumb-chevron', '▾', () => void openFolderMenu(node, crumb, { force: false }))
    node.title = `展开「${crumb.name}」里的子文件夹`
    node.setAttribute('aria-label', `${crumb.name} 的子文件夹`)
    node.setAttribute('aria-haspopup', 'menu')
    node.dataset.crumbChevron = crumb.key
    // 键盘 Tab 走到 ▾ 时，把这一级的名字一起点亮，看起来仍是同一级。
    node.addEventListener('focus', () => labelNode.parentElement?.classList.add('is-focused'))
    node.addEventListener('blur', () => labelNode.parentElement?.classList.remove('is-focused'))
    return node
  }

  /**
   * 打开一个挂在 body 上的浮层菜单：处理定位（锚点下缘，视口内收拢）和
   * 外点 / Escape 关闭。菜单内容的填充由调用方负责。
   *
   * @param {HTMLElement} anchor - 锚点元素。
   * @returns {{menu: HTMLElement, position: () => void, closeNow: () => void}}
   */
  const openAnchorMenu = (anchor) => {
    document.querySelector('.crumb-menu')?.remove()
    const menu = document.createElement('div')
    menu.className = 'crumb-menu'
    document.body.appendChild(menu)
    const position = () => {
      const rect = anchor.getBoundingClientRect()
      menu.style.top = `${Math.round(Math.min(rect.bottom + 6, innerHeight - menu.offsetHeight - 8))}px`
      menu.style.left = `${Math.round(Math.max(8, Math.min(rect.left, innerWidth - menu.offsetWidth - 8)))}px`
    }
    position()
    const closeNow = () => {
      menu.remove()
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', close, true)
    }
    const close = (event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return
      } else if (event.target instanceof Node && (menu.contains(event.target) || anchor.contains(event.target))) {
        return
      }
      closeNow()
    }
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', close, true)
    // 菜单打开后方向键直接进菜单（Tab 会先经过 ▾ 自己）。
    menu.tabIndex = -1
    menu.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = [...menu.querySelectorAll('.crumb-menu-item')]
      if (items.length === 0) return
      event.preventDefault()
      const at = items.indexOf(document.activeElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = at === -1 ? (step === 1 ? 0 : items.length - 1) : (at + step + items.length) % items.length
      items[next].focus()
    })
    return { menu, position, closeNow }
  }

  /**
   * 往菜单里铺这一级的子文件夹，点一个就进那个文件夹。
   *
   * 子文件夹多的时候（D 盘根目录那种）给一个筛选框：这里是「进某个子目录」的
   * 主要入口，靠滚动找几十个名字不现实。数据本来就带着每个子目录的直接媒体
   * 数，顺手显示出来，用户能跳过空目录。
   *
   * @param {{menu: HTMLElement, position: () => void, closeNow: () => void}} view - openAnchorMenu 的返回。
   * @param {object[]} folders - 这一级的子文件夹（可能带 mediaCount）。
   * @param {string} parentName - 这一级的名字，用于空状态文案。
   * @param {{busy?: boolean, host?: HTMLElement}} [options] - busy: 清单还没到，先给一句解释；host: 只往这个容器里画，默认画进菜单。
   */
  const fillMenuWithFolders = (view, folders, parentName, options = {}) => {
    const { menu, position, closeNow } = view
    const host = options.host ?? menu
    clear(host)
    const searchable = folders.length >= 10
    let query = ''

    const input = searchable
      ? Object.assign(document.createElement('input'), {
        type: 'search',
        className: 'crumb-menu-search',
        placeholder: '筛选子文件夹…',
        spellcheck: false,
        autocomplete: 'off',
      })
      : null

    /** 画清单（筛选后）。查询词变化时整段重画，不重算 DOM。 */
    const paint = () => {
      for (const node of host.querySelectorAll('.crumb-menu-item, .crumb-menu-pending')) node.remove()
      const needle = query.trim().toLowerCase()
      const shown = needle === '' ? folders : folders.filter((folder) => String(folder.name).toLowerCase().includes(needle))
      if (shown.length === 0) {
        const none = document.createElement('div')
        none.className = 'crumb-menu-pending'
        none.textContent = folders.length === 0 ? `「${parentName}」里没有子文件夹` : '没有匹配的子文件夹'
        host.appendChild(none)
      }
      for (const folder of shown) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'crumb-menu-item'
        row.dataset.folderEntry = folder.key
        const label = document.createElement('span')
        label.className = 'crumb-menu-name'
        label.textContent = folder.name
        label.title = folder.name
        row.appendChild(label)
        if (Number.isFinite(folder.mediaCount)) {
          const tally = document.createElement('span')
          tally.className = 'crumb-menu-tally'
          tally.textContent = folder.mediaCount === 0 ? '空' : `${folder.mediaCount} 个`
          row.appendChild(tally)
        }
        row.addEventListener('click', () => {
          closeNow()
          navigate(folder.key)
        })
        host.appendChild(row)
      }
      position()
    }

    if (input !== null) {
      input.addEventListener('input', () => {
        query = input.value
        paint()
      })
      host.appendChild(input)
      // 一打开就能打字：这个入口的存在意义就是少滚几次。
      input.focus({ preventScroll: true })
    }
    if (options.busy === true && folders.length === 0) {
      const pending = document.createElement('div')
      pending.className = 'crumb-menu-pending'
      pending.textContent = '正在载入子文件夹…'
      host.appendChild(pending)
      position()
      return
    }
    paint()
  }

  /**
   * 某个目录的直接子文件夹，按层缓存。
   *
   * 每一级的「▾」都可能被点开，而当前 listing 只覆盖当前层；祖先层的子文件夹
   * 要么从缓存来，要么现场拉一次（都是一层的目录清单，很快）。
   *
   * 两个细节：
   *  · 服务端的 `folders[].key` 只会出现在「当前目录」的 listing 里，别层的
   *    folders 只有名字——所以这里按 `parentKey + 名字` 自己拼 key，不依赖
   *    listing 的上下文。
   *  · 列过的目录顺手进缓存，导航过的层再点「▾」就是零请求；但从 listing 里
   *    顺手缓存的那份**没有 mediaCount**，那种残份只当缓存用，点「▾」时重拉
   *    一次完整清单，好把每个子目录里有几个文件显示出来。
   *
   * @param {string} key - 目录键。
   * @returns {Promise<object[]>} 该层的子文件夹（失败时为空数组）。
   */
  const crumbFoldersOf = async (key, slim) => {
    if (slim !== true) {
      const hit = crumbFoldersCache.get(key)
      if (hit !== undefined && hit.every((folder) => Number.isFinite(folder.mediaCount))) return hit
    }
    const suffix = key === '' ? '' : '/'
    const join = (name) => `${key}${suffix}${String(name).split('/').map(encodeURIComponent).join('/')}`
    const result = await api(`/api/list?k=${encodeURIComponent(key)}`).catch(() => null)
    const rows = result !== null && result.ok ? result.payload.folders ?? [] : []
    const folders = rows.map((folder) => ({
      key: typeof folder.key === 'string' && folder.key !== '' ? folder.key : join(folder.name),
      name: folder.name,
      ...(Number.isFinite(folder.mediaCount) ? { mediaCount: folder.mediaCount } : {}),
    }))
    crumbFoldersCache.set(key, folders)
    return folders
  }

  /**
   * 点「▾」弹出的菜单：**只有子文件夹**。
   *
   * 菜单里只放「从这一级往下走」：挑一个子文件夹进去。导航（去这一层、回根、
   * 回上一级）已经在路径行上了，菜单里再来一遍就是同一件事画两处。
   *
   * @param {HTMLElement} anchor - 这一级的「▾」按钮。
   * @param {{name: string, key: string}} crumb - 这一级面包屑。
   * @param {{force?: boolean}} [options] - force: 只用手上的缓存，不发请求。
   */
  const openFolderMenu = async (anchor, crumb, options = {}) => {
    const view = openAnchorMenu(anchor)
    const { menu, position, closeNow } = view

    const head = document.createElement('div')
    head.className = 'crumb-menu-head'
    head.textContent = crumb.name
    head.title = crumb.name
    menu.appendChild(head)

    // 清单单独有个容器：先拿缓存画一版，请求回来了整段替换，不用去猜哪些
    // 节点是清单、哪些是表头。
    const host = document.createElement('div')
    menu.appendChild(host)
    const cached = crumbFoldersCache.get(crumb.key)
    fillMenuWithFolders(view, cached ?? [], crumb.name, { busy: cached === undefined, host })
    if (options.force === true) return
    if (cached !== undefined && cached.every((folder) => Number.isFinite(folder.mediaCount))) return
    const folders = await crumbFoldersOf(crumb.key)
    // 等待期间菜单可能已被关掉（比如用户点了别处又触发了导航）。
    if (!menu.isConnected) return
    fillMenuWithFolders(view, folders, crumb.name, { host })
  }

  /**
   * 摘要行：把「列出范围 / 数量 / 筛选 / 排序」讲成一句话。
   *
   * 这里是**唯一**说数量的地方。分组视图原本另有一条统计条也在报总数，两条
   * 并排出现时数字还不一样（一条是筛选后的、一条是原始的），看着像打架——所以
   * 分组那边只留「展开全部 / 折叠全部」两个动作，不再报数。
   */
  const renderSummary = () => {
    const listing = state.listing
    if (listing === null) {
      el.summary.textContent = ''
      return
    }
    const parts = []
    if (state.mode === 'current') {
      parts.push(`${listing.folders?.length ?? 0} 个文件夹`)
      parts.push(`${state.kinds === 'video' ? listing.files?.filter((item) => item.kind === 'video').length ?? 0 : state.kinds === 'image' ? listing.files?.filter((item) => item.kind === 'image').length ?? 0 : listing.fileCount} 个${kindLabel()}`)
    } else {
      parts.push(`${state.media.length} 个${kindLabel()}（含所有子目录）`)
      if (state.scannedTruncated) parts.push('已达扫描上限，只列出一部分')
    }
    if (state.filter.trim() !== '') parts.push(`筛选出 ${state.media.length} 个`)
    parts.push(`排序：${sortLabel[state.sort] ?? state.sort}`)
    el.summary.textContent = parts.join(' · ')
  }

  // 子文件夹的行列表整个移除了：路径行每一级的「▾」就是子文件夹的入口，
  // 同一份信息不再画两遍。

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
  let probeTimer = 0

  /**
   * 把一条媒体排进批量探测队列。
   *
   * 去重靠「条目自己有没有数据」，**不**靠「这个 key 问过没有」：每次重新扫描
   * （换目录、切内容模式、进出库）都会造出一批新对象，按 key 记「问过」会让
   * 新对象永远补不上时长和尺寸——现象就是列表里「有的视频有时长、有的没有」，
   * 而且刷新几次显示的还不一样。
   */
  const queueProbe = (item) => {
    if (item.duration !== undefined) return
    probeQueue.set(item.key, item)
    clearTimeout(probeTimer)
    probeTimer = setTimeout(() => void flushProbes(), 120)
  }

  /** 发出这一批探测请求，并把结果写回条目与卡片。 */
  const flushProbes = async () => {
    if (probeQueue.size === 0) return
    const batch = [...probeQueue.entries()].slice(0, 200)
    for (const [key] of batch) probeQueue.delete(key)
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
      // 写进「按 key 存的那一份」：队列里可能还攥着上一批渲染留下的旧对象，
      // 而卡片和播放器都从 itemByKey 取条目——写旧对象等于没写，列表里的
      // 时长/尺寸就永远补不上。
      const target = itemByKey.get(key) ?? item
      if (meta.duration !== undefined) target.duration = meta.duration
      if (meta.width !== undefined) {
        target.width = meta.width
        target.height = meta.height
      }
      refreshCard(key)
      // 播放器可能正停在一条上（甚至是暂停状态）：探测回来的时长要立刻反映
      // 到进度条和统计里，不能等下一次播放中的 timeupdate。
      player?.refreshMeta?.()
    }
    if (probeQueue.size > 0) probeTimer = setTimeout(() => void flushProbes(), 120)
  }

  /** 按 key 找到已渲染的卡片并刷新它的派生显示。 */
  const refreshCard = (key) => {
    const card = el.grid.querySelector(`.card[data-key="${CSS.escape(key)}"]`)
    card?.applyMeta?.()
  }

  /**
   * 见过面的条目，按 key 存一份。
   *
   * 为什么需要：分组视图里的卡片是**单独**把每个子目录拉回来画的，这些条目
   * 不在 `state.media` 里。而「点开谁」现在只认卡片上的 key——没有这张表，
   * 那些 key 就查不到条目，点开又会退回列表第一条（这正是原来那个 bug 的
   * 另一面）。表很小（一个条目就是服务端给的那个对象），并且有上限保护。
   */
  const itemByKey = new Map()

  /** 记下一个画过卡片的条目。 */
  const rememberItem = (item) => {
    if (item === null || typeof item !== 'object' || typeof item.key !== 'string') return
    if (itemByKey.size > 8000) itemByKey.clear()
    itemByKey.set(item.key, item)
  }

  /**
   * 文件名的扩展名，大写；没有扩展名时返回 null。
   *
   * @param {string} name - 文件名。
   * @returns {string|null} 形如 `MP4` 的格式标签。
   */
  const formatOf = (name) => {
    const match = /\.([a-z0-9]{1,5})$/i.exec(String(name ?? ''))
    return match === null ? null : match[1].toUpperCase()
  }

  /**
   * 媒体卡片：图片直接懒加载，视频先显示元数据徽标。
   *
   * 卡片只认 key，**不认下标**。曾经这里存的是 `state.media` 里的位置、点击时
   * 再拿它回查 `state.media[下标]`；分组视图里那些懒加载出来的卡片根本不在
   * `state.media` 里，下标算不出来就兜底成 0，于是「点哪个视频都播第一个」。
   * key 是这条媒体自己的身份，不存在这个问题。
   *
   * @param {object} item - 这一条媒体（服务端给的条目）。
   * @param {{compact?: boolean, where?: string}} [options] - compact: 用在更紧凑的容器里；
   *   where: 卡片来自哪个目录（分组视图传，卡片上标一行来源路径）。
   */
  const buildCard = (item, options = {}) => {
    const compact = options.compact === true
    rememberItem(item)
    const card = document.createElement('article')
    card.className = `card card-${item.kind}${compact ? ' is-compact' : ''}`
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
      // 用字形而不是 emoji：有些系统字体里 🎬/🖼 是豆腐块（用户报过「图标乱码」）。
      fallback.textContent = item.kind === 'audio' ? '♪' : '▣'
      media.appendChild(fallback)
    })
    // 有封面就用封面（服务端取视频中间帧），否则退回范围流：浏览器只为
    // 第一帧取它需要的字节，不会下载整集。
    image.src = item.thumbUrl ?? item.streamUrl ?? ''
    if (image.src === '') media.classList.add('no-poster')
    media.appendChild(image)

    const badge = document.createElement('span')
    badge.className = 'kind-badge'
    badge.textContent = item.kind === 'video' ? '▶ 视频' : item.kind === 'audio' ? '♪ 音频' : '▣ 图片'
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
    const metaText = document.createElement('span')
    metaText.textContent = `${fmtBytes(item.size)} · ${new Date(item.mtimeMs).toLocaleString()}`
    meta.appendChild(metaText)
    // 视频的容器格式做成一枚小标签，跟在信息行的时间后面：一个库里混着
    // mp4/avi/mkv 时，一眼就能看出哪些是浏览器打不开、要走服务端边转边播的。
    const format = item.kind === 'video' ? formatOf(item.name) : null
    if (format !== null) {
      const chip = document.createElement('span')
      chip.className = 'format-chip'
      chip.textContent = format
      chip.title = `容器格式：${format}`
      meta.appendChild(chip)
    }
    info.append(name, meta)
    // 分组视图里卡片嵌在目录分组内，来源路径只能靠组头表达；但一组里也可能混着
    // 更深的目录（嵌套折叠时看不清在哪一级），所以这一行照旧标出来，点它跳过去。
    const where = typeof options.where === 'string' && options.where !== '' ? options.where : null
    if (where !== null) {
      const node = document.createElement('div')
      node.className = 'card-where'
      node.textContent = where
      node.title = where
      node.addEventListener('click', (event) => {
        event.stopPropagation()
        navigate(`r${item.root}/${where.split('/').map(encodeURIComponent).join('/')}`)
      })
      info.appendChild(node)
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
      metaText.textContent = bits.join(' · ')
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
      if (item.kind === 'image') openImage(item.key)
      else openPlayer(item.key)
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

  // ── 分组卡片的加载参数 ───────────────────────────────────────────────────
  //
  // 组内的网格和平铺用同一套列宽（--tile）：曾经试过「文件少 → 列宽大」的
  // 自适应，结果一个文件、几个文件、一堆文件的文件夹各长各样，用户点名嫌
  // 乱。统一之后组与组之间只有「卡片的多少」这一个变量。

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

  // ── 平铺网格分块窗口化 ─────────────────────────────────────────────────────
  //
  // 大目录滚动的卡顿主因不是 DOM 数量（隐藏全部缩略图后三千卡照样丝滑），而是
  // 滚动过程把几千张缩略图连续灌进加载+解码管线，解码全落在主线程上。所以把
  // 平铺网格拆成块：只挂载视口附近 ±1 块，远处的块折成定高占位。同时活着的图
  // 压在几百张以内；往回滚时块再重建，缩略图走 HTTP 缓存，只付解码这一道钱。
  //
  // 每块是**自己**的一个网格，所以块边界只能落在整行上：块内张数若不整除列数，那
  // 半行永远没有卡片来填，滚到块边界就是「视频后面凭空多出一行」。列数随窗口宽度
  // 变，所以块大小、占位高度都得跟着它走（见 gridColumns / chunkSizeFor）。

  /** 一块大概多大。真正的张数会被「列数的整数倍」上调或下调（见 chunkSizeFor）。 */
  const CHUNK_SIZE = 120

  /**
   * 网格现在有几列。
   *
   * 每个块是**自己**的一个网格（见 CSS），所以块的最后一行能不能填满，取决于块内
   * 张数能否整除列数——不能整除时那半行永远空着，滚到块边界就是「视频后面凭空多出
   * 一行」。列数只在布局之后才存在（窗口、目录栏宽度都在变），插一把尺子量最省事。
   *
   * @returns {number} 列数；列表视图恒为 1。
   */
  const gridColumns = () => {
    // 读 state.view 而不是 body 上的 data-view：那个属性是在画完之后才写的，切换
    // 视图的那一次渲染里它还是上一个视图的值。
    if (state.view === 'list') return 1
    const ruler = document.createElement('div')
    ruler.className = 'grid-chunk'
    const cell = document.createElement('div')
    ruler.appendChild(cell)
    el.grid.appendChild(ruler)
    const styles = getComputedStyle(ruler)
    const gap = Number.parseFloat(styles.columnGap) || 0
    const cellWidth = cell.getBoundingClientRect().width
    const width = ruler.getBoundingClientRect().width
    ruler.remove()
    if (cellWidth <= 0 || width <= 0) return 1
    return Math.max(1, Math.round((width + gap) / (cellWidth + gap)))
  }

  /**
   * 一个块装几张：**列数的整数倍**，并尽量接近 CHUNK_SIZE。
   *
   * 整除列数，块与块之间才接得上。列数少的宽屏上它就是 120 上下；列数多到比 120
   * 还多时退回「一块一行」。
   *
   * @param {number} columns - 网格列数。
   * @returns {number} 每块的张数。
   */
  const chunkSizeFor = (columns) => Math.max(columns, Math.round(CHUNK_SIZE / columns) * columns)

  /** 最近一次量到的卡片高度。渲染时网格里还是上一屏（或空），只有画完才量得准。 */
  let cardHeightSeen = 0

  /** 一张卡多高：优先用上一次量到的实测值，没有（首屏）才用过时的常数。 */
  const cardHeight = () => {
    if (cardHeightSeen > 0) return cardHeightSeen
    return state.view === 'list' ? 86 : 220
  }

  /**
   * 未挂载块的占位高度：行数 ×（卡高 + 行间距）。
   *
   * 早先按「张数 × 单卡高」算，等于假设一行只站一张卡——五列时占位比实高多出七倍，
   * 滚过未挂载区就是几屏假空白，滚动条也跟着骗人。
   *
   * @param {number} count - 这一块有多少张。
   * @param {number} columns - 网格列数。
   * @returns {number} 高度（像素）。
   */
  const placeholderHeight = (count, columns) => {
    const rows = Math.max(1, Math.ceil(count / columns))
    const gap = columns === 1 ? 2 : 12
    return rows * (cardHeight() + gap) - gap
  }

  let chunks = []
  let chunkObserver = null
  /** 画这批块时的列数：块的边界只对当时的列数成立。 */
  let chunkColumns = 0
  let gridObserver = null
  let gridResizeTimer = null
  /** 上一次观察到的网格宽度：宽度没变就不会换列数，回调里先比它，省掉一次测量。 */
  let gridWidthSeen = -1

  const disposeCardsIn = (root) => {
    for (const card of root.querySelectorAll('.card')) {
      const dispose = cardDisposers.get(card)
      if (dispose) {
        dispose()
        cardDisposers.delete(card)
      }
    }
  }

  /**
   * 把块折回定高占位。
   *
   * **视口里的块绝不拆。** 拆完它的可见性没有任何变化，IntersectionObserver 不会
   * 为「没变化」再发一次通知，于是它永远等不到重新挂载——现象就是「滑着滑着凭空
   * 空出一大块，往回滑还是一片空」，而且那块空位会一直跟着你。所以拆之前必须问过
   * entry.intersecting（见 ensureChunkObserver）。
   *
   * @param {object} entry - 块记录。
   */
  const unmountChunk = (entry) => {
    if (!entry.mounted || entry.intersecting) return
    disposeCardsIn(entry.el)
    entry.el.style.height = `${entry.el.offsetHeight}px`
    entry.el.classList.add('is-unmounted')
    entry.el.replaceChildren()
    entry.mounted = false
  }

  const mountChunk = (entry) => {
    if (entry.mounted) return
    entry.el.classList.remove('is-unmounted')
    entry.el.style.height = ''
    const fragment = document.createDocumentFragment()
    for (let index = entry.from; index < entry.to; index++) {
      fragment.appendChild(buildCard(state.media[index]))
    }
    entry.el.replaceChildren(fragment)
    entry.mounted = true
    // 同时挂载的块数钉在 ±1：滚远的块立刻拆掉，图片才不会越积越多。
    // 「远」按**块在列表里的相邻关系**算（下标），不按张数：末尾那块张数少，拿它
    // 的张数当尺子会把整块大的邻块也判成滚远了——那一刻邻块往往还在视口里。
    const position = chunks.indexOf(entry)
    for (let index = 0; index < chunks.length; index += 1) {
      if (Math.abs(index - position) <= 1) continue
      unmountChunk(chunks[index])
    }
  }

  /**
   * 造一个块。第一块立刻挂载（首屏总得先看见东西），其余折成定高占位。
   *
   * @param {number} from - 起始下标。
   * @param {number} to - 结束下标（不含）。
   * @param {number} columns - 当时的网格列数。
   * @returns {HTMLElement} 块元素。
   */
  const makeChunk = (from, to, columns) => {
    const el = document.createElement('div')
    el.className = 'grid-chunk'
    // intersecting 由观察者两个方向都写：拆块时要靠它避开视口里的块。
    const entry = { el, from, to, columns, mounted: false, intersecting: false }
    // 先入列再挂载：mountChunk 靠「在列表里隔了几块」判断远近，那会儿它就得在列里。
    const first = chunks.length === 0
    chunks.push(entry)
    if (first) {
      mountChunk(entry)
    } else {
      el.classList.add('is-unmounted')
      el.style.height = `${placeholderHeight(to - from, columns)}px`
    }
    chunkObserver?.observe(el)
    return el
  }

  const teardownChunks = () => {
    chunkObserver?.disconnect()
    chunkObserver = null
    for (const entry of chunks) disposeCardsIn(entry.el)
    chunks = []
  }

  const ensureChunkObserver = () => {
    if (chunkObserver !== null) return
    chunkObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const record = chunks.find((item) => item.el === entry.target)
        if (record === undefined) continue
        // 相交状态两个方向都记：离开视野也要记，否则 unmountChunk 会以为它还在
        // 视口里，滚远的块就永远拆不掉（同时挂着的缩略图越积越多）。
        record.intersecting = entry.isIntersecting
        if (entry.isIntersecting && !record.mounted) mountChunk(record)
      }
    }, { root: el.content, rootMargin: '900px' })
  }

  /**
   * 续页：把刚拉回来的一页补进网格。
   *
   * 尾部那块如果还没装满，就**并进去**而不是另起一块——另起一块的话，前一块会剩
   * 下不满的一行，而它后面还有内容，那半行就永远填不上了（用户看到的就是「视频后
   * 面空了一行」）。攒满一整块之后才开新块，新块从满行开始。
   *
   * @param {number} previous - 这一页之前已有的条数。
   */
  const growChunks = (previous) => {
    const columns = chunkColumns > 0 ? chunkColumns : gridColumns()
    const size = chunkSizeFor(columns)
    const tail = chunks[chunks.length - 1]
    let from = previous
    if (tail !== undefined && tail.to === previous && tail.to < tail.from + size) {
      const wanted = Math.min(tail.from + size, state.media.length)
      const fragment = tail.mounted ? document.createDocumentFragment() : null
      for (let index = tail.to; index < wanted; index++) {
        if (fragment !== null) fragment.appendChild(buildCard(state.media[index]))
      }
      tail.to = wanted
      if (fragment === null) tail.el.style.height = `${placeholderHeight(wanted - tail.from, columns)}px`
      else tail.el.appendChild(fragment)
      from = wanted
    }
    for (let start = from; start < state.media.length; start += size) {
      el.grid.appendChild(makeChunk(start, Math.min(start + size, state.media.length), columns))
    }
    calibrateChunks()
  }

  /**
   * 列数变了就重画平铺网格。
   *
   * 块是按列数切出来的：拖一下目录栏、转一下窗口，列数一变，原来的边界就不再整除
   * 列数，末尾又会空出半行。宽度没变时立刻返回——挂载/卸载引起的尺寸变化也会惊动
   * 这个观察器，那条路径必须便宜。
   */
  const watchGridColumns = () => {
    if (typeof ResizeObserver !== 'function' || gridObserver !== null) return
    gridObserver = new ResizeObserver((entries) => {
      const width = Math.round(entries[entries.length - 1].contentRect.width)
      if (width === gridWidthSeen) return
      gridWidthSeen = width
      clearTimeout(gridResizeTimer)
      gridResizeTimer = setTimeout(() => {
        // 刷视频模式里浏览区是隐藏的（宽度 0），这时候重画网格没有意义。
        if (state.mode === 'folder') return
        if (gridColumns() === chunkColumns) return
        renderGrid()
      }, 180)
    })
    gridObserver.observe(el.grid)
  }

  /**
   * 画完之后校准：拿**这一屏**的卡片量一次高度，再把没挂载的块按实测值重算。
   *
   * 渲染过程中量不到准数（网格里还是上一屏的卡片，首屏干脆是空的），所以占位高度
   * 一律在这时候对齐一次。整个函数是同步的，浏览器只画一帧，看不到中间态。
   */
  const calibrateChunks = () => {
    if (chunks.length === 0) return
    const card = el.grid.querySelector('.card')
    if (card === null) return
    const height = Math.round(card.getBoundingClientRect().height)
    if (height <= 0 || height === cardHeightSeen) return
    cardHeightSeen = height
    for (const entry of chunks) {
      if (entry.mounted) continue
      entry.el.style.height = `${placeholderHeight(entry.to - entry.from, entry.columns)}px`
    }
  }

  /** 平铺渲染：符合条件的文件拆成块，首块立即可见，其余等滚动到再挂载。 */
  const renderFlatGrid = (host = el.grid) => {
    el.empty.hidden = state.media.length > 0 || state.listing === null
    if (!el.empty.hidden) {
      el.empty.querySelector('.empty-title').textContent = isLibraryKey(state.key)
        ? `库里没有${kindLabel()}`
        : `这个目录里没有${kindLabel()}`
    }
    teardownChunks()
    ensureChunkObserver()
    watchGridColumns()
    const columns = gridColumns()
    chunkColumns = columns
    const size = chunkSizeFor(columns)
    for (let from = 0; from < state.media.length; from += size) {
      host.appendChild(makeChunk(from, Math.min(from + size, state.media.length), columns))
    }
  }

  // ── 分组视图：递归 + 可折展 ──────────────────────────────────────────────
  //
  // 「分组」= 把递归扫到的整棵子树按目录摊开：一个目录一个分组，目录里还有
  // 子目录就**嵌在里面**，任意一层都能折起来。
  //
  // 一个分组的信息都在组头那一行：三角、图标、目录名、媒体数。**点组头折展**，
  // 组头右边的「打开 ›」才是「进这个目录」——折展和导航是两件事，早先把它们压
  // 在同一个点击上，两边都别扭。

  /**
   * 用户手动动过折展没有。
   *
   * 动过之后一律听用户的；没动过则每次重画都给「根 + 直接子目录展开」的默认
   * 视图。用「动过没有」而不是「集合空不空」来判断，是因为「折叠全部」正好会
   * 把集合清空——按后者判断的话，用户一折起全部，下一次重画又全给展开了。
   */
  let groupTouched = false
  /** 用户显式折起来的目录键（在 treeOpen 之外单独记，因为默认值与它无关）。 */
  const groupOpen = new Set()

  /**
   * 把递归扫到的条目按目录拼成一棵树。
   *
   * 只有文件的层级也会出现：扫描结果平铺地给出每条文件的 `rel`，沿路径逐级建
   * 节点，中间目录自然就长出来了。空目录不出现——没有文件就没有路径，这正是
   * 分组视图该有的样子。
   *
   * @param {object[]} items - 扫描结果（每条带 rel）。
   * @param {string} baseKey - 当前目录的键，作为树的根。
   * @param {string} baseName - 当前目录的名字（根节点的显示名）。
   * @returns {{key: string, name: string, rel: string, files: object[], children: object[], total: number, depth: number}} 树的根。
   */
  const buildFolderTree = (items, baseKey, baseName) => {
    const baseRel = state.key === '' ? '' : String(state.listing?.rel ?? '')
    const root = { key: baseKey, name: baseName, rel: baseRel, files: [], children: [], total: 0, depth: 0 }
    /** rel（相对**根**的目录路径）→ 节点；根自己的 rel 是 baseRel。 */
    const nodes = new Map([[baseRel, root]])

    /**
     * 建出这条路径上的目录节点，返回最末一级。
     *
     * @param {string} rel - 相对根的目录路径（baseRel 代表根自己）。
     * @returns {object} 该目录的节点。
     */
    const ensure = (rel) => {
      if (rel === baseRel) return root
      const hit = nodes.get(rel)
      if (hit !== undefined) return hit
      const parts = rel.split('/')
      const name = parts[parts.length - 1]
      const parent = ensure(parts.slice(0, -1).join('/'))
      const node = {
        // 键就是父键 + 这一级目录名，和服务端的 keyFor 同构。
        key: `${parent.key}/${encodeURIComponent(name)}`,
        name,
        rel,
        files: [],
        children: [],
        total: 0,
        depth: parent.depth + 1,
      }
      parent.children.push(node)
      nodes.set(rel, node)
      return node
    }

    for (const item of items) {
      const parentRel = String(item.rel ?? '').split('/').slice(0, -1).join('/')
      ensure(parentRel === baseRel || parentRel.startsWith(baseRel === '' ? '' : `${baseRel}/`) ? parentRel : baseRel)
        .files.push(item)
    }

    // 自底向上累计：组头的「N 个」是**整棵子树**的数量，不是这一层的。
    const tally = (node) => {
      node.total = node.files.length
      for (const child of node.children) node.total += tally(child)
      return node.total
    }
    tally(root)
    // 同级按名字排，读起来和左侧目录树一致。
    const sortTree = (node) => {
      node.children.sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }))
      for (const child of node.children) sortTree(child)
    }
    sortTree(root)
    return root
  }

  /**
   * 库视图的分组树：第一层是各配置目录，它们下面才是各自的子树。
   *
   * 不能把整份扫描结果直接丢给 buildFolderTree：那棵树是「当前目录之下」的
   * 形状，键从当前目录拼出来；而库里的条目分属不同的根，键必须保持
   * `r<index>/…`，点「打开 ›」才会跳到对的目录。所以先按条目自带的 root 分回
   * 各自的根，每个根单独建一棵树，再挂到虚拟的「库」根下——键因此天然正确。
   *
   * @returns {object} 库的分组树根。
   */
  const buildLibraryTree = () => {
    const root = { key: LIBRARY_KEY, name: '库', rel: '', files: [], children: [], total: 0, depth: 0 }
    const byRoot = new Map()
    for (const item of state.scanned) {
      const index = Number(item.root)
      const list = byRoot.get(index)
      if (list === undefined) byRoot.set(index, [item])
      else list.push(item)
    }
    // 子树的 depth 从 0 起算，挂到库下之后整体 +1（组头的缩进与图标读它）。
    const deepen = (node) => {
      node.depth += 1
      for (const child of node.children) deepen(child)
    }
    for (const record of state.session?.roots ?? []) {
      const items = byRoot.get(record.index)
      if (items === undefined || items.length === 0) continue
      const child = buildFolderTree(items, `r${record.index}`, record.label)
      deepen(child)
      root.children.push(child)
    }
    root.total = root.children.reduce((sum, child) => sum + child.total, 0)
    return root
  }

  /** 树里所有分组的键（「展开全部」用）。 */
  const allGroupKeys = (node) => [node.key, ...node.children.flatMap((child) => allGroupKeys(child))]

  /**
   * 默认展开哪些分组：根 + 它的直接子目录。
   *
   * 一进来就该看见当前目录和它每个子目录的内容；再深的先折着——一个深目录全
   * 摊开就是几千张图同时进解码管线，那正是这个视图最容易卡死的地方。
   *
   * @param {object} tree - buildFolderTree 的节点。
   * @returns {Set<string>} 默认展开的键。
   */
  const defaultOpenGroups = (tree) => new Set([tree.key, ...tree.children.map((child) => child.key)])

  /**
   * 画一个分组节点（递归）。
   *
   * @param {object} node - buildFolderTree 的节点。
   * @param {Set<string>} open - 当前应该展开的键集合。
   * @returns {HTMLElement|null} 分组元素；这个目录和它的子目录都没有媒体时返回 null。
   */
  const buildGroup = (node, open) => {
    if (node.total === 0) return null
    const isOpen = open.has(node.key)

    const group = document.createElement('section')
    group.className = `folder-group${node.depth > 0 ? ' is-child' : ''}`
    group.dataset.key = node.key

    const head = document.createElement('header')
    head.className = 'group-head'
    head.tabIndex = 0
    head.setAttribute('role', 'button')
    head.setAttribute('aria-expanded', String(isOpen))

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
    twisty.textContent = isOpen ? '▾' : '▸'
    twisty.setAttribute('aria-hidden', 'true')

    const icon = document.createElement('span')
    icon.className = 'ico'
    // 展开时换成「打开的文件夹」，收起时是合着的——和文件管理器一个规矩。
    icon.innerHTML = node.depth === 0 ? '⌂' : (isOpen ? ICON_FOLDER_OPEN : ICON_FOLDER)

    const label = document.createElement('span')
    label.className = 'group-name'
    label.textContent = node.name
    label.title = node.rel === '' ? node.name : node.rel

    const tally = document.createElement('span')
    tally.className = 'group-tally'
    tally.textContent = `${node.total} 个`

    const opener = document.createElement('button')
    opener.type = 'button'
    opener.className = 'group-open'
    opener.textContent = '打开 ›'
    opener.title = `进入 ${node.name}`
    opener.addEventListener('click', (event) => {
      event.stopPropagation()
      navigate(node.key)
    })

    head.append(twisty, icon, label, tally, opener)

    const body = document.createElement('div')
    body.className = 'group-body'
    body.hidden = !isOpen

    /**
     * 折展：只切 DOM 与状态，不重画整个网格（大目录下重画一次很贵）。
     *
     * @param {boolean} next - true 展开。
     */
    const setOpen = (next) => {
      body.hidden = !next
      twisty.textContent = next ? '▾' : '▸'
      // 图标跟着开合换：文件夹开着就是敞开的那枚。
      if (node.depth !== 0) icon.innerHTML = next ? ICON_FOLDER_OPEN : ICON_FOLDER
      head.setAttribute('aria-expanded', String(next))
      groupTouched = true
      if (next) groupOpen.add(node.key)
      else groupOpen.delete(node.key)
    }

    head.addEventListener('click', () => setOpen(body.hidden))
    head.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      setOpen(body.hidden)
    })

    // 这一层自己的文件：按当前排序与筛选。
    const files = computeMedia(node.files)
    if (files.length > 0) {
      const grid = document.createElement('div')
      grid.className = 'group-grid'
      for (const item of files) grid.appendChild(buildCard(item, { compact: true, where: node.rel }))
      body.appendChild(grid)
    }
    // 子目录嵌在后面，缩进由 CSS 出。
    for (const child of node.children) {
      const childNode = buildGroup(child, open)
      if (childNode !== null) body.appendChild(childNode)
    }

    group.append(head, body)
    return group
  }

  /**
   * 分组渲染：把递归结果按目录摊成一棵可折展的树。
   *
   * 「展开 / 折叠全部」那两个动作不在这里，它们挂在工具条「分组」按钮旁边。
   *
   * @param {HTMLElement} host - 画进哪里（通常是游离的 fragment）。
   * @returns {boolean} 是否真的画出了分组。
   */
  const renderGrouped = (host = el.grid) => {
    const listing = state.listing
    if (listing === null) return false
    const crumbs = listing.crumbs ?? []
    const here = crumbs.length > 0 ? crumbs[crumbs.length - 1].name : listing.root.label
    const tree = isLibraryKey(state.key) ? buildLibraryTree() : buildFolderTree(state.scanned, state.key, here)
    if (tree.total === 0) {
      // 整棵子树里一个媒体都没有：分组没有意义，交给平铺去显示空状态。
      renderFlatGrid(host)
      return false
    }

    // 没动过手就用默认视图；动过手就完全听用户的。
    const open = groupTouched ? groupOpen : defaultOpenGroups(tree)

    // 「展开 / 折叠」不在这里画：它们已经挪进工具条上「分组」按钮那一组里了
    // （见 groupActionKeys）。这一屏里只有目录分组本身。

    const rootNode = buildGroup(tree, open)
    if (rootNode === null) {
      renderFlatGrid(host)
      return false
    }
    host.appendChild(rootNode)
    return true
  }

  /**
   * 当前分组视图里所有分组的键；不在分组模式、或树还没出来时返回空数组。
   *
   * 工具条上的「展开 / 折叠」读它——不重画、不重新扫描，纯粹是折展状态的开关。
   *
   * @returns {string[]} 分组键（含根）。
   */
  const groupActionKeys = () => {
    if (state.mode !== 'folder' || state.listing === null) return []
    const crumbs = state.listing.crumbs ?? []
    const here = crumbs.length > 0 ? crumbs[crumbs.length - 1].name : state.listing.root.label
    const tree = isLibraryKey(state.key) ? buildLibraryTree() : buildFolderTree(state.scanned, state.key, here)
    return tree.total === 0 ? [] : allGroupKeys(tree)
  }

  /** 展开所有分组。 */
  const expandAllGroups = () => {
    const keys = groupActionKeys()
    if (keys.length === 0) return
    groupTouched = true
    groupOpen.clear()
    for (const key of keys) groupOpen.add(key)
    renderGrid()
  }

  /** 折叠所有分组，只留根那一层。 */
  const collapseAllGroups = () => {
    const keys = groupActionKeys()
    if (keys.length === 0) return
    groupTouched = true
    groupOpen.clear()
    // keys[0] 就是根：全折起来之后总得还看得见第一层。
    groupOpen.add(keys[0])
    renderGrid()
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
    // 「分组」按目录树画；「当前 / 全部」都是平铺，区别只在数据来源（见 computeMedia）。
    let grouped = state.mode === 'folder'
    // 先取好新内容，再动现有的 DOM：任何中途抛错都还留着上一屏，而不是留一屏空白。
    const next = document.createDocumentFragment()
    if (grouped) grouped = renderGrouped(next)
    else renderFlatGrid(next)
    el.grid.replaceChildren(next)
    // is-grouped 必须反映**实际**渲染方式：分组回退成平铺时（整棵子树没有媒体），
    // 平铺的分块布局和分组的嵌套布局是两套 CSS，类挂错整个网格就散架。
    el.grid.classList.toggle('is-grouped', grouped)
    el.body.dataset.view = state.view
    // 内容模式挂在 data-content 上（当前 / 全部 / 分组），和视图的 data-view 分开：
    // 一个是「怎么排」，一个是「排哪些」，CSS 里各管各的，混在一起会互相覆盖。
    el.body.dataset.content = state.mode
    // 占位高度要在卡片真的画出来之后再对齐一次（渲染时量不到准数）。
    calibrateChunks()
    // 「展开 / 折叠」的显隐跟着模式走，所以每画一次都刷一遍工具条。
    syncToolbar()
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
    // 库的媒体来自一次递归扫描，不是这份分页的顶层列表：续页哨兵在这里只会
    // 白拉请求（拉回来的东西也不会进网格），所以库不需要它。
    if (isLibraryKey(state.key)) return
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
      // 追加优化：平铺 + 默认排序 + 无筛选时，服务端分页序与最终序一致，新页
      // 只按块补到网格尾部。早先这里走 renderAll() 全量重画——那是 O(已加载
      // 条数)，滚得越深每一页越卡。
      const previous = state.media.length
      listing.files = [...(listing.files ?? []), ...(payload.files ?? [])]
      listing.nextOffset = payload.nextOffset
      recomputeMedia()
      renderSummary()
      if (state.mode === 'current' && state.sort === 'new' && state.filter.trim() === '') {
        growChunks(previous)
        renderMore()
      } else {
        renderAll()
      }
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
    // 库永远排在最前：导航到任何目录，都要先让它那一层在树里露出来。
    for (const ancestor of [LIBRARY_KEY, rootKeyOf(key), ...ancestorKeysOf(key)]) {
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
    if (twisty !== null && twisty !== undefined) {
      twisty.textContent = next ? '▾' : '▸'
      // 三角换了，同一行那枚文件夹图标也跟着开合。判断用 dataset.kind 标记，
      // **不能**用 innerHTML 跟常量比：读回来的 `<path/>` 会被序列化成
      // `<path></path>`，字符串永远不相等（这就是上一版没生效的原因）。
      const icon = twisty.parentElement === null ? null : twisty.parentElement.querySelector('.ico')
      if (icon !== null && icon.dataset.kind === 'folder') {
        icon.innerHTML = next ? ICON_FOLDER_OPEN : ICON_FOLDER
      }
    }
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
    const shape = `${rootKeyOf(state.key)}|${state.mode}`
    const sameShape = shape === treeShape
    treeShape = shape
    const canScroll = el.tree.scrollHeight > el.tree.clientHeight + 1
    const scrollTop = sameShape && canScroll ? el.tree.scrollTop : 0
    recordTreeRender({ shape, sameShape, canScroll, scrollTop })
    const roots = state.session?.roots ?? []
    // 「库」是树的第一枚节点：所有配置目录的聚合。一个目录都没配置时它没有
    // 东西可聚合，就不出现——那时该由空状态提示说话。
    const showLibrary = roots.length > 0
    const rootKeys = [
      ...(showLibrary ? [LIBRARY_KEY] : []),
      ...roots.map((item) => `r${item.index}`),
    ].join(',')

    // 根列表没变就**不重建**，只更新状态。
    //
    // 早先这里无条件 clear + 重建：点一下目录（navigate → renderAll → renderTree）
    // 就把几十个已加载的子目录行整个删掉再建一遍，一进一出之间那一瞬间是空的，
    // 看上去就是「子目录全部消失、然后又重新出现」闪一下。重建还顺带把懒加载
    // 建好的分支全丢了，用户白等一次请求。
    //
    // 树里唯一会因导航而变的东西是「哪一行是当前目录」，而那只是一个 class。
    if (treeRootKeys === rootKeys && treeRootNodes.length === (showLibrary ? roots.length + 1 : roots.length)) {
      reuseTree()
      return
    }
    treeRootKeys = rootKeys
    clearTree()
    if (roots.length === 0) {
      const hint = document.createElement('div')
      hint.className = 'tree-empty'
      hint.textContent = '还没有配置目录。请到 dsh 设置 → 插件 → 插件配置 里添加。'
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
    // 库是唯一的顶层节点，各配置目录的根都挂在它下面（库 → 目录 → 子目录）。
    const libraryHost = showLibrary ? armTreeLibrary() : el.tree
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
      // 同上：这个图标也必须带 'ico'，否则吃不到 12px / 居中的那条样式。
      icon.className = 'ico'
      // 配置根也是目录：标上 'folder'，展开时换「打开的文件夹」。
      icon.dataset.kind = 'folder'
      icon.innerHTML = ICON_FOLDER
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = item.label
      name.append(twisty, icon, label)
      name.dataset.label = item.label
      name.dataset.rootIndex = String(item.index)
      name.dataset.key = rootKey
      wrapper.append(name, children)
      libraryHost.appendChild(wrapper)

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

    // 点根名 = 展开并浏览，已展开就保持展开——收起只归三角管。
    //
    // 展开一个目录的意图本来就是「看这个目录里的东西」，所以展开即浏览：
    // 右侧列表切过去，树停在展开状态，两边同步。早先「再点一次已展开的根
    // 就收起」被用户点名去掉：点目录永远不该把树折起来，折展是三角的专属。
    //
    // 双击会先送两次 click，第二下 click（detail > 1）不处理；已展开时单击
    // 只负责浏览（幂等的 toggle 不会重复加载）。
    name.addEventListener('click', (event) => {
      if (event.detail > 1) return
      void toggle(true, true)
      // state.key 为空串是「还没导航过」的初态，服务端会当 r0 处理，这里
      // 别当成「不在根上」而多发一次导航。
      if (children.dataset.open === '1' && state.key !== '' && state.key !== rootKey) navigate(rootKey)
    })
    name.addEventListener('dblclick', () => {
      if (navigatedJustNow(rootKey)) return
      navigate(rootKey)
    })

    if (treeOpen.has(rootKey) && !treeClosed.has(rootKey)) void loadRootChildren()
    void item
  }

  /**
   * 「库」节点：树唯一的顶层，所有配置目录都挂在它下面。
   *
   * 库既是一个整体（右侧递归列出全部目录的内容，搜索同理），也是所有目录的
   * 入口——所以它和别的节点一样带三角：三角只管折展，点名字才是进库。
   *
   * @returns {HTMLElement} 库的子层容器；各配置目录的根挂在这里。
   */
  const armTreeLibrary = () => {
    // 类名刻意不带 tree-root / tree-root-name：那两个类代表「配置的目录根」，
    // 而库不是其中一个。样式与键盘导航各自显式地把它算进来。
    const wrapper = document.createElement('div')
    wrapper.className = 'tree-library'

    const name = document.createElement('div')
    name.className = 'tree-library-name'
    name.title = '所有目录的内容'
    name.tabIndex = 0

    const twisty = document.createElement('span')
    twisty.className = 'twisty'
      const icon = document.createElement('span')
      // 类名必须有：库节点和根节点的图标是「例外」，之前漏了它，于是这两个图标
      // 拿不到那条 12px / 居中的样式，只能吃全局 `svg { width:18px }`——看着就是
      // 「图标偏上、底下空一条」（18px 盒子里只画了 9px 墨迹）。
      // 注意**不要**加 dataset.kind='folder'：库是书堆，展开时不该被换成文件夹。
      icon.className = 'ico'
      icon.innerHTML = ICON_LIBRARY
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = '库'
    name.append(twisty, icon, label)
    name.dataset.label = '库'
    name.dataset.key = LIBRARY_KEY

    const children = document.createElement('div')
    children.className = 'tree-children'

    wrapper.append(name, children)
    el.tree.appendChild(wrapper)

    // 库默认展开（第一次看到时就记成「展开过」），此后由用户的三角决定；
    // 和各配置根同一套规则，收起来之后不会被下一次渲染反悔。
    if (!treeOpen.has(LIBRARY_KEY) && !treeClosed.has(LIBRARY_KEY)) treeOpen.add(LIBRARY_KEY)

    /**
     * 折展库：只切自己这一层，不动右侧列表（和根、子目录的规则一致）。
     *
     * @param {boolean} next - true 展开，false 收起。
     * @param {boolean} [browse] - 是否顺带进库（点名字时为 true）。
     */
    const toggle = (next, browse = false) => {
      applyTreeOpen(LIBRARY_KEY, next)
      paintTreeBranch(LIBRARY_KEY, twisty, children, next)
      // 已经在库里就不重复导航：点库名只是「回到全库」，不是重新加载。
      if (browse && !isLibraryKey(state.key)) navigate(LIBRARY_KEY)
    }
    // 供键盘导航按 key 调用（和根、子目录共用一套折展状态）。
    openers.set(LIBRARY_KEY, toggle)

    twisty.addEventListener('click', (event) => {
      event.stopPropagation()
      // 三角是纯折展，不动右侧列表。
      void toggle(children.dataset.open !== '1')
    })

    // 点名字 = 展开并进库；已展开就只进库——收起只归三角管（和根一致）。
    // 双击会先送两次 click，第二下（detail > 1）交给 dblclick 语义，不再处理。
    name.addEventListener('click', (event) => {
      if (event.detail > 1) return
      void toggle(true, true)
    })

    treeRootNodes.push({ item: { index: -1, path: '', label: '库' }, rootKey: LIBRARY_KEY, children, name, twisty })
    return children
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
    const rows = () => [...el.tree.querySelectorAll('.tree-root-name, .tree-library-name, .tree-folder')]
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
      // 委托：事件源才是那一行，不是容器。库那一行也在这里——它一样可聚焦、
      // 一样有子层，漏掉它就成了「焦点落在库上之后方向键全都没反应」。
      const node = event.target instanceof Element
        ? event.target.closest('.tree-root-name, .tree-library-name, .tree-folder')
        : null
      if (node === null || node === undefined || !el.tree.contains(node)) return
      const list = rows()
      const index = list.indexOf(node)
      if (index === -1) return
      // 两种排布：根（含库）把子层装在自己里面，子目录行则与子层平级。
      const childHost = node.classList.contains('tree-folder')
        ? node.nextElementSibling
        : node.parentElement?.querySelector('.tree-children')
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
      // 子层行以前**没有图标**（row.append 里只有三角/名字/进入按钮），所以「展开
      // 时换成打开的文件夹」在这一层根本没得换。补上，并按开合选图标；之后由
      // paintTreeBranch 在每次折展时保持同步。
      const icon = document.createElement('span')
      icon.className = 'ico'
      // 标记「这枚是文件夹图标」。不能用 innerHTML 跟常量比：读回来时浏览器会把
      // 自闭合的 <path/> 序列化成 <path></path>，字符串永远不相等。
      icon.dataset.kind = 'folder'
      icon.innerHTML = open ? ICON_FOLDER_OPEN : ICON_FOLDER
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
      row.append(twisty, icon, label, enter)

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

      // 点这一行 = 展开并浏览，已展开就保持展开——收起只归三角管。
      //
      // 展开一个目录的意图本来就是「看这个目录里的东西」，所以展开即浏览：
      // 右侧列表切到该目录，树也停在展开状态。早先「再点一次已展开的行就
      // 收起」被用户点名去掉：点目录永远不该把树折起来，折展是三角的专属。
      //
      // 双击 = 进目录 和 单击 仍会打架：浏览器发 dblclick 之前必定先发两次
      // click，于是双击一次目录的实际效果是
      //
      //   点1：展开 + 导航 → 点2：若收起就又展开+导航 → dblclick：第三次导航
      //
      // 所以仍按 event.detail 过滤：detail > 1 交给 dblclick；dblclick 再用
      // 「刚导航过就跳过」去重，避免和第一下 click 重复加载同一个目录。
      row.addEventListener('click', (event) => {
        if (event.detail > 1) return
        void setChildrenOpen(true, true)
        if (childHost.dataset.open === '1' && state.key !== folder.key) navigate(folder.key)
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

  /**
   * 切换目录并同步地址栏，方便收藏和刷新。
   *
   * @param {string} key - 目标目录键。
   */
  const navigate = (key) => {
    state.key = key ?? ''
    // 进「库」时把「当前」升级为「全部」（见 ensureLibraryMode）。
    ensureLibraryMode()
    // 深路径的「…」只活到下一次导航：摊开是为了点中间那一级，换目录后收回。
    crumbsExpanded = false
    lastNavigationAt = performance.now()
    const url = new URL(window.location.href)
    url.searchParams.set('k', state.key)
    if (state.filter.trim() !== '') url.searchParams.set('q', state.filter)
    else url.searchParams.delete('q')
    window.history.replaceState(null, '', url)
    // 面包屑是导航的一部分：跳走时把开着的浮层收掉，别让它挂在原地。
    document.querySelector('.crumb-menu')?.remove()
    void loadListing()
  }

  // ── 图片查看器 ──────────────────────────────────────────────────────────

  const imageState = { index: 0, scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 }

  /**
   * 屏幕上**看得见**的那些媒体条目，按文档顺序。
   *
   * 翻页 / 连播的顺序必须来自这里，而不是 `state.media`：分块渲染只把视口附近
   * 的块挂进 DOM；分组视图里那些懒加载回来的条目也根本不在这份列表里。以屏幕
   * 为准，「下一张」才是用户理解的那一张。
   *
   * @returns {object[]} 条目数组（与卡片一一对应）。
   */
  const shownItems = () => {
    const keys = [...el.grid.querySelectorAll('.card[data-key]')].map((node) => node.dataset.key)
    return keys.map((key) => itemByKey.get(key)).filter((item) => item !== undefined)
  }

  /** 屏幕上看得见的图片条目。 */
  const imageItems = () => shownItems().filter((item) => item.kind === 'image')

  const applyImageTransform = () => {
    el.viewerImage.style.transform = `translate(${imageState.x}px, ${imageState.y}px) scale(${imageState.scale})`
  }

  /**
   * 查看器的「页面全屏」开关，连带刷新按钮状态。
   *
   * 查看器默认是页面上的一块窗口；点了按钮才铺满整页。铺满只是页面内的事，
   * 不动浏览器全屏——那是播放器那边 `F` 的活。
   *
   * @param {boolean} on - 是否铺满整页。
   */
  const setViewerPageFull = (on) => {
    el.viewer.classList.toggle('is-page-full', on)
    el.imageFullscreen.classList.toggle('is-on', on)
    const title = on ? '退出页面全屏（回到窗口）' : '页面全屏（铺满这一页）'
    el.imageFullscreen.title = title
    el.imageFullscreen.setAttribute('aria-label', title)
  }

  /** 关掉查看器：顺手把「页面全屏」收回，下次打开还是窗口形态。 */
  const closeImage = () => {
    el.viewer.hidden = true
    setViewerPageFull(false)
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
    // 每次从关闭状态打开都回到窗口形态；翻到下一张则保持用户当前的形态。
    if (el.viewer.hidden) setViewerPageFull(false)
    el.viewer.hidden = false
    applyImageTransform()
  }

  /**
   * 打开一张图片。
   *
   * 按 key 找，不按下标：卡片上存的就是 key（见 buildCard），下标在懒加载和
   * 分组之后本来就对不上号。
   *
   * @param {string} key - 这条媒体的 key。
   */
  const openImage = (key) => {
    const images = imageItems()
    const at = images.findIndex((candidate) => candidate.key === key)
    showImage(at === -1 ? 0 : at)
  }

  const zoomImage = (factor) => {
    imageState.scale = Math.min(Math.max(imageState.scale * factor, 0.2), 12)
    applyImageTransform()
  }

  // ── 播放器与连播列表 ────────────────────────────────────────────────────

  /**
   * 连播列表：当前列表里**能播的**条目（视频 + 音频），按当前排序。
   *
   * 图片不进这里：播放器是 `<video>` + 时间轴的界面，图片进去只会得到一句
   * 「解码失败」。上下滑换条之后这条路更容易撞上，所以干脆不排进来——要看图
   * 走图片查看器（点图片卡片）。
   */
  const playlist = () => state.media.filter((item) => item.kind === 'video' || item.kind === 'audio')

  const player = createPlayer({
    items: [],
    // 换条时那枚 🖼 的文案要跟着当前这条走（是不是它当着壁纸）。
    onIndexChange: () => syncWallpaperButtons(),
  })

  /**
   * 播放一条媒体，并把它接进连播列表。
   *
   * 列表用**整份当前列表**（`playlist()`），不是屏幕上挂着的那几张卡：网格是分块
   * 窗口化的，DOM 里只有视口附近的几百张，拿它当播放列表的话「下一条」滑到一半
   * 就没了；分组视图里懒加载回来的条目更是根本不在那份里。次序（顺序 / 随机）
   * 由播放器自己管，见 player.js 的 seat。
   *
   * 按 key 找——这就是「点哪个视频都播第一个」那个 bug 的根：早先卡片带的是
   * `state.media` 里的下标，分组视图里懒加载出来的卡片不在那个数组里，下标算
   * 不出来就兜底成 0，于是永远播第一条。现在卡片带 key，这里按 key 定位。
   *
   * @param {string} key - 这条媒体的 key。
   */
  const openPlayer = (key) => {
    const queue = playlist()
    const target = queue.findIndex((candidate) => candidate.key === key)
    if (target === -1) return
    player.open(queue, target)
  }

  /**
   * 一键看视频：把当前列表打乱，用播放器**铺满这一页**从随机一条开始放。
   *
   * 顺序用的是播放器自己的「随机」（⇄ 那枚会跟着点亮、也记住），不是在外面把
   * 数组洗一遍——这样「下一集 / 播完自动下一条 / 上下滑」全都走在同一份次序上，
   * 用户看的和按钮亮的是同一件事。列表里没有可播的（例如只看图片）就直说。
   */
  const watchRandom = () => {
    const queue = playlist()
    if (queue.length === 0) {
      toast('这个列表里没有能播的视频', 'error')
      return
    }
    // 从随机一条开始（播放器会按随机次序把它排在第一位）。
    const at = Math.floor(Math.random() * queue.length)
    player.open(queue, at, { order: 'random', fullPage: true })
    toast(queue.length > 1 ? `随机看视频：${queue[at].name}` : queue[at].name)
  }

  // ── 全屏壁纸 ────────────────────────────────────────────────────────────
  //
  // 把库里的图片或视频铺满整个窗口当背景（图片查看器 / 播放器上那枚 🖼）。
  //
  // 存的是**一份自给自足的记录**（键、种类、名字、能直接用的 URL、封面色），
  // 不是只存 key：刷新之后列表要等接口才回来，而壁纸得立刻画出来；视频还得用
  // 对 URL——老格式（AVI 之类）要走服务端转码流，见 playbackSrc。
  //
  // 设了壁纸时 body 带 data-wallpaper="1"，CSS 把界面各层的底色换半透明 + 模糊，
  // 壁纸从底下透出来；壁纸层自己 pointer-events: none，一个点击都不吃。

  const WALLPAPER_LS = 'mv.wallpaper'

  /**
   * 本机选择 vs 设置里的默认。
   *
   * 三态：localStorage 里没写 = 用设置里配的那张；写了 `'off'` = 本机明确不要
   * （连设置里那张也压掉）；写了一条记录 = 本机自己挑的那条。
   *
   * @returns {object|null|undefined} 记录 / null（明确不要） / undefined（没表态）。
   */
  const readLocalWallpaper = () => {
    const raw = localStorage.getItem(WALLPAPER_LS)
    if (raw === null) return undefined
    if (raw === 'off') return null
    try {
      const saved = JSON.parse(raw)
      if (typeof saved.poster !== 'string' && typeof saved.thumbUrl === 'string') saved.poster = saved.thumbUrl
      return saved
    } catch {
      return undefined
    }
  }

  /** 一条记录归一化成壁纸层要的形状；字段不全就当没见过（宁可不显示，也不要半张）。 */
  const normalizeWallpaper = (saved) => {
    if (saved === null || saved === undefined || typeof saved !== 'object') return null
    if (typeof saved.key !== 'string' || typeof saved.url !== 'string' || saved.key === '') return null
    return {
      key: saved.key,
      kind: saved.kind === 'video' ? 'video' : 'image',
      name: typeof saved.name === 'string' ? saved.name : '',
      url: saved.url,
      poster: typeof saved.poster === 'string' ? saved.poster : '',
      configured: false,
    }
  }

  /**
   * 设置里配的那条壁纸：会话给的是**媒体条目**（和卡片同款），所以这里用和 🖼
   * 按钮完全一样的方式算出可直接用的 URL（视频该转码就转码）。
   *
   * @param {object|null|undefined} item - `/api/session` 的 `wallpaper` 字段。
   * @returns {object|null} 壁纸记录。
   */
  const configuredWallpaper = (item) => {
    if (item === null || item === undefined || typeof item !== 'object') return null
    if (typeof item.key !== 'string' || item.key === '') return null
    const video = item.kind === 'video'
    const record = normalizeWallpaper({
      key: item.key,
      kind: item.kind,
      name: item.name,
      url: video ? playbackSrc(item) : (item.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item.key)}`),
      poster: item.thumbUrl,
    })
    return record === null ? null : { ...record, configured: true }
  }

  /**
   * 当前生效的壁纸：本机挑的优先；本机说「不要」就一张都不显示；否则用设置里的。
   *
   * @returns {object|null} 壁纸记录。
   */
  const currentWallpaper = () => {
    const local = readLocalWallpaper()
    if (local !== undefined) return normalizeWallpaper(local)
    return configuredWallpaper(state.session?.wallpaper)
  }

  let wallpaper = currentWallpaper()
  /** 壁纸层里那个 `<video>`（图片壁纸时为 null）；切标签页时用它暂停。 */
  let wallpaperVideo = null

  /** 按记录重画壁纸层。 */
  const paintWallpaper = () => {
    clear(el.wallpaper)
    wallpaperVideo = null
    if (wallpaper === null) return
    if (wallpaper.kind === 'video') {
      const video = document.createElement('video')
      video.muted = true
      video.loop = true
      video.playsInline = true
      video.autoplay = true
      video.preload = 'auto'
      if (wallpaper.poster !== '') video.poster = wallpaper.poster
      video.src = wallpaper.url
      // 系统设了「减少动态效果」就不自动播：留住海报帧当静态壁纸。
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.wallpaper.appendChild(video)
        wallpaperVideo = video
        return
      }
      // 首次进入时浏览器可能还拦着自动播放（没有交互），等下一帧再试一次。
      video.play().catch(() => {
        window.setTimeout(() => video.play().catch(() => {}), 400)
      })
      el.wallpaper.appendChild(video)
      wallpaperVideo = video
      return
    }
    const image = document.createElement('img')
    image.alt = ''
    image.decoding = 'async'
    image.src = wallpaper.url
    el.wallpaper.appendChild(image)
  }

  /** 那两枚 🖼 的文案与点亮状态跟着「当前这条是不是壁纸」走。 */
  const syncWallpaperButtons = () => {
    const current = player.currentItem?.() ?? null
    const on = wallpaper !== null && current !== null && current.key === wallpaper.key
    for (const node of [el.imageWallpaper, el.btnWallpaper]) {
      if (node === null || node === undefined) continue
      node.classList.toggle('is-on', on)
      const label = on ? '取消全屏壁纸' : '设为全屏壁纸'
      node.title = label
      node.setAttribute('aria-label', label)
    }
  }

  /** 把壁纸状态落到 DOM 上（显隐、body 标记、层内容、按钮状态）。 */
  const applyWallpaper = () => {
    el.wallpaper.hidden = wallpaper === null
    if (wallpaper === null) el.body.removeAttribute('data-wallpaper')
    else el.body.dataset.wallpaper = '1'
    paintWallpaper()
    syncWallpaperButtons()
  }

  /**
   * 把一条媒体设为壁纸；它已经是壁纸时再点一次就取消。
   *
   * 取消写的是 `'off'` 而不是删键：设置里可能配着一张默认壁纸，删键就等于
   * 「回到默认」，那张又冒出来了。`'off'` 才是「本机不要」。
   *
   * @param {object} item - 媒体条目（图片或视频）。
   */
  const toggleWallpaper = (item) => {
    if (item === undefined || item === null || typeof item.key !== 'string') {
      toast('这一条不能当壁纸', 'error')
      return
    }
    if (wallpaper !== null && wallpaper.key === item.key) {
      wallpaper = null
      localStorage.setItem(WALLPAPER_LS, 'off')
      applyWallpaper()
      toast('壁纸已取消')
      return
    }
    const video = item.kind === 'video'
    const record = {
      key: item.key,
      kind: video ? 'video' : 'image',
      name: item.name ?? '',
      // 视频走 playbackSrc：老格式要换成服务端的转码流，浏览器才播得动。
      url: video ? playbackSrc(item) : (item.streamUrl ?? `${BASE}/stream?k=${encodeURIComponent(item.key)}`),
      poster: item.thumbUrl ?? '',
    }
    localStorage.setItem(WALLPAPER_LS, JSON.stringify(record))
    wallpaper = normalizeWallpaper(record)
    applyWallpaper()
    toast(`${video ? '视频' : '图片'}壁纸：${wallpaper?.name ?? ''}`)
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
    // 设置里可能配了默认壁纸：会话回来之后重算一次（本机自己挑的那条仍然优先）。
    wallpaper = currentWallpaper()
    applyWallpaper()
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
      el.empty.querySelector('.empty-hint').textContent = '到 dsh 设置 → 插件 → 插件配置（Reel 媒体浏览）里添加一个装着图片或视频的目录。'
    }
    return true
  }

  // ── 启动 ────────────────────────────────────────────────────────────────

  /** 让工具条上的按钮反映当前状态。 */
  const syncToolbar = () => {
    for (const node of document.querySelectorAll('[data-kind-btn]')) {
      node.classList.toggle('is-active', node.dataset.kindBtn === state.kinds)
    }
    for (const node of document.querySelectorAll('[data-content-btn]')) {
      node.classList.toggle('is-active', node.dataset.contentBtn === state.mode)
      node.setAttribute('aria-pressed', String(node.dataset.contentBtn === state.mode))
    }
    for (const node of document.querySelectorAll('[data-view-btn]')) {
      node.classList.toggle('is-active', node.dataset.viewBtn === state.view)
    }
    // 「展开 / 折叠」只属于分组模式：不在分组里就整对藏起来，不给无效动作占位。
    const folderMode = state.mode === 'folder'
    const hasGroups = folderMode && groupActionKeys().length > 0
    el.groupExpand.hidden = !hasGroups
    el.groupCollapse.hidden = !hasGroups
  }

  /** 上一级：路径行的「‹」和 Backspace 共用这一条。 */
  const goUp = () => {
    const parent = state.listing?.parent
    if (parent === null || parent === undefined) return
    navigate(parent)
  }

  /** 切换视图：网格 ↔ 列表（键盘 V 走同一条路）。 */
  const setView = (view) => {
    state.view = view === 'list' ? 'list' : 'grid'
    localStorage.setItem('mv.view', state.view)
    syncToolbar()
    renderGrid()
  }

  /**
   * 切换内容模式：当前这一层 / 递归全部 / 递归分组。
   *
   * 后两个都要递归结果，所以先按需扫一次（按目录键缓存，来回切不会重复扫盘），
   * 再重算列表。分组每次进来都回到默认展开形态——这是「我现在想看全貌」的动作。
   *
   * @param {'current'|'all'|'folder'} mode - 目标模式。
   * @param {{force?: boolean}} [options] - force: 已经是这个模式也重画一遍
   *   （用户再点一次「分组」就是想回到默认形态）。
   */
  const setContentMode = async (mode, options = {}) => {
    const wanted = mode === 'all' || mode === 'folder' ? mode : 'current'
    if (state.mode === wanted && options.force !== true) return
    state.mode = wanted
    localStorage.setItem('mv.mode', state.mode)
    if (wanted !== 'current') await loadRecursive(state.key)
    // 「全部」是逐条看内容，「分组」是逐目录看结构，两个都想从干净的展开状态开始。
    groupTouched = false
    groupOpen.clear()
    syncToolbar()
    recomputeMedia()
    renderSummary()
    renderGrid()
  }

  /** 内容模式轮转：当前 → 全部 → 分组 → 当前（键盘 G 走这一条）。 */
  const cycleContentMode = () => {
    const order = ['current', 'all', 'folder']
    const next = order[(order.indexOf(state.mode) + 1) % order.length]
    void setContentMode(next)
    toast(`内容：${next === 'current' ? '当前这一层' : next === 'all' ? '所有子目录（平铺）' : '所有子目录（分组）'}`)
  }

  /** 当前列出内容的种类标签（空状态和统计行共用）。 */
  const kindLabel = () => (state.kinds === 'video' ? '视频' : state.kinds === 'image' ? '图片' : '媒体文件')

  const setKinds = (kinds) => {
    state.kinds = kinds === 'video' || kinds === 'image' ? kinds : 'all'
    localStorage.setItem('mv.kinds', state.kinds)
    syncToolbar()
    recomputeMedia()
    renderSummary()
    renderGrid()
  }

  /**
   * 把网格大小落到 CSS 变量上（工具条上那三枚按钮的选中态也一起刷）。
   *
   * 只写 `--tile`（三条表达式之一），像素由 CSS 按设备基准乘出来；选中态在
   * 这里一起刷，不再多画一次工具条。
   */
  const applyTile = () => {
    document.documentElement.style.setProperty('--tile', TILE_VALUES[state.tile] ?? 'var(--tile-base)')
    localStorage.setItem('mv.tileSize', String(state.tile))
    for (const node of document.querySelectorAll('[data-tile-btn]')) {
      const active = Number(node.dataset.tileBtn) === state.tile
      node.classList.toggle('is-active', active)
      node.setAttribute('aria-pressed', String(active))
    }
  }

  /**
   * 换一档瓦片大小。
   *
   * 一定要重画网格：分块窗口化是按**列数**切的（见 gridColumns / chunkSizeFor），
   * 列数变了块的边界就不再整除列数，末尾会空出半行——只改 CSS 变量的话，网格
   * 宽度没变，ResizeObserver 不会来救场。
   *
   * @param {number|string} index - 档位（0 小 / 1 中 / 2 大）。
   */
  const setTile = (index) => {
    const next = Math.min(Math.max(Number(index) || 0, 0), TILE_VALUES.length - 1)
    if (next === state.tile) return
    state.tile = next
    applyTile()
    renderGrid()
    toast(`网格大小：${TILE_LABELS[next]}`)
  }

  const bindUi = () => {
    syncToolbar()
    applyTile()
    applyWallpaper()
    // 两枚 🖼：图片查看器里那枚用查看器当前这张，播放器里那枚用当前这条。
    el.imageWallpaper.addEventListener('click', () => toggleWallpaper(imageItems()[imageState.index]))
    el.btnWallpaper.addEventListener('click', () => toggleWallpaper(player.currentItem()))
    for (const node of document.querySelectorAll('[data-tile-btn]')) {
      node.addEventListener('click', () => setTile(node.dataset.tileBtn))
    }
    for (const node of document.querySelectorAll('[data-kind-btn]')) {
      node.addEventListener('click', () => setKinds(node.dataset.kindBtn))
    }
    for (const node of document.querySelectorAll('[data-content-btn]')) {
      node.addEventListener('click', () => void setContentMode(node.dataset.contentBtn, { force: true }))
    }
    el.groupExpand.addEventListener('click', expandAllGroups)
    el.groupCollapse.addEventListener('click', collapseAllGroups)
    for (const node of document.querySelectorAll('[data-view-btn]')) {
      node.addEventListener('click', () => setView(node.dataset.viewBtn))
    }
    el.crumbUp.addEventListener('click', goUp)
    el.sortToggle.addEventListener('click', () => {
      const order = ['new', 'old', 'name', 'size', 'kind']
      state.sort = order[(order.indexOf(state.sort) + 1) % order.length]
      localStorage.setItem('mv.sort', state.sort)
      recomputeMedia()
      renderSummary()
      renderGrid()
      toast(`排序：${sortLabel[state.sort]}`)
    })
    el.refresh.addEventListener('click', () => void loadListing())
    el.watchRandom.addEventListener('click', watchRandom)
    bindSidebarResize()
    // 「▶ 全部连播」：从这一层（或整个库）的第一条起进播放器。播放器就是手机
    // 上的「刷」界面——打开直接铺满，上下滑换条，顺序 / 随机在它的控件条上。
    el.playAll.addEventListener('click', () => {
      const first = playlist()[0]
      if (first === undefined) {
        toast('这里没有可播放的内容')
        return
      }
      openPlayer(first.key)
    })
    el.search.addEventListener('input', () => {
      state.filter = el.search.value
      const url = new URL(window.location.href)
      if (state.filter.trim() !== '') url.searchParams.set('q', state.filter)
      else url.searchParams.delete('q')
      window.history.replaceState(null, '', url)
      recomputeMedia()
      renderSummary()
      renderGrid()
    })

    // 图片查看器
    el.imageClose.addEventListener('click', closeImage)
    el.imageFullscreen.addEventListener('click', () => {
      setViewerPageFull(!el.viewer.classList.contains('is-page-full'))
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
          if (!el.viewer.hidden) closeImage()
          break
        case 'v':
        case 'V':
          setView(state.view === 'list' ? 'grid' : 'list')
          break
        case 's':
        case 'S':
          el.sortToggle.click()
          break
        case 'g':
        case 'G':
          // 内容模式轮转：当前 → 全部 → 分组。
          cycleContentMode()
          break
        case 'Backspace':
          event.preventDefault()
          goUp()
          break
        case 'ArrowUp':
          // 文件管理器的老习惯：Cmd/Ctrl + ↑ 上一级。
          if (!event.metaKey && !event.ctrlKey) break
          event.preventDefault()
          goUp()
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
          el.playAll.click()
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

    window.addEventListener('popstate', () => {
      const url = new URL(window.location.href)
      state.key = url.searchParams.get('k') ?? ''
      // 后退/前进也可能落到 ?k=lib 上，和点击、刷新走同一条规则。
      ensureLibraryMode()
      state.filter = url.searchParams.get('q') ?? ''
      el.search.value = state.filter
      void loadListing()
    })

    // 切到后台就把视频壁纸停下：壁纸是背景，不该在看不见的时候一直解码耗电。
    document.addEventListener('visibilitychange', () => {
      if (wallpaperVideo === null) return
      if (document.hidden) wallpaperVideo.pause()
      else void wallpaperVideo.play().catch(() => {})
    })

    watchSettings()
  }

  /**
   * 设置改了之后**热生效**，不用手动刷新页面。
   *
   * 服务端每次外部配置变化（目录、缓存目录、壁纸）都会把 revision +1，页面这边
   * 只在看得见的时候隔几秒问一次版本号；变了才重新读会话、重建目录树、重拉当前
   * 列表。只问版本号不拉整份会话内容——那会顺带跑一次壁纸解析（要 stat + 读目录），
   * 没必要每几秒付一遍。
   *
   * 之前这里什么都没有：设置里换了壁纸，已经开着的页面要手动刷新才认，用户看到
   * 的就是「设置没同步」。
   */
  const watchSettings = () => {
    let seen = state.session?.revision ?? 0
    let busy = false
    window.setInterval(async () => {
      if (document.hidden || busy) return
      busy = true
      try {
        const result = await api('/api/session')
        if (!result.ok) return
        const next = result.payload.revision
        if (next === seen) return
        seen = next
        const ok = await reloadSession()
        if (!ok) return
        // 目录列表可能也变了：把树丢掉重建，再重拉当前这一层。
        treeRootKeys = null
        renderTree()
        await loadListing()
        toast('设置已生效')
      } catch {
        /* 轮询失败就当这一拍没发生，下一拍再来 */
      } finally {
        busy = false
      }
    }, 5000)
  }

  /**
   * 启动前把所有 id 映射查一遍。
   *
   * 少写一个 id 的后果是「某块界面悄无声息地不工作」——例如漏掉 player
   * 会让点开视频什么都不发生，而且只在运行时抛一句不指向根因的
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

    const url = new URL(window.location.href)
    state.key = url.searchParams.get('k') ?? ''
    // 直接打开 ?k=lib（收藏、刷新）和点树里的「库」走同一条规则。
    ensureLibraryMode()
    state.filter = url.searchParams.get('q') ?? ''
    el.search.value = state.filter

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
    await loadListing()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot())
  else void boot()
})()
