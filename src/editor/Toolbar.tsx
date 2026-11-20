import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  Combine,
  Columns3,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  MousePointer2,
  MoveHorizontal,
  MoveVertical,
  Quote,
  Redo2,
  Rows3,
  Split,
  SquareCode,
  Strikethrough,
  Table,
  Trash2,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'
import {
  adjustRowHeight,
  getSelectionShape,
  getTableNodeWidth,
  setTableWidth,
  startCellSelection,
  updateSelectedCells,
} from './tableUtils'

interface Props {
  editor: Editor | null
  /** 正文宽度：0 = 自适应铺满；>0 固定 px */
  contentWidth?: number
  onContentWidth?: (w: number) => void
}

const WIDTH_PRESETS = [
  { label: '自适应', value: 0 },
  { label: '900', value: 900 },
  { label: '1200', value: 1200 },
  { label: '1600', value: 1600 },
]

function Btn({
  active,
  title,
  onClick,
  disabled,
  label,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  disabled?: boolean
  label?: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`tb-btn${active ? ' is-active' : ''}${label ? ' with-label' : ''}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
      {label && <span>{label}</span>}
    </button>
  )
}

const GRID_ROWS = 8
const GRID_COLS = 10

export function Toolbar({ editor, contentWidth = 0, onContentWidth }: Props) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [tableOpen, setTableOpen] = useState(false)
  const [tableHover, setTableHover] = useState<{ r: number; c: number } | null>(null)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const [widthOpen, setWidthOpen] = useState(false)
  const widthWrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!linkOpen) return
    const href = editor?.getAttributes('link')?.href || ''
    setLinkValue(href)
    setTimeout(() => inputRef.current?.focus(), 10)
  }, [linkOpen, editor])

  // 点击外部关闭表格网格 / 宽度浮层
  useEffect(() => {
    if (!tableOpen && !widthOpen) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (tableOpen && !tableWrapRef.current?.contains(target)) setTableOpen(false)
      if (widthOpen && !widthWrapRef.current?.contains(target)) setWidthOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTableOpen(false)
        setWidthOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tableOpen, widthOpen])

  if (!editor) return <div className="toolbar" />

  const chain = () => editor.chain().focus()

  const tableShape = editor.isActive('table') ? getSelectionShape(editor) : null
  const tableWidth = editor.isActive('table') ? getTableNodeWidth(editor) : 0
  const mergeable = !!tableShape && (tableShape.rows > 1 || tableShape.cols > 1)
  const splittable = !!tableShape?.span
  const setAlign = (textAlign: 'left' | 'center' | 'right') => updateSelectedCells(editor, { textAlign })
  const stepTableWidth = (delta: number) => setTableWidth(editor, (tableWidth || 720) + delta)

  /** 在文档末尾安全插入表格；光标在表格内时先退出，避免嵌套破坏已有内容 */
  const insertGridTable = (rows: number, cols: number) => {
    const ed = editor
    let base = ed.chain().focus()
    if (ed.isActive('table')) {
      const { $from } = ed.state.selection
      let after = -1
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
          after = $from.after(d)
          break
        }
      }
      if (after >= 0) base = ed.chain().focus(after)
    }
    base.insertTable({ rows, cols, withHeaderRow: true }).run()
    setTableOpen(false)
    setTableHover(null)
  }

  const applyLink = () => {
    const href = linkValue.trim()
    if (!href) {
      chain().extendMarkRange('link').unsetLink().run()
    } else {
      const url = /^(https?:|mailto:|#|\/)/i.test(href) ? href : `https://${href}`
      chain().extendMarkRange('link').setLink({ href: url }).run()
    }
    setLinkOpen(false)
  }

  return (
    <>
    <div className="toolbar">
      <Btn title="撤销 (Ctrl+Z)" onClick={() => chain().undo().run()} disabled={!editor.can().undo()}>
        <Undo2 size={16} />
      </Btn>
      <Btn title="重做 (Ctrl+Y)" onClick={() => chain().redo().run()} disabled={!editor.can().redo()}>
        <Redo2 size={16} />
      </Btn>

      <span className="tb-sep" />

      <Btn title="加粗 (Ctrl+B)" active={editor.isActive('bold')} onClick={() => chain().toggleBold().run()}>
        <Bold size={16} />
      </Btn>
      <Btn title="斜体 (Ctrl+I)" active={editor.isActive('italic')} onClick={() => chain().toggleItalic().run()}>
        <Italic size={16} />
      </Btn>
      <Btn title="下划线 (Ctrl+U)" active={editor.isActive('underline')} onClick={() => chain().toggleUnderline().run()}>
        <UnderlineIcon size={16} />
      </Btn>
      <Btn title="删除线" active={editor.isActive('strike')} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough size={16} />
      </Btn>
      <Btn title="行内代码 (Ctrl+E)" active={editor.isActive('code')} onClick={() => chain().toggleCode().run()}>
        <Code size={16} />
      </Btn>

      <span className="tb-sep" />

      <Btn
        title="标题 1"
        active={editor.isActive('heading', { level: 1 })}
        onClick={() => chain().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={16} />
      </Btn>
      <Btn
        title="标题 2"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={16} />
      </Btn>
      <Btn
        title="标题 3"
        active={editor.isActive('heading', { level: 3 })}
        onClick={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 size={16} />
      </Btn>

      <span className="tb-sep" />

      <Btn title="无序列表" active={editor.isActive('bulletList')} onClick={() => chain().toggleBulletList().run()}>
        <List size={16} />
      </Btn>
      <Btn title="有序列表" active={editor.isActive('orderedList')} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={16} />
      </Btn>
      <Btn title="待办清单" active={editor.isActive('taskList')} onClick={() => chain().toggleTaskList().run()}>
        <ListChecks size={16} />
      </Btn>

      <span className="tb-sep" />

      <div className="tb-link-wrap">
        <Btn title="超链接" active={editor.isActive('link') || linkOpen} onClick={() => setLinkOpen((v) => !v)}>
          <Link2 size={16} />
        </Btn>
        {linkOpen && (
          <div className="tb-link-pop">
            <input
              ref={inputRef}
              value={linkValue}
              placeholder="https://..."
              onChange={(e) => setLinkValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyLink()
                }
                if (e.key === 'Escape') setLinkOpen(false)
              }}
            />
            <button type="button" onClick={applyLink}>
              确定
            </button>
            {editor.isActive('link') && (
              <button
                type="button"
                className="link-remove"
                onClick={() => {
                  chain().extendMarkRange('link').unsetLink().run()
                  setLinkOpen(false)
                }}
              >
                移除
              </button>
            )}
          </div>
        )}
      </div>

      <Btn title="引用" active={editor.isActive('blockquote')} onClick={() => chain().toggleBlockquote().run()}>
        <Quote size={16} />
      </Btn>
      <Btn title="代码块 (Ctrl+Alt+C)" active={editor.isActive('codeBlock')} onClick={() => chain().toggleCodeBlock().run()}>
        <SquareCode size={16} />
      </Btn>
      <div className="tb-table-wrap" ref={tableWrapRef}>
        <Btn title="插入表格（选择行列）" active={tableOpen || editor.isActive('table')} onClick={() => setTableOpen((v) => !v)}>
          <Table size={16} />
        </Btn>
        {tableOpen && (
          <div className="tb-table-pop" onMouseDown={(e) => e.preventDefault()}>
            <div className="tb-table-grid">
              {Array.from({ length: GRID_ROWS }, (_, ri) =>
                Array.from({ length: GRID_COLS }, (_, ci) => {
                  const r = ri + 1
                  const c = ci + 1
                  const on = !!tableHover && r <= tableHover.r && c <= tableHover.c
                  return (
                    <button
                      type="button"
                      key={`${r}-${c}`}
                      className={`tb-grid-cell${on ? ' is-on' : ''}`}
                      title={`插入 ${r} 行 × ${c} 列`}
                      onMouseEnter={() => setTableHover({ r, c })}
                      onClick={() => insertGridTable(r, c)}
                    />
                  )
                })
              )}
            </div>
            <div className="tb-table-label">{tableHover ? `${tableHover.r} 行 × ${tableHover.c} 列` : '移动鼠标选择行列'}</div>
          </div>
        )}
      </div>
      <Btn title="分割线" onClick={() => chain().setHorizontalRule().run()}>
        <Minus size={16} />
      </Btn>

      <div className="tb-width-wrap" ref={widthWrapRef}>
        <Btn title="正文宽度" active={widthOpen || contentWidth > 0} onClick={() => setWidthOpen((v) => !v)}>
          <MoveHorizontal size={16} />
        </Btn>
        {widthOpen && (
          <div className="tb-width-pop">
            <div className="tb-width-title">正文宽度</div>
            <div className="tb-width-presets">
              {WIDTH_PRESETS.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  className={contentWidth === p.value ? 'is-on' : ''}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onContentWidth?.(p.value)
                    setWidthOpen(false)
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="tb-width-slider">
              <input
                type="range"
                min={420}
                max={3200}
                step={20}
                value={contentWidth || 900}
                aria-label="正文宽度"
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => onContentWidth?.(Number(e.target.value))}
              />
              <span>{contentWidth ? `${contentWidth}px` : '自适应'}</span>
            </div>
          </div>
        )}
      </div>
    </div>

    {editor.isActive('table') && (
      <div className="table-toolbar">
        <span className="tt-label">表格</span>
        <Btn title="上方插入行" label="上行" onClick={() => chain().addRowBefore().run()}>
          <Rows3 size={15} />
        </Btn>
        <Btn title="下方插入行" label="下行" onClick={() => chain().addRowAfter().run()}>
          <Rows3 size={15} />
        </Btn>
        <span className="tb-sep" />
        <Btn title="左侧插入列" label="左列" onClick={() => chain().addColumnBefore().run()}>
          <Columns3 size={15} />
        </Btn>
        <Btn title="右侧插入列" label="右列" onClick={() => chain().addColumnAfter().run()}>
          <Columns3 size={15} />
        </Btn>
        <span className="tb-sep" />
        <Btn
          title="区域选择：再按 Shift+方向键扩展，或 Shift+拖拽单元格"
          label="选区"
          onClick={() => startCellSelection(editor)}
        >
          <MousePointer2 size={15} />
        </Btn>
        {tableShape && (tableShape.rows > 1 || tableShape.cols > 1) && (
          <span className="tt-label">{tableShape.rows}×{tableShape.cols}</span>
        )}
        <Btn title="左对齐" label="左" onClick={() => setAlign('left')}>
          <AlignLeft size={15} />
        </Btn>
        <Btn title="居中对齐" label="中" onClick={() => setAlign('center')}>
          <AlignCenter size={15} />
        </Btn>
        <Btn title="右对齐" label="右" onClick={() => setAlign('right')}>
          <AlignRight size={15} />
        </Btn>
        <span className="tb-sep" />
        <Btn title="合并选中单元格" label="合并" disabled={!mergeable} onClick={() => chain().mergeCells().run()}>
          <Combine size={15} />
        </Btn>
        <Btn title="拆分选中单元格" label="拆分" disabled={!splittable} onClick={() => chain().splitCell().run()}>
          <Split size={15} />
        </Btn>
        <span className="tb-sep" />
        <Btn title="表格宽度 +80px" label="宽+" onClick={() => stepTableWidth(80)}>
          <Maximize2 size={15} />
        </Btn>
        <Btn title="表格宽度 -80px" label="宽-" onClick={() => stepTableWidth(-80)}>
          <Minimize2 size={15} />
        </Btn>
        <Btn title="表格宽度恢复自适应" label="自适应" onClick={() => setTableWidth(editor, null)}>
          <MoveHorizontal size={15} />
        </Btn>
        <Btn title="行高 +8px" label="行高+" onClick={() => adjustRowHeight(editor, 8)}>
          <MoveVertical size={15} />
        </Btn>
        <Btn title="行高 -8px" label="行高-" onClick={() => adjustRowHeight(editor, -8)}>
          <MoveVertical size={15} />
        </Btn>
        <span className="tb-sep" />
        <Btn title="删除当前行" label="删行" onClick={() => chain().deleteRow().run()}>
          <Trash2 size={15} />
        </Btn>
        <Btn title="删除当前列" label="删列" onClick={() => chain().deleteColumn().run()}>
          <Trash2 size={15} />
        </Btn>
        <Btn title="删除整个表格" label="删表" onClick={() => chain().deleteTable().run()}>
          <Trash2 size={15} />
        </Btn>
      </div>
    )}
    </>
  )
}
