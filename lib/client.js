/**
 * dsh-reel — the client half: the configuration card on this bundle's own page
 * in the Plugins panel.
 *
 * Where it appears: the Plugins panel lists installed bundles; opening this one
 * shows its description, then its configuration, then its component rows. The
 * card is contributed to `plugins.bundle.config` keyed by the package name, so
 * it renders in that middle section. The mount is wrapped in
 * `whileServed(['reel'])`, so a deployment that does not serve the namespace
 * shows no card at all.
 *
 * Why not the Official group: `plugins.item` carries the official settings pages
 * — one companion package per host-plane namespace — and dsh's own slot
 * contract directs a bundle's configuration elsewhere. dsh-reel ships a patch
 * bundle, so its configuration belongs on the bundle page.
 *
 * The form is drawn with dsh's own primitives and staged by its own form model,
 * so the card behaves and looks like the shipped ones: drafts are local, and
 * Save is the single point where they become a revision-fenced document write.
 * The host half declines the auto-generated page
 * (`settings.configure({ auto: false })`) because this card adds two things a
 * generated form cannot express: a one-click open of /reel and a project link.
 *
 * Format: the lazy-CJS bundle the client module system expects — executing the
 * script only REGISTERS the factory; the body runs at materialization. It is
 * hand-written instead of built (no tsdown, no JSX) so the package keeps its
 * no-build property; the wrapper mirrors what tsdown emits for the shipped
 * client packages.
 */

window.__ModuleLoader__.load({
  id: 'dsh-reel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Settings namespace the host plugin's `Config` declares. */
    const NAMESPACE = 'reel'
    /**
     * This bundle's package name — the `plugins.bundle.config` cell key. The
     * Plugins page dispatches by package name, so the card renders on this
     * bundle's own page only when the key matches its name exactly.
     */
    const BUNDLE = 'dsh-reel'
    /** Locale dictionary namespace for this card's copy. */
    const NS = 'settings.plugins.reel'
    /** Where the viewer lives — always same-origin with the settings page. */
    const REEL_PATH = '/reel'
    /** The project page, linked at the bottom of the card. */
    const GITHUB_URL = 'https://github.com/lsjspl/dsh-reel'

    const zh = {
      title: 'Reel 媒体浏览',
      description: '浏览页的媒体目录与缩略图缓存',
      roots: '媒体目录',
      rootsHint: '浏览页展示的根目录，一行一个；改动热生效，不需要重启。',
      addRoot: '添加目录',
      remove: '移除',
      rootsPlaceholder: '例如 D:\\Photos',
      cacheDir: '缓存目录',
      cacheDirHint: '视频封面与悬停动画的缓存位置；留空使用系统临时目录。不要放在媒体目录里，否则缓存文件会出现在浏览页。',
      cacheDirPlaceholder: '例如 D:\\dsh-cache',
      wallpaper: '全屏壁纸',
      wallpaperHint: '浏览页的整页背景：填媒体目录里的媒体 key（如 r0/照片/a.jpg）或它的绝对路径；图片、视频都行，视频静音循环。留空 = 不设。这里配的是所有设备的默认值，浏览页上还能用「设为壁纸」那枚按钮临时换成本机自己挑的那条。',
      wallpaperPlaceholder: '例如 D:\\Photos\\wall.jpg 或 r0/照片/wall.jpg',
      wallpaperLocal: '浏览页上现在用的是这张：',
      useThis: '用这张',
      openReel: '打开 Reel',
      github: 'GitHub 项目主页',
      overridden: '已覆盖',
      reset: '重置',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '当前部署的设置为只读，无法修改。',
      save: '保存',
      saving: '保存中…',
      saveFailed: '当前部署没有接受这些值，已保留供你修改。',
    }

    const en = {
      title: 'Reel media browser',
      description: 'Media directories and thumbnail cache for the viewer',
      roots: 'Media directories',
      rootsHint: 'Root directories offered by the viewer, one per line. Changes apply live, with no restart.',
      addRoot: 'Add directory',
      remove: 'Remove',
      rootsPlaceholder: 'e.g. D:\\Photos',
      cacheDir: 'Cache directory',
      cacheDirHint: 'Where poster frames and hover previews are cached; empty means the OS temp directory. Keep it outside the media roots, or cache files will show up in the gallery.',
      cacheDirPlaceholder: 'e.g. D:\\dsh-cache',
      wallpaper: 'Fullscreen wallpaper',
      wallpaperHint: 'Background for the whole viewer: a media key (e.g. r0/photos/a.jpg) or an absolute path inside a media root. Images and videos both work; videos loop muted. Empty means none. This is the default for every device — the “set as wallpaper” button in the viewer overrides it locally.',
      wallpaperPlaceholder: 'e.g. D:\\Photos\\wall.jpg or r0/photos/wall.jpg',
      wallpaperLocal: 'The viewer on this machine is using:',
      useThis: 'Use this',
      openReel: 'Open Reel',
      github: 'GitHub project',
      overridden: 'Overridden',
      reset: 'Reset',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      save: 'Save',
      saving: 'Saving…',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
    }

    /**
     * The form frame's copy, read from this page's dictionary.
     *
     * @param t - this card's locale reader.
     * @returns the labels the shared settings form renders.
     */
    function formLabels(t) {
      return {
        unavailable: t('unavailable'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        save: t('save'),
        saving: t('saving'),
      }
    }

    /**
     * The `roots` field's text conversion: one directory per line.
     *
     * `roots` is the one field an array, while the model stages per-field text.
     * Newlines are the natural spelling — a multi-line draft reads like the list
     * it is — and every blank line is dropped on the way back, so an empty
     * draft writes the empty list rather than a list holding an empty string.
     *
     * @returns {object} the field's conversion spec.
     */
    function rootsField() {
      return {
        field: 'roots',
        format: (value) => (Array.isArray(value) ? value.join('\n') : ''),
        parse: (text) => ({
          kind: 'set',
          value: text.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
        }),
      }
    }

    // Card styles for the parts the shared primitives do not draw: the
    // one-click row and the directory list. Same alias variables as the host
    // cards, so the card reads native in both themes. One injected style tag,
    // guarded so a re-materialization cannot stack copies.
    const css = [
      '.reel_meta{display:flex;align-items:center;gap:14px;padding:0 0 4px}',
      '.reel_open{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.reel_github{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;text-decoration:none}',
      '.reel_github:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.reel_field{display:flex;flex-direction:column;gap:6px}',
      '.reel_fieldHead{display:flex;align-items:center;gap:8px}',
      '.reel_label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}',
      '.reel_badge{color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;padding:1px 8px;font-size:11px;line-height:1.6;flex:none}',
      '.reel_reset{appearance:none;font:inherit;cursor:pointer;background:0 0;border:none;padding:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.reel_reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.reel_rootList{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}',
      '.reel_rootRow{display:flex;align-items:center;gap:8px}',
      '.reel_input{flex:1;min-width:0;box-sizing:border-box;height:34px;padding:0 12px;font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}',
      '.reel_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.reel_input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.reel_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.reel_remove{appearance:none;font:inherit;cursor:pointer;flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:5px 10px;font-size:12px;line-height:1.5}',
      '.reel_remove:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_add{appearance:none;font:inherit;cursor:pointer;align-self:flex-start;border:1px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5}',
      '.reel_add:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_localWall{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.reel_localWall code{overflow-wrap:anywhere}',
      '.reel_hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-reel/client.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-reel'
      tag.dataset.pluginCss = 'dsh-reel/client.css'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Read the wallpaper the viewer on THIS machine is using.
     *
     * That choice is a per-machine pick the viewer stores in localStorage; it
     * never rides the settings document, so the card cannot learn it from its
     * form. Offering it here is the one place the two meet: one click stages it
     * as a draft, and saving makes it the default for every device.
     *
     * @returns {string} the stored media key, or the empty string.
     */
    function localWallpaper() {
      try {
        const raw = localStorage.getItem('mv.wallpaper')
        if (raw === null || raw === 'off') return ''
        const saved = JSON.parse(raw)
        return saved !== null && typeof saved === 'object' && typeof saved.key === 'string' ? saved.key : ''
      } catch {
        return ''
      }
    }

    /**
     * Render the reel card.
     *
     * @param props - the view asked for, this page's locale reader `t`, the
     *   staged form snapshot, and its edit/save/discard actions.
     * @returns the one-liner, or the settings form.
     */
    function ReelCard(props) {
      const { t } = props
      const state = props.useReelCard((snapshot) => snapshot)
      if (props.view === 'summary') return t('description')

      const disabled = !state.writable
      const rows = state.roots.text === '' ? [''] : state.roots.text.split('\n')
      const stage = (lines) => props.edit('roots', lines.join('\n'))
      const local = state.wallpaper.text === '' ? localWallpaper() : ''

      return h(primitives.SettingsForm, {
        labels: formLabels(t),
        state,
        onSave: props.save,
        onDiscard: props.discard,
      },
        h('div', { className: 'reel_meta' },
          h('button', {
            type: 'button',
            className: 'reel_open',
            onClick: () => window.open(REEL_PATH, '_blank', 'noopener'),
          }, t('openReel')),
          h('a', { className: 'reel_github', href: GITHUB_URL, target: '_blank', rel: 'noreferrer' }, t('github')),
        ),
        h('div', { className: 'reel_field' },
          h('div', { className: 'reel_fieldHead' },
            h('span', { className: 'reel_label' }, t('roots')),
            state.roots.overridden ? h('span', { className: 'reel_badge' }, t('overridden')) : null,
            state.roots.overridden ? h('button', {
              type: 'button', className: 'reel_reset', disabled, onClick: () => props.resetField('roots'),
            }, t('reset')) : null,
          ),
          h('ul', { className: 'reel_rootList' },
            rows.map((row, index) => h('li', { className: 'reel_rootRow', key: index },
              h('input', {
                className: 'reel_input',
                type: 'text',
                value: row,
                placeholder: t('rootsPlaceholder'),
                disabled,
                spellCheck: false,
                onChange: (event) => {
                  const next = rows.slice()
                  next[index] = event.target.value
                  stage(next)
                },
              }),
              h('button', {
                type: 'button', className: 'reel_remove', disabled, 'aria-label': t('remove'),
                onClick: () => {
                  const next = rows.slice()
                  next.splice(index, 1)
                  stage(next)
                },
              }, '✕'),
            )),
          ),
          h('button', {
            type: 'button', className: 'reel_add', disabled,
            onClick: () => stage(rows.concat('')),
          }, `＋ ${t('addRoot')}`),
          h('p', { className: 'reel_hint' }, t('rootsHint')),
        ),
        h(primitives.SettingsValueField, {
          id: 'plugin-config-reel-cache-dir',
          label: t('cacheDir'),
          hint: t('cacheDirHint'),
          placeholder: t('cacheDirPlaceholder'),
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          invalidLabel: t('saveFailed'),
          disabled,
          ...state.cacheDir,
          onEdit: (text) => props.edit('cacheDir', text),
          onReset: () => props.resetField('cacheDir'),
        }),
        h('div', { className: 'reel_field' },
          h(primitives.SettingsValueField, {
            id: 'plugin-config-reel-wallpaper',
            label: t('wallpaper'),
            hint: t('wallpaperHint'),
            placeholder: t('wallpaperPlaceholder'),
            overriddenLabel: t('overridden'),
            resetLabel: t('reset'),
            invalidLabel: t('saveFailed'),
            disabled,
            ...state.wallpaper,
            onEdit: (text) => props.edit('wallpaper', text),
            onReset: () => props.resetField('wallpaper'),
          }),
          local === '' ? null : h('p', { className: 'reel_localWall' },
            h('span', null, `${t('wallpaperLocal')} `, h('code', null, local)),
            h('button', {
              type: 'button', className: 'reel_reset', disabled,
              onClick: () => props.edit('wallpaper', local),
            }, t('useThis')),
          ),
        ),
      )
    }

    /**
     * Bridge the `reel` namespace's shared form onto this card's props.
     *
     * The model owns the staged drafts; the projection below is what the card
     * reads, rebuilt whenever either the host's document or a draft changes. It
     * is built once, in the constructor, because `bind` subscribes — rebuilding
     * it per render would leak a subscription each time.
     */
    class ReelCardController {
      /**
       * @param scope - the shared configuration form for the `reel` namespace.
       */
      constructor(scope) {
        this.form = new primitives.SettingsFormModel(scope, [
          rootsField(),
          primitives.settingsTextField('cacheDir'),
          primitives.settingsTextField('wallpaper'),
        ])
        this.store = this.form.bind(() => this.projection())
      }

      /** @returns the card's snapshot: the shared shell plus one state per control. */
      projection() {
        return {
          ...this.form.shell(),
          roots: this.form.field('roots'),
          cacheDir: this.form.field('cacheDir'),
          wallpaper: this.form.field('wallpaper'),
        }
      }

      /**
       * Build the face the card's slot registration injects.
       *
       * `hooks.reelCard` reaches the component as the `useReelCard` prop; the
       * four actions come straight from the form.
       *
       * @returns the snapshot source and the form's actions.
       */
      inject() {
        return {
          hooks: { reelCard: this.store },
          ...this.form.actions(),
        }
      }

      /** Release the form's accepted-value subscription. */
      dispose() {
        this.form.dispose()
      }
    }

    /** Required services (cordis fiber inject on the browser side). */
    const inject = ['slots', 'locale', 'configForms']

    /**
     * Mount the card: register the copy dictionaries, bind the `reel` form, and
     * contribute the card to this bundle's page while the host serves the
     * namespace.
     *
     * **Which slot, and why.** `plugins.item` is the Official group's list, and
     * dsh's own slot contract marks it as occupied by the *official settings
     * pages* — "one companion package per host-plane namespace" — explicitly
     * directing a bundle's configuration to `plugins.bundle.config` or
     * `plugins.row.config`. dsh-reel is a bundle (it ships a patch), so its
     * configuration belongs on its own bundle page, which is where
     * `plugins.bundle.config` renders it — between the package description and
     * the component rows, exactly as the Plugins page documents.
     *
     * The key is the bundle's package name, because that is what the page
     * dispatches: `ledger.bundles` is built from these entries' `key`s, and the
     * section only appears when it holds this package's name.
     *
     * `whileServed` keeps a deployment that does not serve the `reel` namespace
     * free of any trace: the registration appears with the namespace and
     * disappears with it.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reel: settings card dictionaries')
      const card = new ReelCardController(ctx.configForms.get(NAMESPACE))
      ctx.effect(() => () => card.dispose(), 'reel: settings card form subscription')
      ctx.effect(() => ctx.configForms.whileServed([NAMESPACE], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: BUNDLE,
        locale: NS,
        inject: () => card.inject(),
      }, ReelCard))), 'reel: settings card page')
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
