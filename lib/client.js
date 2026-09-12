/**
 * dsh-reel — the client half: the plugin's card inside dsh's
 * Settings → Plugins → Plugin configuration.
 *
 * dsh's settings page renders no generic schema form: a settings namespace
 * gets a card only when a browser half registers one into the keyed
 * `settings.plugin.item` slot under that namespace's name. This file is that
 * browser half for `reel`.
 *
 * Format: the lazy-CJS bundle the client module system expects — executing the
 * script only REGISTERS the factory; the body runs at materialization. It is
 * hand-written instead of built (no tsdown, no JSX) so the package keeps its
 * zero-dependency, no-build property; the wrapper mirrors what tsdown emits
 * for the shipped client packages. Only `react` is required from the module
 * table; every dsh service arrives through cordis injection.
 *
 * The card edits the `reel` namespace through the client settings scope:
 * staged edits in local state, an explicit save that lands as one mutation,
 * per-field reset that drops the user-layer override back to the composition
 * row. On top of the two fields it adds the two things a form cannot express:
 * a one-click open of /reel and a link to the project's GitHub page.
 */

window.__ModuleLoader__.load({
  id: 'dsh-reel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')
    const h = react.createElement

    /** Settings namespace the host half registers; the slot key must match it. */
    const NAMESPACE = 'reel'
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
      rootsHint: '浏览页展示的根目录，可添加多个；改动热生效。',
      addRoot: '添加目录',
      remove: '移除',
      rootsPlaceholder: '例如 D:\\Photos',
      cacheDir: '缓存目录',
      cacheDirHint: '视频封面与悬停动画的缓存位置；留空使用系统临时目录。不要放在媒体目录里，否则缓存文件会出现在浏览页。',
      cacheDirPlaceholder: '例如 D:\\dsh-cache',
      openReel: '打开 Reel',
      github: 'GitHub 项目主页',
      unsaved: '未保存',
      expand: '展开',
      collapse: '收起',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      reset: '重置',
      overridden: '已覆盖',
      readOnly: '当前连接对设置只读，无法修改。',
      saveFailed: '保存失败：',
    }

    const en = {
      title: 'Reel media browser',
      description: 'Media directories and thumbnail cache for the viewer',
      roots: 'Media directories',
      rootsHint: 'Root directories offered by the viewer; add as many as you like. Changes apply live.',
      addRoot: 'Add directory',
      remove: 'Remove',
      rootsPlaceholder: 'e.g. D:\\Photos',
      cacheDir: 'Cache directory',
      cacheDirHint: 'Where poster frames and hover previews are cached; empty means the OS temp directory. Keep it outside the media roots, or cache files will show up in the gallery.',
      cacheDirPlaceholder: 'e.g. D:\\dsh-cache',
      openReel: 'Open Reel',
      github: 'GitHub project',
      unsaved: 'Unsaved',
      expand: 'Expand',
      collapse: 'Collapse',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      reset: 'Reset',
      overridden: 'Overridden',
      readOnly: 'This connection is read-only for settings; changes are disabled.',
      saveFailed: 'Save failed: ',
    }

    // Card styles, mirroring the host plugin cards (same alias variables, so
    // the card reads native in both themes). One injected style tag, guarded
    // so a re-materialization cannot stack copies.
    const css = [
      '.reel_card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}',
      '.reel_card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      '.reel_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.reel_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      '.reel_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      '.reel_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      '.reel_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;border:0;background:0 0;font:inherit;font-size:12px;line-height:1}',
      '.reel_chevronOpen{transform:rotate(180deg)}',
      '.reel_body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      '.reel_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}',
      '.reel_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      '.reel_field+.reel_field{border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.reel_head{align-items:center;gap:8px;display:flex}',
      '.reel_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      '.reel_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}',
      '.reel_reset:hover{color:var(--dsw-alias-label-primary)}',
      '.reel_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      '.reel_input{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;min-width:0;flex:1;box-sizing:border-box}',
      '.reel_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.reel_input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.reel_input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.reel_cacheRow{align-items:center;gap:8px;display:flex}',
      '.reel_rootRow{align-items:center;gap:8px;display:flex}',
      '.reel_rootList{flex-direction:column;gap:8px;margin:0;padding:0;list-style:none;display:flex}',
      '.reel_remove{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:5px 10px;font-size:12px;line-height:1.5;flex:none}',
      '.reel_remove:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_add{appearance:none;font:inherit;cursor:pointer;border:1px dashed var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);background:0 0;border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.5;align-self:flex-start}',
      '.reel_add:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_badge{color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;padding:1px 8px;font-size:11px;line-height:1.6;flex:none}',
      '.reel_meta{align-items:center;gap:14px;padding:12px 0 4px;display:flex}',
      '.reel_open{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.reel_github{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;text-decoration:none}',
      '.reel_github:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.reel_footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}',
      '.reel_failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}',
      '.reel_discard,.reel_save{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}',
      '.reel_discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}',
      '.reel_discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}',
      '.reel_save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.reel_discard:disabled,.reel_save:disabled{opacity:.4;cursor:default}',
    ].join('\n')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-reel/client.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-reel'
      tag.dataset.pluginCss = 'dsh-reel/client.css'
      tag.textContent = css
      document.head.appendChild(tag)
    }

    /**
     * Render the reel card.
     *
     * @param props - `t` from the bound locale, `scope` from the slot inject.
     * @returns the card `<li>`, or nothing while the namespace is unavailable
     *   (a deployment that does not compose reel shows no trace of it).
     */
    function ReelCard(props) {
      const { t, scope } = props
      const getSnapshot = react.useCallback(() => scope.getSnapshot(), [scope])
      const subscribe = react.useCallback((listener) => scope.subscribe(listener), [scope])
      const snap = react.useSyncExternalStore(subscribe, getSnapshot)
      const [draft, setDraft] = react.useState(null)
      const [open, setOpen] = react.useState(false)
      const [saving, setSaving] = react.useState(false)
      const [failed, setFailed] = react.useState(null)
      const saveStarted = react.useRef(false)

      react.useEffect(() => {
        if (saving) {
          saveStarted.current = true
          return
        }
        if (!saveStarted.current) return
        saveStarted.current = false
        // 结算成功且没有新改动时收起卡片；失败保持展开让错误可见。
        if (failed === null) setOpen(false)
      }, [saving, failed])

      if (snap.status !== 'ready') return null

      const value = snap.value ?? {}
      const currentRoots = Array.isArray(value.roots) ? value.roots : []
      const currentCache = typeof value.cacheDir === 'string' ? value.cacheDir : ''
      const shownRoots = draft ? draft.roots : currentRoots
      const shownCache = draft ? draft.cacheDir : currentCache
      const dirty = draft !== null
      const user = snap.user !== null && typeof snap.user === 'object' ? snap.user : {}
      const has = (key) => Object.prototype.hasOwnProperty.call(user, key)

      const disabled = !snap.writable || saving
      const discard = () => {
        setDraft(null)
        setFailed(null)
      }
      const save = async () => {
        if (draft === null || saving || !snap.writable) return
        const nextRoots = draft.roots.map((item) => item.trim()).filter((item) => item !== '')
        const nextCache = draft.cacheDir.trim()
        const ops = []
        if (JSON.stringify(nextRoots) !== JSON.stringify(currentRoots)) {
          ops.push({ op: 'set', path: ['roots'], value: nextRoots })
        }
        if (nextCache !== currentCache) {
          ops.push(nextCache === ''
            ? { op: 'unset', path: ['cacheDir'] }
            : { op: 'set', path: ['cacheDir'], value: nextCache })
        }
        if (ops.length === 0) {
          setDraft(null)
          return
        }
        setSaving(true)
        setFailed(null)
        try {
          await scope.mutate(ops, snap.revision)
          setDraft(null)
        } catch (error) {
          setFailed(String(error?.message ?? error))
        } finally {
          setSaving(false)
        }
      }
      const resetField = async (field) => {
        setDraft(null)
        setFailed(null)
        try {
          await scope.unset(field)
        } catch (error) {
          setFailed(String(error?.message ?? error))
        }
      }

      const blocked = !dirty || saving
      return h('li', { className: `reel_card${open ? ' reel_cardOpen' : ''}` },
        h('button', {
          type: 'button',
          className: 'reel_header',
          'aria-expanded': open,
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('title')}`,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'reel_headText' },
            h('span', { className: 'reel_name' }, t('title')),
            h('span', { className: 'reel_description' }, t('description')),
          ),
          dirty ? h('span', { className: 'reel_badge' }, t('unsaved')) : null,
          h('span', { className: `reel_chevron${open ? ' reel_chevronOpen' : ''}`, 'aria-hidden': 'true' }, '▾'),
        ),
        open ? h('div', { className: 'reel_body' },
          !snap.writable ? h('p', { className: 'reel_readOnly', role: 'status' }, t('readOnly')) : null,
          // 一键打开 + 项目页，放在最上面：展开即得，不用滚到表单底部。
          h('div', { className: 'reel_meta' },
            h('button', {
              type: 'button',
              className: 'reel_open',
              onClick: () => window.open(REEL_PATH, '_blank', 'noopener'),
            }, t('openReel')),
            h('a', { className: 'reel_github', href: GITHUB_URL, target: '_blank', rel: 'noreferrer' }, t('github')),
          ),
          h('div', { className: 'reel_field' },
            h('div', { className: 'reel_head' },
              h('span', { className: 'reel_label' }, t('roots')),
              has('roots') ? h('button', {
                type: 'button', className: 'reel_reset', disabled,
                title: t('overridden'), onClick: () => resetField('roots'),
              }, t('reset')) : null,
            ),
            h('p', { className: 'reel_hint' }, t('rootsHint')),
            h('ul', { className: 'reel_rootList' },
              shownRoots.map((root, index) => h('li', { className: 'reel_rootRow', key: index },
                h('input', {
                  className: 'reel_input',
                  type: 'text',
                  value: root,
                  placeholder: t('rootsPlaceholder'),
                  disabled,
                  spellCheck: false,
                  onChange: (event) => {
                    const list = shownRoots.slice()
                    list[index] = event.target.value
                    setDraft({ roots: list, cacheDir: shownCache })
                  },
                }),
                h('button', {
                  type: 'button', className: 'reel_remove', disabled,
                  'aria-label': t('remove'), onClick: () => {
                    const list = shownRoots.slice()
                    list.splice(index, 1)
                    setDraft({ roots: list, cacheDir: shownCache })
                  },
                }, '✕'),
              )),
            ),
            h('button', {
              type: 'button', className: 'reel_add', disabled,
              onClick: () => setDraft({ roots: shownRoots.concat(''), cacheDir: shownCache }),
            }, `＋ ${t('addRoot')}`),
          ),
          h('div', { className: 'reel_field' },
            h('div', { className: 'reel_head' },
              h('span', { className: 'reel_label' }, t('cacheDir')),
              has('cacheDir') ? h('button', {
                type: 'button', className: 'reel_reset', disabled,
                title: t('overridden'), onClick: () => resetField('cacheDir'),
              }, t('reset')) : null,
            ),
            h('div', { className: 'reel_cacheRow' },
              h('input', {
                className: 'reel_input',
                type: 'text',
                value: shownCache,
                placeholder: t('cacheDirPlaceholder'),
                disabled,
                spellCheck: false,
                onChange: (event) => setDraft({ roots: shownRoots.slice(), cacheDir: event.target.value }),
              }),
            ),
            h('p', { className: 'reel_hint' }, t('cacheDirHint')),
          ),
          h('div', { className: 'reel_footer' },
            failed !== null ? h('p', { className: 'reel_failed', role: 'status' }, `${t('saveFailed')}${failed}`) : null,
            h('button', { type: 'button', className: 'reel_discard', disabled: !dirty || saving, onClick: discard }, t('discard')),
            h('button', { type: 'button', className: 'reel_save', disabled: blocked || !snap.writable, onClick: save },
              t(saving ? 'saving' : 'save')),
          ),
        ) : null,
      )
    }

    /** Required services (cordis fiber inject on the browser side). */
    const inject = ['slots', 'locale', 'settingsScope']

    /**
     * Mount the card: register the copy dictionaries, bind the `reel` scope,
     * and contribute the card to the keyed plugin-item slot.
     *
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'reel: settings card dictionaries')
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })
      ctx.slots.inject('settings.plugin.item', function* () {
        yield ctx.slots.register({
          name: 'settings.plugin.item',
          key: NAMESPACE,
          locale: NS,
          inject: () => ({ scope }),
        }, ReelCard)
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
