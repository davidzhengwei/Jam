import { useState } from 'react'
import { Layers, Plus, Trash2 } from 'lucide-react'
import jamLogo from '../assets/jam.png'
import type { Store } from '../store'
import type { Notebook } from '../types'
import type { MenuItem } from './ContextMenu'
import { APP_VERSION } from '../lib/changelog'

interface Props {
  store: Store
  prompt: (opts: { title: string; message?: string; value?: string; okText?: string }) => Promise<string | null>
  confirm: (opts: { title: string; message?: string; okText?: string; danger?: boolean }) => Promise<boolean>
  openMenu: (x: number, y: number, items: MenuItem[]) => void
  onTrash: () => void
  trashCount: number
  trashActive: boolean
  onOpenChangelog: () => void
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

export function Sidebar({ store, prompt, confirm, openMenu, onTrash, trashCount, trashActive, onOpenChangelog }: Props) {
  const notebooks = store.data?.notebooks || []
  const activeId = store.data?.ui.activeNotebookId ?? null
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const addNotebook = async () => {
    const title = await prompt({ title: '新建笔记本', value: '新建笔记本', okText: '创建' })
    if (!title) return
    store.createNotebook(title)
  }

  const notebookMenu = (nb: Notebook, e: React.MouseEvent) => {
    e.preventDefault()
    const items: MenuItem[] = [
      {
        label: '新建分区',
        onClick: async () => {
          const title = await prompt({ title: `在「${nb.title}」下新建分区`, value: '新建分区', okText: '创建' })
          if (title) store.createSection(nb.id, title)
        },
      },
      {
        label: '重命名',
        onClick: async () => {
          const title = await prompt({ title: '重命名笔记本', value: nb.title })
          if (title) store.renameNotebook(nb.id, title)
        },
      },
      { separator: true },
      {
        label: '删除笔记本',
        danger: true,
        onClick: async () => {
          const ok = await confirm({
            title: `删除笔记本「${nb.title}」？`,
            message: `其中的 ${nb.sections.reduce((n, s) => n + s.pages.length, 0)} 个页面会进入回收站，可随时恢复。`,
            okText: '删除',
            danger: true,
          })
          if (ok) store.deleteNotebook(nb.id)
        },
      },
    ]
    openMenu(e.clientX, e.clientY, items)
  }

  return (
    <aside className="col col-sidebar">
      <div className="brand-row">
        <img src={jamLogo} alt="Jam" draggable={false} />
        <span className="brand-name">Jam</span>
        <button
          type="button"
          className="version-badge"
          title="查看更新记录"
          onClick={onOpenChangelog}
        >
          v{APP_VERSION}
        </button>
      </div>
      <div className="col-head">
        <span className="col-title">笔记本</span>
        <button type="button" className="icon-btn" title="新建笔记本" onClick={addNotebook}>
          <Plus size={15} />
        </button>
      </div>

      <div className="col-body">
        {notebooks.map((nb) => (
          <div
            key={nb.id}
            className={`nb-item${nb.id === activeId ? ' is-active' : ''}${dropTarget === nb.id ? ' is-drop' : ''}`}
            onClick={() => store.selectNotebook(nb.id)}
            onDoubleClick={async () => {
              const title = await prompt({ title: '重命名笔记本', value: nb.title })
              if (title) store.renameNotebook(nb.id, title)
            }}
            onContextMenu={(e) => notebookMenu(nb, e)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-jam')) {
                e.preventDefault()
                setDropTarget(nb.id)
              }
            }}
            onDragLeave={() => setDropTarget((cur) => (cur === nb.id ? null : cur))}
            onDrop={(e) => {
              setDropTarget(null)
              const payload = parsePayload(e)
              if (!payload || payload.type !== 'section') return
              e.preventDefault()
              store.moveSection(payload.id, nb.id, nb.sections.length)
            }}
            title={nb.title}
          >
            <Layers size={14} className="nb-icon" />
            <span className="nb-text">{nb.title}</span>
            <span className="nb-count">{nb.sections.length}</span>
          </div>
        ))}

        {notebooks.length === 0 && (
          <div className="empty-hint">
            还没有笔记本
            <button type="button" className="btn btn-small" onClick={addNotebook}>
              新建
            </button>
          </div>
        )}
      </div>

      <div className="col-foot">
        <button
          type="button"
          className={`foot-item${trashActive ? ' is-active' : ''}`}
          onClick={onTrash}
          title="回收站"
        >
          <Trash2 size={14} />
          <span>回收站</span>
          {trashCount > 0 && <span className="foot-badge">{trashCount}</span>}
        </button>
      </div>
    </aside>
  )
}
