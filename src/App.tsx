import { useEffect, useRef, useState } from 'react'
import { FileCode2, FilePlus2, FolderOpen, Moon, PanelRight, Plus, Search, Settings, Star, Sun, X } from 'lucide-react'
import { locatePage, locateTab, locateTabIndex, useStore, visibleTabs } from './store'
import { storage } from './lib/storage'
import { formatFullTime, formatTime } from './lib/utils'
import { toast } from './lib/toast'
import { exportPage } from './lib/exportActions'
import type { AppInfo, Tab } from './types'
import type { MenuItem } from './components/ContextMenu'
import { Sidebar } from './components/Sidebar'
import { MiddleColumn } from './components/MiddleColumn'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { ContextMenu } from './components/ContextMenu'
import { Toasts } from './components/Toasts'
import { useDialogs } from './components/Dialogs'
import { ChangelogDialog } from './components/ChangelogDialog'
import { PageEditor } from './editor/PageEditor'
import {
  canDrop,
  dropKey as dndDropKey,
  edgeFromEvent,
  endDrag,
  getCurrentDrag,
  readPayload,
  startDrag,
  writePayload,
  type DragPayload,
} from './lib/dnd'

/** 导出一个页签（页签是唯一正文载体）。具名函数便于右键菜单引用。 */
function voidExportTab(tab: Tab, kind: 'md' | 'html') {
  return exportPage({ title: tab.title, content: tab.content, md: tab.md, mode: tab.mode }, kind)
}

export default function App() {
  const store = useStore()
  const dlg = useDialogs()
  const [searchOpen, setSearchOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [trashMode, setTrashMode] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [focusQuery, setFocusQuery] = useState<{ query: string; nonce: number } | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [sbW, setSbW] = useState(200)
  const [lw, setLw] = useState(240)
  const [dragging, setDragging] = useState<'sidebar' | 'list' | null>(null)
  const [tabHint, setTabHint] = useState<string | null>(null)
  const [tabDragId, setTabDragId] = useState<string | null>(null)
  const widths = useRef({ sb: 200, lw: 240 })
  const nonce = useRef(0)

  // 供冒烟测试直接驱动 store
  useEffect(() => {
    ;(window as any).__store = store
    return () => {
      delete (window as any).__store
    }
  }, [store])

  const data = store.data
  const theme = data?.ui.theme || 'light'
  const skin = data?.ui.skin || 'paper'
  // 顶部页签级联：当前中栏选中页面的页签 + 全库收藏页签（常驻）
  const tabLocs = visibleTabs(data)
  const activeTabId = data?.ui.activeTabId || null
  const activePageId = data?.ui.activePageId || null

  // 页签拖拽：同一页面内排序，或迁到另一个页面（含跨分区/跨笔记本的收藏常驻页签）
  const onTabDragStart = (e: React.DragEvent, id: string) => {
    const payload: DragPayload = { type: 'tab', id }
    writePayload(e.dataTransfer, payload)
    startDrag(payload)
    setTabDragId(id)
  }
  const onTabDragOver = (e: React.DragEvent, id: string) => {
    const payload = getCurrentDrag()
    if (!canDrop(payload, 'page')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setTabHint(dndDropKey('page', id, edgeFromEvent(e, 'x')))
  }
  const onTabDrop = (e: React.DragEvent, targetTabId: string) => {
    setTabHint(null)
    setTabDragId(null)
    endDrag()
    const payload = readPayload(e.dataTransfer) || getCurrentDrag()
    if (!canDrop(payload, 'page')) return
    e.preventDefault()
    const targetLoc = locateTab(data, targetTabId)
    if (!targetLoc) return
    const idx = locateTabIndex(data, targetTabId)
    const to = idx + (edgeFromEvent(e, 'x') === 'before' ? 0 : 1)
    store.moveNode(payload!, { kind: 'page', id: targetLoc.page.id, index: to })
  }

  const outlineOpen = data?.ui.outlineOpen !== false
  const mdLayout = data?.ui.mdLayout || 'split'
  const contentWidth = data?.ui.contentWidth || 0

  // 主题 + 皮肤：两者都写到 html dataset，CSS 变量据此组合出对应外观
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.skin = skin
  }, [theme, skin])

  /** 切换皮肤：按方案推荐明暗（夜墨默认深色），再单独覆写皮肤字段 */
  const chooseSkin = (next: 'paper' | 'workbench' | 'ink') => {
    const recommendedTheme = next === 'ink' ? 'dark' : 'light'
    store.setUi({ skin: next, theme: recommendedTheme })
  }

  // 应用信息
  useEffect(() => {
    void storage.info().then(setInfo)
  }, [])

  // 栏宽从数据恢复
  useEffect(() => {
    if (!store.ready || !data) return
    setSbW(data.ui.sidebarWidth || 200)
    setLw(data.ui.listWidth || 240)
    widths.current = { sb: data.ui.sidebarWidth || 200, lw: data.ui.listWidth || 240 }
  }, [store.ready])

  /** 打开本地 .md：读文件 -> 在当前页面新建 md 页签并激活。工具按钮与快捷键共用。 */
  const openMarkdown = async () => {
    if (!activePageId) {
      toast('请先在中栏选中一个页面', 'info')
      return
    }
    const res = await storage.openMarkdown()
    if (res.canceled) return
    if (!res.ok || typeof res.content !== 'string') {
      toast(res.error ? `打开失败：${res.error}` : '打开失败', 'error')
      return
    }
    store.openMarkdownTab(activePageId, res.name || '未命名文档', res.content)
    toast(`已打开 ${res.name}${res.encoding && res.encoding !== 'UTF-8' ? `（${res.encoding}）` : ''}`, 'ok')
  }

  // 快捷键
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        store.cycleTab(e.shiftKey ? -1 : 1)
        return
      }
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      if (mod && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        if (activeTabId) store.togglePageMode(activeTabId)
        return
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void store.flush().then(() => toast('已保存到本地', 'ok'))
        return
      }
      // Esc 逐层关闭：弹窗 / 右键菜单由各自处理，这里只负责回收站视图
      if (e.key === 'Escape' && trashMode && !menu && !searchOpen && !settingsOpen && !changelogOpen) {
        setTrashMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store, trashMode, menu, searchOpen, settingsOpen, changelogOpen])

  // 拖拽调整栏宽
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      if (dragging === 'sidebar') {
        const next = Math.min(420, Math.max(160, e.clientX))
        widths.current.sb = next
        setSbW(next)
      } else {
        const next = Math.min(520, Math.max(160, e.clientX - widths.current.sb - 6))
        widths.current.lw = next
        setLw(next)
      }
    }
    const onUp = () => {
      setDragging(null)
      store.setUi({ sidebarWidth: widths.current.sb, listWidth: widths.current.lw }, false)
      document.body.classList.remove('is-resizing')
      store.touch()
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging, store])

  // 编辑区只由激活页签决定：有页签才有正文，activePageId/分区/笔记本同步自它
  const activeLoc = locateTab(data, activeTabId)
  const activeTab = activeLoc?.tab || null
  const pageLoc = activeLoc ? { notebook: activeLoc.notebook, section: activeLoc.section, page: activeLoc.page } : null
  const selectedPage = locatePage(data, activePageId)?.page || null

  const openMenu = (x: number, y: number, items: MenuItem[]) => setMenu({ x, y, items })

  const addPage = async () => {
    const sec = pageLoc?.section || null
    if (!sec) {
      toast('先建一个分区', 'info')
      return
    }
    setTrashMode(false)
    const title = await dlg.prompt({ title: '新建页面', value: '未命名页面', okText: '创建' })
    if (title) store.createPage(sec.id, title)
  }

  if (!store.ready) {
    return <div className="boot">正在加载本地数据…</div>
  }

  const saveText =
    store.saveState === 'saving'
      ? '保存中…'
      : store.saveState === 'error'
        ? `保存失败：${store.saveError || ''}`
        : store.lastSavedAt
          ? `已保存 ${formatTime(store.lastSavedAt)}`
          : '已就绪'

  return (
    <div className="app" style={{ gridTemplateColumns: `${sbW}px 5px ${lw}px 5px minmax(320px, 1fr)` }}>
      <Sidebar
        store={store}
        prompt={dlg.prompt}
        confirm={dlg.confirm}
        openMenu={openMenu}
        onTrash={() => setTrashMode((v) => !v)}
        trashCount={data?.trash.length || 0}
        trashActive={trashMode}
        onOpenChangelog={() => setChangelogOpen(true)}
      />

      <div className="splitter" onMouseDown={(e) => { e.preventDefault(); setDragging('sidebar') }} />

      <MiddleColumn
        store={store}
        prompt={dlg.prompt}
        confirm={dlg.confirm}
        openMenu={openMenu}
        trashMode={trashMode}
        onExitTrash={() => setTrashMode(false)}
      />

      <div className="splitter" onMouseDown={(e) => { e.preventDefault(); setDragging('list') }} />

      <main className="col-main">
        {storage.mode === 'browser' && (
          <div className="mode-banner">
            浏览器预览模式：数据存在 localStorage，桌面版（npm start）数据写入 data/data.json
          </div>
        )}

        <div className="tab-bar" role="tablist" aria-label="页签">
          {tabLocs.map((loc) => {
            const tabId = loc.tab.id
            const active = tabId === activeTabId
            const favorite = !!loc.tab.favorite
            return (
              <div
                key={tabId}
                role="tab"
                data-tab-id={tabId}
                aria-selected={active}
                className={`tab${active ? ' is-active' : ''}${
                  tabDragId === tabId ? ' is-dragging' : ''
                }${
                  tabHint === dndDropKey('page', tabId, 'before') ? ' is-drop-before' : ''
                }${tabHint === dndDropKey('page', tabId, 'after') ? ' is-drop-after' : ''}`}
                draggable
                onDragStart={(e) => onTabDragStart(e, tabId)}
                onDragEnd={() => { setTabDragId(null); setTabHint(null); endDrag() }}
                onDragOver={(e) => onTabDragOver(e, tabId)}
                onDragLeave={() => setTabHint((k) => (k && k.startsWith(`page:${tabId}:`) ? null : k))}
                onDrop={(e) => onTabDrop(e, tabId)}
                title={`${loc.notebook.title} / ${loc.section.title} / ${loc.page.title}（拖拽可排序或迁到其他页面）`}
                onClick={() => {
                  setTrashMode(false)
                  store.activateTab(tabId)
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) {
                    e.preventDefault()
                    store.closeTab(tabId)
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenu(e.clientX, e.clientY, [
                    { label: favorite ? '取消收藏（不再常驻）' : '收藏（常驻顶部）', onClick: () => store.toggleTabFavorite(tabId) },
                    { separator: true },
                    {
                      label: '重命名页签',
                      onClick: async () => {
                        const title = await dlg.prompt({ title: '重命名页签', value: loc.tab.title })
                        if (title) store.renameTab(tabId, title)
                      },
                    },
                    { label: '导出 Markdown', onClick: () => void voidExportTab(loc.tab, 'md') },
                    { label: '导出 HTML', onClick: () => void voidExportTab(loc.tab, 'html') },
                    { separator: true },
                    { label: '关闭页签', onClick: () => store.closeTab(tabId) },
                    { label: '关闭其他页签', onClick: () => store.closeOtherTabs(tabId) },
                    { label: '关闭全部页签', onClick: () => store.closeAllTabs() },
                  ])
                }}
              >
                <span className="tab-dot" style={{ background: loc.section.color }} />
                <span className="tab-title">{loc.tab.title || loc.page.title || '未命名页面'}</span>
                <button
                  type="button"
                  className="tab-close"
                  title="关闭页签"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.closeTab(tabId)
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="tab-add"
            title={activePageId ? '在当前页面新建空白页签' : '请先在中栏选中一个页面'}
            disabled={!activePageId}
            onClick={() => {
              if (!activePageId) {
                toast('请先在中栏选中一个页面', 'info')
                return
              }
              setTrashMode(false)
              store.newTab(activePageId)
            }}
          >
            <Plus size={15} />
          </button>
        </div>

        {!pageLoc ? (
          <div className="empty-main">
            <FilePlus2 size={34} />
            <div className="empty-title">
              {selectedPage ? `「${selectedPage.title}」还没有页签` : '还没有选中页面'}
            </div>
            <div className="empty-desc">
              {selectedPage
                ? '点击上方页签栏最右侧的 ＋ 新建空白页签，即可开始记录'
                : '在中栏选择一个页面，再点页签栏最右侧的 ＋ 新建页签'}
            </div>
            {selectedPage ? (
              <button type="button" className="btn btn-primary" onClick={() => store.newTab(selectedPage.id)}>
                新建空白页签
              </button>
            ) : (
              <button type="button" className="btn btn-primary" onClick={addPage} disabled={!data?.notebooks.length}>
                新建页面
              </button>
            )}
          </div>
        ) : (
          <>
            <header className="page-head">
              <div className="head-left">
                <PageTitle
                  key={activeTab!.id}
                  title={activeTab!.title}
                  onCommit={(t) => store.renameTab(activeTab!.id, t)}
                  onEnter={() => store.flush()}
                />
                <div className="head-meta">
                  {pageLoc.notebook.title} / {pageLoc.section.title} / {pageLoc.page.title} · 修改于{' '}
                  {formatFullTime(activeTab!.updatedAt)}
                </div>
              </div>
              <div className="head-right">
                <span className={`save-dot ${store.saveState}`} title={saveText} />
                <span className="save-text">{saveText}</span>
                <button
                  type="button"
                  className="icon-btn"
                  title="打开本地 Markdown 文件 (.md)"
                  onClick={() => void openMarkdown()}
                >
                  <FolderOpen size={16} />
                </button>
                <button type="button" className="icon-btn" title="搜索 (Ctrl+K)" onClick={() => setSearchOpen(true)}>
                  <Search size={16} />
                </button>
                <button
                  type="button"
                  className={`icon-btn${activeTab!.mode === 'md' ? ' is-on' : ''}`}
                  title={activeTab!.mode === 'md' ? '切回富文本 (Ctrl+M)' : 'Markdown 双栏预览 (Ctrl+M)'}
                  onClick={() => store.togglePageMode(activeTab!.id)}
                >
                  <FileCode2 size={16} />
                </button>
                <button
                  type="button"
                  className={`icon-btn${activeTab!.favorite ? ' is-on' : ''}`}
                  title={activeTab!.favorite ? '取消收藏当前页签（不再常驻顶部）' : '收藏当前页签（常驻顶部）'}
                  onClick={() => store.toggleTabFavorite(activeTab!.id)}
                >
                  <Star size={16} fill={activeTab!.favorite ? 'currentColor' : 'none'} />
                </button>
                <button
                  type="button"
                  className={`icon-btn${outlineOpen ? ' is-on' : ''}`}
                  title={outlineOpen ? '隐藏大纲' : '显示大纲'}
                  onClick={() => store.setUi({ outlineOpen: !outlineOpen })}
                >
                  <PanelRight size={16} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={theme === 'light' ? '切到深色' : '切到浅色'}
                  onClick={() => store.setUi({ theme: theme === 'light' ? 'dark' : 'light' })}
                >
                  {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                </button>
                <button type="button" className="icon-btn" title="设置" onClick={() => setSettingsOpen(true)}>
                  <Settings size={16} />
                </button>
              </div>
            </header>

            <PageEditor
              key={activeTab!.id}
              tabId={activeTab!.id}
              memoryKey={activeTab!.id}
              content={activeTab!.content}
              onChange={(content) => store.updateContent(activeTab!.id, content)}
              focusQuery={focusQuery}
              showOutline={outlineOpen}
              mode={activeTab!.mode === 'md' ? 'md' : 'rich'}
              md={activeTab!.md || ''}
              onChangeMd={(value) => store.updateMarkdown(activeTab!.id, value)}
              mdLayout={mdLayout}
              onMdLayout={(next) => store.setUi({ mdLayout: next })}
              contentWidth={contentWidth}
              onContentWidth={(w) => store.setUi({ contentWidth: w })}
            />
          </>
        )}
      </main>

      <ChangelogDialog open={changelogOpen} onClose={() => setChangelogOpen(false)} />

      <SearchDialog
        open={searchOpen}
        data={data}
        onClose={() => setSearchOpen(false)}
        onSelect={(pageId, query, tabId) => {
          setTrashMode(false)
          if (tabId && tabId !== pageId) store.activateTab(tabId)
          else store.selectPage(pageId)
          nonce.current += 1
          setFocusQuery({ query, nonce: nonce.current })
        }}
      />

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        store={store}
        info={info}
        theme={theme}
        setTheme={(t) => store.setUi({ theme: t })}
        skin={skin}
        setSkin={chooseSkin}
        confirm={dlg.confirm}
      />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dlg.host}
      <Toasts />
    </div>
  )
}

function PageTitle({
  title,
  onCommit,
  onEnter,
}: {
  title: string
  onCommit: (t: string) => void
  onEnter: () => void
}) {
  const [value, setValue] = useState(title)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setValue(title)
  }, [title])

  const commit = (v: string) => {
    const t = v.trim() || '未命名页面'
    if (t !== title) onCommit(t)
  }

  return (
    <input
      className="title-input"
      value={value}
      onChange={(e) => {
        const v = e.target.value
        setValue(v)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => commit(v), 600)
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current)
        commit(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (timer.current) clearTimeout(timer.current)
          commit(value)
          onEnter()
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      placeholder="页签标题"
    />
  )
}
