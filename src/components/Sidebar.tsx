import { useState } from 'react'
import { Layers, Plus, Trash2 } from 'lucide-react'
import jamLogo from '../assets/jam.png'
import type { Store } from '../store'
import type { Notebook } from '../types'
import type { MenuItem } from './ContextMenu'
import { APP_VERSION } from '../lib/changelog'
import {
  canDrop,
  dropKey,
  edgeFromEvent,
  getCurrentDrag,
  endDrag,
  readPayload,
  writePayload,
  type DragPayload,
} from '../lib/dnd'

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

export function Sidebar({ store, prompt, confirm, openMenu, onTrash, trashCount, trashActive, onOpenChangelog }: Props) {
  const notebooks = store.data?.notebooks || []
  const activeId = store.data?.ui.activeNotebookId ?? null
  const [hint, setHint] = useState<string | null>(null)

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

  const onDragOver = (e: React.DragEvent, nb: Notebook) => {
    const payload = getCurrentDrag()
    if (!canDrop(payload, 'notebook')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const edge = edgeFromEvent(e, 'y')
    setHint(dropKey('notebook', nb.id, edge))
  }

  const onDrop = (e: React.DragEvent, nb: Notebook) => {
    const edge = edgeFromEvent(e, 'y')
    setHint(null)
    endDrag()
    const payload: DragPayload | null = readPayload(e.dataTransfer) || getCurrentDrag()
    if (!canDrop(payload, 'notebook')) return
    e.preventDefault()
    const index = edge === 'before' ? 0 : nb.sections.length
    store.moveNode(payload!, { kind: 'notebook', id: nb.id, index })
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
            className={`nb-item${nb.id === activeId ? ' is-active' : ''}${
              hint === dropKey('notebook', nb.id, 'before') ? ' is-drop-before' : ''
            }${hint === dropKey('notebook', nb.id, 'after') ? ' is-drop-after' : ''}`}
            onClick={() => store.selectNotebook(nb.id)}
            onDoubleClick={async () => {
              const title = await prompt({ title: '重命名笔记本', value: nb.title })
              if (title) store.renameNotebook(nb.id, title)
            }}
            onContextMenu={(e) => notebookMenu(nb, e)}
            onDragOver={(e) => onDragOver(e, nb)}
            onDragLeave={() => setHint((cur) => (cur && cur.startsWith(`notebook:${nb.id}:`) ? null : cur))}
            onDrop={(e) => onDrop(e, nb)}
            title={`${nb.title}（分区可拖到此处调整顺序或迁移）`}
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
