import { useState } from 'react'
import { FileText, History, ListTree, Plus, RotateCcw, Star, Trash2, X } from 'lucide-react'
import { type Store, visiblePageIds } from '../store'
import type { Page, Section, TrashItem } from '../types'
import { SECTION_COLORS } from '../types'
import type { MenuItem } from './ContextMenu'
import { formatFullTime, formatTime } from '../lib/utils'

interface Props {
  store: Store
  prompt: (opts: { title: string; message?: string; value?: string; okText?: string }) => Promise<string | null>
  confirm: (opts: { title: string; message?: string; okText?: string; danger?: boolean }) => Promise<boolean>
  openMenu: (x: number, y: number, items: MenuItem[]) => void
  trashMode: boolean
  onExitTrash: () => void
}

function parsePayload(e: React.DragEvent): { type: string; id: string } | null {
  const raw = e.dataTransfer.getData('application/x-jam')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch (_) {
    return null
  }
}

const dragProps = (type: 'page' | 'section', id: string) => ({
  draggable: true,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-jam', JSON.stringify({ type, id }))
    e.dataTransfer.effectAllowed = 'move'
  },
})

export function MiddleColumn({ store, prompt, confirm, openMenu, trashMode, onExitTrash }: Props) {
  const [dropKey, setDropKey] = useState<string | null>(null)
  const data = store.data
  const notebook = data?.notebooks.find((n) => n.id === data.ui.activeNotebookId) || data?.notebooks[0] || null
  const sections: Section[] = notebook?.sections || []
  const activeSectionId = data?.ui.activeSectionId ?? null
  const activeSection = sections.find((s) => s.id === activeSectionId) || null
  const activePageId = data?.ui.activePageId ?? null
  const trash: TrashItem[] = data?.trash || []
  const view = data?.ui.listView || 'section'
  const tagFilter = data?.ui.tagFilter ?? null

  // 中栏列表按视图/分区/标签筛选取数（与顶部页签来源无关，页签是中栏显式创建的）。
  // store 是原地改数据，不能用 useMemo 缓存
  const pages: Page[] = (() => {
    const found: Page[] = []
    for (const id of visiblePageIds(data)) {
      const p = locatePageForList(data, id)
      if (p) found.push(p)
    }
    return found
  })()

  // 标签筛选候选：当前笔记本内出现过的标签
  const tagChips: string[] = []
  for (const sec of sections) for (const p of sec.pages) for (const t of p.tags || []) if (!tagChips.includes(t)) tagChips.push(t)
  tagChips.length = Math.min(tagChips.length, 12)

  const viewTitle = view === 'section' ? '页面' : view === 'recent' ? '最近打开' : '收藏'

  const parseTags = (raw: string) =>
    raw
      .split(/[,，、;；]/)
      .map((t) => t.trim().slice(0, 20))
      .filter(Boolean)
      .slice(0, 8)

  const addSection = async () => {
    if (!notebook) {
      const name = await prompt({ title: '新建笔记本', value: '新建笔记本', okText: '创建' })
      if (!name) return
      const nbId = store.createNotebook(name)
      const secName = await prompt({ title: '新建分区', value: '新建分区', okText: '创建' })
      if (secName) store.createSection(nbId, secName)
      return
    }
    const title = await prompt({ title: `在「${notebook.title}」下新建分区`, value: '新建分区', okText: '创建' })
    if (title) store.createSection(notebook.id, title)
  }

  const addPage = async () => {
    if (!activeSection) {
      await addSection()
      return
    }
    const title = await prompt({ title: `在「${activeSection.title}」下新建页面`, value: '未命名页面', okText: '创建' })
    if (title) {
      onExitTrash()
      store.createPage(activeSection.id, title)
    }
  }

  const sectionMenu = (sec: Section, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      {
        label: '新建页面',
        onClick: async () => {
          const title = await prompt({ title: `在「${sec.title}」下新建页面`, value: '未命名页面', okText: '创建' })
          if (title) {
            onExitTrash()
            store.createPage(sec.id, title)
          }
        },
      },
      {
        label: '重命名',
        onClick: async () => {
          const title = await prompt({ title: '重命名分区', value: sec.title })
          if (title) store.renameSection(sec.id, title)
        },
      },
      {
        label: '设置颜色',
        onClick: () => {
          openMenu(
            e.clientX,
            e.clientY,
            SECTION_COLORS.map((c) => ({ label: `● ${c}`, onClick: () => store.setSectionColor(sec.id, c) }))
          )
        },
      },
      { separator: true },
      { label: '上移', onClick: () => store.moveSectionBy(sec.id, -1) },
      { label: '下移', onClick: () => store.moveSectionBy(sec.id, 1) },
      { separator: true },
      {
        label: '删除分区',
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: `删除分区「${sec.title}」？`,
            message: `其中 ${sec.pages.length} 个页面会进入回收站，可随时恢复。`,
            okText: '删除',
            danger: true,
          })
          if (ok) store.deleteSection(sec.id)
        },
      },
    ]
    openMenu(e.clientX, e.clientY, items)
  }

  const pageMenu = (page: Page, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const items: MenuItem[] = [
      {
        label: '打开为页签',
        onClick: () => store.selectPage(page.id),
      },
      { separator: true },
      {
        label: '重命名',
        onClick: async () => {
          const title = await prompt({ title: '重命名页面', value: page.title })
          if (title) store.renamePage(page.id, title)
        },
      },
      { label: '复制页面', onClick: () => store.duplicatePage(page.id) },
      {
        label: page.favorite ? '取消收藏' : '收藏（置顶显示）',
        onClick: () => store.toggleFavorite(page.id),
      },
      {
        label: '设置标签',
        onClick: async () => {
          const raw = await prompt({
            title: `设置「${page.title}」的标签`,
            message: '多个标签用逗号分隔，清空即移除全部标签。',
            value: (page.tags || []).join(', '),
            okText: '保存',
          })
          if (raw !== null) store.setPageTags(page.id, parseTags(raw))
        },
      },
      { separator: true },
      { label: '上移', onClick: () => store.movePageBy(page.id, -1), disabled: view !== 'section' },
      { label: '下移', onClick: () => store.movePageBy(page.id, 1), disabled: view !== 'section' },
      { separator: true },
      {
        label: '删除页面',
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: `删除页面「${page.title}」？`,
            message: '删除后进入回收站，可随时恢复。',
            okText: '删除',
            danger: true,
          })
          if (ok) store.deletePage(page.id)
        },
      },
    ]
    openMenu(e.clientX, e.clientY, items)
  }

  const handleSectionDrop = (sec: Section, index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropKey(null)
    const payload = parsePayload(e)
    if (!payload) return
    if (payload.type === 'page') {
      onExitTrash()
      store.movePage(payload.id, sec.id, sec.pages.length)
      return
    }
    if (payload.type === 'section' && notebook) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      let targetIndex = index + (after ? 1 : 0)
      const fromIndex = sections.findIndex((s) => s.id === payload.id)
      if (fromIndex >= 0 && fromIndex < targetIndex) targetIndex -= 1
      store.moveSection(payload.id, notebook.id, targetIndex)
    }
  }

  const handlePageDrop = (page: Page, index: number, e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDropKey(null)
    const payload = parsePayload(e)
    if (!payload || payload.type !== 'page' || !activeSection) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const after = e.clientY > rect.top + rect.height / 2
    let targetIndex = index + (after ? 1 : 0)
    const fromIndex = activeSection.pages.findIndex((p) => p.id === payload.id)
    if (fromIndex >= 0 && fromIndex < targetIndex) targetIndex -= 1
    store.movePage(payload.id, activeSection.id, targetIndex)
  }

  if (trashMode) {
    return (
      <section className="col col-list">
        <div className="col-head">
          <span className="col-title">回收站</span>
          <div className="trash-head-actions">
            {trash.length > 0 && (
              <button
                type="button"
                className="text-btn danger"
                onClick={async () => {
                  const ok = await confirm({
                    title: '清空回收站？',
                    message: `${trash.length} 个页面将被永久删除，无法恢复。`,
                    okText: '永久删除',
                    danger: true,
                  })
                  if (ok) store.emptyTrash()
                }}
              >
                清空
              </button>
            )}
            <button type="button" className="icon-btn" title="返回（Esc）" onClick={onExitTrash}>
              <X size={15} />
            </button>
          </div>
        </div>
        <div className="col-body">
          {trash.length === 0 && <div className="empty-panel">回收站是空的</div>}
          {trash.map((item) => (
            <div
              key={item.id}
              className="trash-item"
              onContextMenu={(e) => {
                e.preventDefault()
                openMenu(e.clientX, e.clientY, [
                  { label: '还原', onClick: () => store.restoreTrash(item.id) },
                  {
                    label: '彻底删除',
                    danger: true,
                    onClick: async () => {
                      const ok = await confirm({
                        title: `彻底删除「${item.page.title}」？`,
                        message: '此操作不可撤销。',
                        okText: '永久删除',
                        danger: true,
                      })
                      if (ok) store.purgeTrash(item.id)
                    },
                  },
                ])
              }}
            >
              <div className="trash-main">
                <div className="trash-title">{item.page.title}</div>
                <div className="trash-meta">
                  {item.notebookTitle} / {item.sectionTitle} · 删除于 {formatFullTime(item.deletedAt)}
                </div>
              </div>
              <div className="trash-actions">
                <button type="button" className="icon-btn" title="还原" onClick={() => store.restoreTrash(item.id)}>
                  <RotateCcw size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="彻底删除"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `彻底删除「${item.page.title}」？`,
                      message: '此操作不可撤销。',
                      okText: '永久删除',
                      danger: true,
                    })
                    if (ok) store.purgeTrash(item.id)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    )
  }

  return (
    <section className="col col-list">
      <div className="col-head">
        <span className="col-title">分区</span>
        <button type="button" className="icon-btn" title="新建分区" onClick={addSection}>
          <Plus size={15} />
        </button>
      </div>

      <div className="section-list">
        {sections.map((sec, index) => (
          <div
            key={sec.id}
            {...dragProps('section', sec.id)}
            className={`sec-item${sec.id === activeSectionId ? ' is-active' : ''}${
              dropKey === `sec-${sec.id}` ? ' is-drop' : ''
            }`}
            onClick={() => {
              onExitTrash()
              store.selectSection(sec.id)
            }}
            onDoubleClick={async () => {
              const title = await prompt({ title: '重命名分区', value: sec.title })
              if (title) store.renameSection(sec.id, title)
            }}
            onContextMenu={(e) => sectionMenu(sec, e)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-jam')) {
                e.preventDefault()
                setDropKey(`sec-${sec.id}`)
              }
            }}
            onDragLeave={() => setDropKey((k) => (k === `sec-${sec.id}` ? null : k))}
            onDrop={(e) => handleSectionDrop(sec, index, e)}
            title={`${sec.title}（可拖拽排序）`}
          >
            <span className="sec-dot" style={{ background: sec.color }} />
            <span className="sec-title">{sec.title}</span>
            <span className="sec-count">{sec.pages.length}</span>
          </div>
        ))}
        {sections.length === 0 && <div className="empty-panel small">还没有分区</div>}
      </div>

      <div className="col-head sub">
        <span className="col-title">{viewTitle}</span>
        <div className="view-switch">
          <button
            type="button"
            className={`vs-btn${view === 'section' ? ' is-on' : ''}`}
            title="当前分区的页面"
            onClick={() => store.setUi({ listView: 'section' })}
          >
            <ListTree size={13} />
          </button>
          <button
            type="button"
            className={`vs-btn${view === 'recent' ? ' is-on' : ''}`}
            title="最近打开的页面"
            onClick={() => store.setUi({ listView: 'recent' })}
          >
            <History size={13} />
          </button>
          <button
            type="button"
            className={`vs-btn${view === 'favorites' ? ' is-on' : ''}`}
            title="收藏的页面"
            onClick={() => store.setUi({ listView: 'favorites' })}
          >
            <Star size={13} />
          </button>
          <button type="button" className="icon-btn" title="新建页面" onClick={addPage}>
            <Plus size={15} />
          </button>
        </div>
      </div>

      {tagChips.length > 0 && (
        <div className="tag-row">
          <button
            type="button"
            className={`tag-chip${!tagFilter ? ' is-on' : ''}`}
            onClick={() => store.setUi({ tagFilter: null })}
          >
            全部
          </button>
          {tagChips.map((t) => (
            <button
              key={t}
              type="button"
              className={`tag-chip${tagFilter === t ? ' is-on' : ''}`}
              onClick={() => store.setUi({ tagFilter: tagFilter === t ? null : t })}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="col-body">
        {pages.length === 0 && (
          <div className="empty-panel">
            <FileText size={22} />
            <div>
              {view === 'section'
                ? '这个分区还没有页面'
                : view === 'recent'
                  ? '还没有最近打开的页面'
                  : tagFilter
                    ? '没有带这个标签的收藏页面'
                    : '还没有收藏的页面（右键页面可收藏）'}
            </div>
            {view === 'section' && !tagFilter && (
              <button type="button" className="btn btn-small btn-primary" onClick={addPage}>
                新建页面
              </button>
            )}
          </div>
        )}
        {pages.map((page, index) => {
          const inSectionView = view === 'section'
          const loc = inSectionView ? null : locatePageLite(data, page.id)
          return (
            <div
              key={page.id}
              {...(inSectionView ? dragProps('page', page.id) : {})}
              className={`page-item${page.id === activePageId ? ' is-active' : ''}${
                dropKey === `pg-${page.id}` ? ' is-drop' : ''
              }`}
              onClick={() => {
                onExitTrash()
                // 级联：选中页面 → 顶部只显示该页面的页签（+ 收藏常驻）
                store.selectPage(page.id)
              }}
              onDoubleClick={async () => {
                const title = await prompt({ title: '重命名页面', value: page.title })
                if (title) store.renamePage(page.id, title)
              }}
              onContextMenu={(e) => pageMenu(page, e)}
              onDragOver={
                inSectionView
                  ? (e) => {
                      if (e.dataTransfer.types.includes('application/x-jam')) {
                        e.preventDefault()
                        setDropKey(`pg-${page.id}`)
                      }
                    }
                  : undefined
              }
              onDragLeave={inSectionView ? () => setDropKey((k) => (k === `pg-${page.id}` ? null : k)) : undefined}
              onDrop={inSectionView ? (e) => handlePageDrop(page, index, e) : undefined}
              title={loc ? `${loc.nb} / ${loc.sec}` : page.title}
            >
              <div className="page-title">
                {page.favorite && <Star size={11} className="page-star" />}
                <span className="page-title-text">{page.title}</span>
                {page.tabs.length > 0 && <span className="page-tabcount">{page.tabs.length}</span>}
              </div>
              {(page.tags?.length || 0) > 0 && (
                <div className="page-tags">
                  {(page.tags || []).slice(0, 3).map((t) => (
                    <span key={t} className="page-tag">
                      #{t}
                    </span>
                  ))}
                </div>
              )}
              <div className="page-time">{formatTime(page.updatedAt)}</div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** 按 id 找页面对象（供 visiblePageIds 的结果还原成 Page） */
function locatePageForList(data: any, pageId: string): Page | null {
  for (const nb of data?.notebooks || []) for (const sec of nb.sections) for (const p of sec.pages) if (p.id === pageId) return p
  return null
}

/** 最近 / 收藏视图里显示页面所属位置 */
function locatePageLite(data: any, pageId: string): { nb: string; sec: string } | null {
  for (const nb of data?.notebooks || []) {
    for (const sec of nb.sections) {
      if (sec.pages.some((p: Page) => p.id === pageId)) return { nb: nb.title, sec: sec.title }
    }
  }
  return null
}
