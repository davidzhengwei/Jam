import { useCallback, useEffect, useRef, useState } from 'react'
import { GripHorizontal, Trash2 } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'

type Dir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Dir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

interface Frame {
  pos: number
  type: 'codeBlock' | 'table'
  top: number
  left: number
  width: number
  height: number
}
interface Drop {
  pos: number
  y: number
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))

/**
 * 对象控制框：代码块 / 表格被整体选中(NodeSelection)时，在其上方叠加一个
 * 类似 PPT 的控制框——四边四角 8 向拉伸、顶部把手整体拖拽移动、右上角删除。
 *
 * 注意：手柄都在节点 DOM 之外，mousedown 会被 ProseMirror 当成"点空白"而清空
 * 选区，进而让控制框消失。因此所有手势都在 pointerdown 时把 pos 捕获进闭包，
 * 并在手柄上拦截 mousedown；手势过程中不依赖随时可能被刷空的 frame state。
 */
export function ObjectFrame({ editor }: { editor: Editor }) {
  const [frame, setFrame] = useState<Frame | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const frameRef = useRef<Frame | null>(null)
  frameRef.current = frame

  const refresh = useCallback(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    const { state, view } = editor
    const sel = state.selection
    if (!(sel instanceof NodeSelection)) {
      setFrame(null)
      return
    }
    const node = state.doc.nodeAt(sel.from)
    if (!node || (node.type.name !== 'codeBlock' && node.type.name !== 'table')) {
      setFrame(null)
      return
    }
    const dom = view.nodeDOM(sel.from)
    if (!(dom instanceof HTMLElement)) {
      setFrame(null)
      return
    }
    const r = dom.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    setFrame({
      pos: sel.from,
      type: node.type.name as Frame['type'],
      top: r.top - a.top,
      left: r.left - a.left,
      width: r.width,
      height: r.height,
    })
  }, [editor])

  useEffect(() => {
    const anchor = editor.view.dom.closest('.editor-body') as HTMLElement | null
    anchorRef.current = anchor
    if (!anchor) return
    const scroller = anchor.querySelector('.editor-scroll')
    refresh()
    editor.on('selectionUpdate', refresh)
    editor.on('transaction', refresh)
    window.addEventListener('resize', refresh)
    scroller?.addEventListener('scroll', refresh, { passive: true })
    const ro = new ResizeObserver(refresh)
    ro.observe(anchor)
    return () => {
      editor.off('selectionUpdate', refresh)
      editor.off('transaction', refresh)
      window.removeEventListener('resize', refresh)
      scroller?.removeEventListener('scroll', refresh)
      ro.disconnect()
    }
  }, [editor, refresh])

  /** 直接按捕获的 pos 写尺寸；不读 frameRef，避免手势中选区变化导致失效 */
  const applySize = useCallback(
    (pos: number, w: number, h: number, type: 'codeBlock' | 'table') => {
      const { state, view } = editor
      const node = state.doc.nodeAt(pos)
      if (!node) return
      const minW = type === 'table' ? 240 : 320
      const width = clamp(w, minW, 3200)
      const height = clamp(h, 64, 1200)
      view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width, height }))
    },
    [editor]
  )

  const blockMousedown = (event: React.MouseEvent) => event.stopPropagation()

  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, dir: Dir) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const f = frameRef.current
      if (!f) return
      const pos = f.pos
      const type = f.type
      const node = editor.state.doc.nodeAt(pos)
      if (!node) return
      const x0 = event.clientX
      const y0 = event.clientY
      const startW = Number(node.attrs?.width) || Math.round(f.width)
      const startH = Number(node.attrs?.height) || Math.round(f.height)
      const minW = type === 'table' ? 240 : 320

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - x0
        const dy = ev.clientY - y0
        let w = startW
        let h = startH
        if (dir.includes('e')) w = startW + dx
        if (dir.includes('w')) w = startW - dx
        if (dir.includes('s')) h = startH + dy
        if (dir.includes('n')) h = startH - dy
        applySize(pos, w, h, type)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('jam-object-resizing')
        // 手势期间选区可能被清成 TextSelection，结束后恢复整块选中
        const sel = editor.state.selection
        if (!(sel instanceof NodeSelection) || sel.from !== pos) {
          try {
            editor.view.dispatch(
              editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos))
            )
          } catch (_) {
            // 节点可能已被移动/删除，忽略
          }
        }
      }
      document.body.classList.add('jam-object-resizing')
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [editor, applySize]
  )

  const resetSize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const f = frameRef.current
      if (!f) return
      const { state, view } = editor
      const node = state.doc.nodeAt(f.pos)
      if (!node) return
      view.dispatch(
        state.tr.setNodeMarkup(f.pos, undefined, { ...node.attrs, width: null, height: null })
      )
    },
    [editor]
  )

  /** 鼠标 Y 落在文档顶层哪个节点之间 -> 插入位置（doc 坐标）与该处屏幕 Y */
  const computeDrop = useCallback(
    (clientY: number): Drop => {
      const { state, view } = editor
      const doc = state.doc
      let acc = 0
      let dropY = 0
      for (let i = 0; i < doc.childCount; i++) {
        const child = doc.child(i)
        try {
          const dom = view.nodeDOM(acc)
          if (dom instanceof HTMLElement) {
            const r = dom.getBoundingClientRect()
            if (clientY < r.top + r.height / 2) return { pos: acc, y: r.top }
            dropY = r.bottom
          }
        } catch (_) {
          // 节点 DOM 暂不可用时按位置继续
        }
        acc += child.nodeSize
      }
      return { pos: acc, y: dropY }
    },
    [editor]
  )

  const moveTo = useCallback(
    (pos: number, dropPos: number) => {
      const { state, view } = editor
      const node = state.doc.nodeAt(pos)
      if (!node) return
      const size = node.nodeSize
      // 落点仍在本节点内部，视为无效移动
      if (dropPos > pos && dropPos < pos + size) return
      let target = dropPos
      if (pos < dropPos) target -= size
      const tr = state.tr.delete(pos, pos + size)
      target = clamp(target, 0, tr.doc.content.size)
      tr.insert(target, node)
      tr.setSelection(NodeSelection.create(tr.doc, target))
      view.dispatch(tr.scrollIntoView())
    },
    [editor]
  )

  const onDragStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const pos = frameRef.current?.pos
      if (typeof pos !== 'number') return
      document.body.classList.add('jam-object-dragging')
      const onMove = (ev: PointerEvent) => setDrop(computeDrop(ev.clientY))
      const onUp = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        document.body.classList.remove('jam-object-dragging')
        const target = computeDrop(ev.clientY)
        setDrop(null)
        moveTo(pos, target.pos)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [computeDrop, moveTo]
  )

  const onDelete = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const f = frameRef.current
      if (!f) return
      const { state, view } = editor
      const node = state.doc.nodeAt(f.pos)
      if (!node) return
      const tr = state.tr.delete(f.pos, f.pos + node.nodeSize)
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, f.pos - 1))))
      view.dispatch(tr.scrollIntoView())
    },
    [editor]
  )

  if (!frame) return null
  const anchor = anchorRef.current
  const dropTop = drop && anchor ? drop.y - anchor.getBoundingClientRect().top : 0

  return (
    <>
      <div
        className={`object-frame of-${frame.type}`}
        style={{ top: frame.top, left: frame.left, width: frame.width, height: frame.height }}
        onMouseDown={blockMousedown}
      >
        <div className="of-outline" />
        <div className="of-drag" onMouseDown={blockMousedown} onPointerDown={onDragStart} title="按住拖拽，整体移动位置">
          <GripHorizontal size={13} />
          <span>{frame.type === 'table' ? '表格' : '代码块'}</span>
        </div>
        <div className="of-tools">
          <button type="button" className="of-reset" onMouseDown={blockMousedown} onClick={resetSize} title="恢复自适应尺寸">
            自适应
          </button>
          <button type="button" className="of-delete" onMouseDown={blockMousedown} onClick={onDelete} title="删除整块 (Delete)">
            <Trash2 size={13} />
          </button>
        </div>
        {HANDLES.map((dir) => (
          <div
            key={dir}
            className={`of-handle of-h-${dir}`}
            title="拖拉缩放"
            onMouseDown={blockMousedown}
            onPointerDown={(e) => onResizeStart(e, dir)}
          />
        ))}
      </div>
      {drop && <div className="of-drop-line" style={{ top: dropTop }} />}
    </>
  )
}
