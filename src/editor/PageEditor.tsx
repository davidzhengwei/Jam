import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Placeholder from '@tiptap/extension-placeholder'
import { CodeBlock } from './CodeBlock'
import { Toolbar } from './Toolbar'
import { Outline } from './Outline'
import { NoteImage } from './NoteImage'
import { MarkdownPane } from './MarkdownPane'
import type { MdLayout } from './MarkdownPane'
import type { Editor } from '@tiptap/react'
import { sanitizePastedHtml } from '../lib/sanitize'
import { mdToDocHtml } from '../lib/markdown'
import { saveAttachment } from '../lib/attachments'
import { toast } from '../lib/toast'
import { Columns3, Rows3 } from 'lucide-react'
import {
  findTablePosAt,
  getCellInfoAtPos,
  getGridPoint,
  isCellSelection,
  pasteMatrixIntoTable,
  setCellRange,
} from './tableUtils'

interface Props {
  /** 正文载体 id：第 4 层页签 id（页面/分区/笔记本无正文） */
  tabId: string
  /** 滚动/光标记忆的 key（用页签 id，保证同一页面多页签各自独立） */
  memoryKey?: string
  content: any
  onChange: (content: any) => void
  focusQuery?: { query: string; nonce: number } | null
  showOutline?: boolean
  /** 编辑模式：富文本 / Markdown 双栏 */
  mode?: 'rich' | 'md'
  /** Markdown 源码 */
  md?: string
  onChangeMd?: (md: string) => void
  mdLayout?: MdLayout
  onMdLayout?: (layout: MdLayout) => void
  /** 正文内容区宽度：0 = 自适应铺满；>0 固定宽度（超出可视区时横向滚动） */
  contentWidth?: number
  onContentWidth?: (w: number) => void
}

/** 每个页记住自己的滚动位置与光标，切换页签回来时接着看（key 为页签 id） */
const pageMemory = new Map<string, { scrollTop: number; selection: number }>()

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** 表格扩展：保留原生列宽拖拽，并给整个表格增加可持久化的宽度属性 */
const JamTable = Table.extend({
  addAttributes() {
    return {
      ...(this.parent?.() || {}),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const value = Number.parseInt(el.style.width || '', 10)
          return Number.isFinite(value) && value > 0 ? value : null
        },
        renderHTML: (attrs: Record<string, any>) => (attrs.width ? { style: `width:${attrs.width}px` } : {}),
      },
    }
  },
}).configure({
  resizable: true,
  allowTableNodeSelection: true,
  handleWidth: 8,
  cellMinWidth: 60,
})

function extraCellAttributes() {
  return {
    textAlign: {
      default: 'left',
      parseHTML: (el: HTMLElement) => el.style.textAlign || 'left',
      renderHTML: (attrs: Record<string, any>) =>
        attrs.textAlign && attrs.textAlign !== 'left' ? { style: `text-align:${attrs.textAlign}` } : {},
    },
    rowHeight: {
      default: null,
      parseHTML: (el: HTMLElement) => {
        const value = Number.parseInt(el.style.height || el.style.minHeight || '', 10)
        return Number.isFinite(value) && value > 0 ? value : null
      },
      renderHTML: (attrs: Record<string, any>) =>
        attrs.rowHeight ? { style: `height:${attrs.rowHeight}px;min-height:${attrs.rowHeight}px` } : {},
    },
  }
}

const JamTableCell = TableCell.extend({
  addAttributes() {
    return { ...(this.parent?.() || {}), ...extraCellAttributes() }
  },
})

const JamTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...(this.parent?.() || {}), ...extraCellAttributes() }
  },
})

/** 剪贴板 / 拖拽里的图片文件 -> 保存附件 -> 插入图片节点 */
function insertImagesFromClipboard(event: ClipboardEvent | DragEvent, tabId: string): boolean {
  const dt = (event as ClipboardEvent).clipboardData || (event as DragEvent).dataTransfer
  const images = Array.from(dt?.files || []).filter((f) => f.type.startsWith('image/'))
  if (!images.length) return false
  event.preventDefault()
  void (async () => {
    for (const file of images) {
      try {
        const dataUrl = await fileToDataUrl(file)
        const res = await saveAttachment(tabId, file.name || 'image.png', dataUrl)
        if (!res?.ok || !res.key) {
          toast(`图片保存失败：${res?.error || '未知错误'}`, 'error')
          continue
        }
        const ed = (window as any).__editor
        if (!ed) return
        ed.chain().focus().insertContent({ type: 'image', attrs: { src: res.key, alt: file.name || '图片' } }).run()
        toast('已插入图片', 'ok')
      } catch (err: any) {
        toast(`图片读取失败：${err?.message || err}`, 'error')
      }
    }
  })()
  return true
}

export function PageEditor({
  tabId,
  memoryKey,
  content,
  onChange,
  focusQuery,
  showOutline = true,
  mode = 'rich',
  md = '',
  onChangeMd,
  mdLayout = 'split',
  onMdLayout,
  contentWidth = 0,
  onContentWidth,
}: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastNonce = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollMem = useRef(0)
  const mdRef = useRef(md)
  mdRef.current = md
  const modeRef = useRef(mode)

  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const cellDragRef = useRef<{ tablePos: number; row: number; col: number } | null>(null)

  // 表格悬浮手柄：悬停单元格时在右下角出现「插行 / 插列」快捷按钮
  const [tableHandle, setTableHandle] = useState<{ top: number; left: number; pos: number } | null>(null)

  /** Shift+鼠标按下单元格：启动区域选择；移动时由 onTableMouseOver 扩展 */
  const onEditorMouseDown = (e: React.MouseEvent) => {
    if (!editor || mode !== 'rich' || !e.shiftKey || e.button !== 0) return
    const cell = (e.target as HTMLElement).closest('td, th') as HTMLElement | null
    if (!cell || !scrollRef.current?.contains(cell)) return
    let pos = -1
    try {
      pos = editor.view.posAtDOM(cell, 0)
    } catch (_) {
      return
    }
    const info = getCellInfoAtPos(editor.state.doc, pos)
    if (!info) return
    const tablePos = findTablePosAt(editor.state.doc, pos)
    if (tablePos === null) return
    e.preventDefault()
    cellDragRef.current = { tablePos, row: info.row, col: info.col }
    document.body.classList.add('jam-cell-selecting')
    setCellRange(editor, info.row, info.col, info.row, info.col)
  }

  const onTableMouseOver = (e: React.MouseEvent) => {
    if (!editor || mode !== 'rich') return
    const cell = (e.target as HTMLElement).closest('td, th') as HTMLElement | null
    if (!cell || !scrollRef.current?.contains(cell)) {
      setTableHandle(null)
      return
    }

    // Shift+拖拽：扩展单元格区域选区
    const drag = cellDragRef.current
    if (drag && (e.buttons & 1) === 1) {
      let pos = -1
      try {
        pos = editor.view.posAtDOM(cell, 0)
      } catch (_) {
        return
      }
      const info = getCellInfoAtPos(editor.state.doc, pos)
      if (info) setCellRange(editor, drag.row, drag.col, info.row, info.col)
      return
    }

    const cr = cell.getBoundingClientRect()
    const br = (bodyRef.current || scrollRef.current).getBoundingClientRect()
    const top = cr.bottom - br.top + 2
    const left = cr.right - br.left
    let pos = 0
    try {
      pos = editor.view.posAtDOM(cell, 0)
    } catch {
      setTableHandle(null)
      return
    }
    setTableHandle((prev) =>
      prev && prev.pos === pos && prev.top === top && prev.left === left ? prev : { top, left, pos }
    )
  }

  const runTableInsert = (kind: 'row' | 'col') => {
    if (!editor || !tableHandle) return
    const chain = editor.chain().focus().setTextSelection(tableHandle.pos)
    if (kind === 'row') chain.addRowAfter().run()
    else chain.addColumnAfter().run()
    setTableHandle(null)
  }

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
        dropcursor: { color: '#7c5cff', width: 2 },
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
      JamTable,
      TableRow,
      JamTableHeader,
      JamTableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: '开始记录…  支持标题、列表、表格、代码块（选中语言后自动高亮）',
      }),
      CodeBlock,
      NoteImage,
    ],
    []
  )

  const editor = useEditor(
    {
      extensions,
      content: content && content.type ? content : { type: 'doc', content: [{ type: 'paragraph' }] },
      autofocus: false,
      editorProps: {
        attributes: { class: 'prose', spellcheck: 'false' },
        transformPastedHTML: (html) => sanitizePastedHtml(html),
        // 粘贴 / 拖入图片文件：存进 attachments/ 再插入引用
        handlePaste: (_view, event) => {
          if (insertImagesFromClipboard(event, tabId)) return true
          const text = event.clipboardData?.getData('text/plain') || ''
          const ed = editorRef.current
          if (!text || !ed || !ed.isActive('table')) return false
          const res = pasteMatrixIntoTable(ed, text)
          if (!res.ok) {
            if (/\n|\t| {2,}/.test(text)) toast(res.reason || '批量填入失败', 'error')
            return false
          }
          event.preventDefault()
          const extra = res.addedRows || res.addedCols ? `，已自动扩展 ${res.addedRows} 行 / ${res.addedCols} 列` : ''
          toast(`已填入 ${res.rows} 行 × ${res.cols} 列${extra}`, 'ok')
          return true
        },
        handleKeyDown: (_view, event) => {
          const ed = editorRef.current
          if (!ed || !event.shiftKey) return false
          const arrows: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
          }
          const move = arrows[event.key]
          if (!move) return false
          const point = getGridPoint(ed)
          if (!point) return false
          // 已进入区域选择（按钮/拖拽启动），或 Ctrl/Meta+Shift+方向键从光标直接扩展
          if (!isCellSelection(ed) && !event.ctrlKey && !event.metaKey) return false
          const table = ed.state.doc.nodeAt(point.tablePos)
          if (!table) return false
          let maxRow = 0
          let maxCol = 0
          table.forEach((row: any) => {
            if (row.type.name !== 'tableRow') return
            maxRow++
            let cols = 0
            row.forEach((cell: any) => {
              if (
                cell.type.spec?.tableRole === 'cell' ||
                cell.type.spec?.tableRole === 'header' ||
                cell.type.spec?.tableRole === 'header_cell'
              ) {
                cols += Math.max(1, Number(cell.attrs?.colspan) || 1)
              }
            })
            maxCol = Math.max(maxCol, cols)
          })
          const row = Math.max(0, Math.min(maxRow - 1, point.head.row + move[0]))
          const col = Math.max(0, Math.min(maxCol - 1, point.head.col + move[1]))
          event.preventDefault()
          return setCellRange(ed, point.anchor.row, point.anchor.col, row, col)
        },
        handleDrop: (_view, event, _slice, moved) => {
          if (moved) return false
          return insertImagesFromClipboard(event, tabId)
        },
      },
      onUpdate: ({ editor: ed }) => {
        onChangeRef.current(ed.getJSON())
      },
    },
    [tabId]
  )

  // 供冒烟测试使用
  useEffect(() => {
    editorRef.current = editor
    ;(window as any).__editor = editor
    return () => {
      editorRef.current = null
      delete (window as any).__editor
    }
  }, [editor])

  // Shift+拖拽选区结束：清理全局状态
  useEffect(() => {
    const stop = () => {
      if (!cellDragRef.current) return
      cellDragRef.current = null
      document.body.classList.remove('jam-cell-selecting')
    }
    window.addEventListener('mouseup', stop)
    return () => {
      window.removeEventListener('mouseup', stop)
      document.body.classList.remove('jam-cell-selecting')
    }
  }, [])

  // Markdown -> 富文本：切回富文本时把源码解析回编辑器文档（触发 onChange 落盘）
  useEffect(() => {
    if (!editor) return
    if (modeRef.current === mode) return
    const prev = modeRef.current
    modeRef.current = mode
    if (prev === 'md' && mode === 'rich') {
      editor.commands.setContent(mdToDocHtml(mdRef.current), true)
    }
  }, [mode, editor])

  // 切换页签：恢复上次的滚动位置与光标；卸载时记下来（按页签 id 独立记忆）
  useEffect(() => {
    if (!editor) return
    const el = scrollRef.current
    const memKey = memoryKey || tabId
    const mem = pageMemory.get(memKey)
    scrollMem.current = mem?.scrollTop || 0
    if (el && mem?.scrollTop) el.scrollTop = mem.scrollTop
    if (mem?.selection) {
      const max = Math.max(1, editor.state.doc.content.size - 1)
      const pos = Math.min(mem.selection, max)
      editor.commands.setTextSelection(pos)
    }
    const onScroll = () => {
      if (scrollRef.current) scrollMem.current = scrollRef.current.scrollTop
    }
    el?.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el?.removeEventListener('scroll', onScroll)
      pageMemory.set(memKey, { scrollTop: scrollMem.current, selection: editor.state.selection.anchor })
    }
  }, [editor, tabId, memoryKey])

  // 搜索跳转：定位到命中文本并滚动
  useEffect(() => {
    if (!editor || !focusQuery || focusQuery.nonce === lastNonce.current) return
    lastNonce.current = focusQuery.nonce
    const needle = focusQuery.query.trim().toLowerCase()
    if (!needle) return
    let target: { from: number; to: number } | null = null
    editor.state.doc.descendants((node, pos) => {
      if (target) return false
      if (node.isText && node.text) {
        const idx = node.text.toLowerCase().indexOf(needle)
        if (idx >= 0) {
          target = { from: pos + idx, to: pos + idx + needle.length }
          return false
        }
      }
      return true
    })
    const timer = setTimeout(() => {
      if (target) {
        editor.chain().focus().setTextSelection(target).scrollIntoView().run()
      }
    }, 60)
    return () => clearTimeout(timer)
  }, [editor, focusQuery])

  return (
    <div className="editor-wrap">
      {mode === 'rich' && (
        <Toolbar
          editor={editor}
          contentWidth={contentWidth}
          onContentWidth={(w) => onContentWidth?.(w)}
        />
      )}
      <div
        className="editor-body"
        ref={bodyRef}
        style={mode === 'md' ? { display: 'none' } : undefined}
        onMouseLeave={() => setTableHandle(null)}
      >
        <div
          className="editor-scroll"
          ref={scrollRef}
          onMouseDown={onEditorMouseDown}
          onMouseOver={onTableMouseOver}
          onScroll={() => setTableHandle((h) => (h ? null : h))}
        >
          <div className="editor-canvas" style={{ width: contentWidth ? `${contentWidth}px` : '100%' }}>
            <EditorContent editor={editor} />
          </div>
        </div>
        {showOutline && <Outline editor={editor} />}
        {tableHandle && mode === 'rich' && (
          <div className="table-hover-bar" style={{ top: tableHandle.top, left: tableHandle.left }}>
            <button
              type="button"
              title="在此行下方插入行"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runTableInsert('row')}
            >
              <Rows3 size={13} /> 插行
            </button>
            <button
              type="button"
              title="在此列右侧插入列"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => runTableInsert('col')}
            >
              <Columns3 size={13} /> 插列
            </button>
          </div>
        )}
      </div>
      {mode === 'md' && (
        <MarkdownPane
          tabId={tabId}
          value={md}
          layout={mdLayout}
          onLayout={(next) => onMdLayout?.(next)}
          onChange={(value) => onChangeMd?.(value)}
          showOutline={showOutline}
          focusQuery={focusQuery}
        />
      )}
    </div>
  )
}
