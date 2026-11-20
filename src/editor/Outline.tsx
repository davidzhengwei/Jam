import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { AlignLeft } from 'lucide-react'

export interface OutlineItem {
  level: number
  text: string
  pos: number
}

interface Props {
  editor: Editor | null
  /** 点击大纲后把光标定位到标题，并滚动编辑区 */
  onJump?: () => void
}

/** 从当前文档抽取 H1-H3 作为页面大纲，滚动时高亮当前章节 */
export function Outline({ editor, onJump }: Props) {
  const [items, setItems] = useState<OutlineItem[]>([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editor) return
    const collect = () => {
      const next: OutlineItem[] = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          next.push({ level: Number(node.attrs.level) || 1, text: node.textContent || '（无标题）', pos })
        }
        return true
      })
      setItems(next)
    }
    collect()
    editor.on('update', collect)
    return () => {
      editor.off('update', collect)
    }
  }, [editor])

  // 跟随滚动高亮当前标题
  useEffect(() => {
    if (!editor) return
    const scroller = editor.view.dom.closest('.editor-scroll') as HTMLElement | null
    if (!scroller) return
    const sync = () => {
      const heads = Array.from(editor.view.dom.querySelectorAll('h1, h2, h3')) as HTMLElement[]
      const base = scroller.getBoundingClientRect().top + 72
      let idx = -1
      heads.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= base) idx = i
      })
      setActiveIdx(idx)
    }
    sync()
    scroller.addEventListener('scroll', sync, { passive: true })
    return () => scroller.removeEventListener('scroll', sync)
  }, [editor, items.length])

  // 让高亮项始终在大纲可视区内
  useEffect(() => {
    const box = listRef.current
    if (!box || activeIdx < 0) return
    const el = box.children[activeIdx] as HTMLElement | undefined
    if (!el) return
    const top = el.offsetTop
    if (top < box.scrollTop || top + el.offsetHeight > box.scrollTop + box.clientHeight) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 2)
    }
  }, [activeIdx])

  const jump = (item: OutlineItem) => {
    if (!editor) return
    const scroller = editor.view.dom.closest('.editor-scroll') as HTMLElement | null
    const dom = editor.view.nodeDOM(item.pos) as HTMLElement | null
    if (scroller && dom) {
      const delta = dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTo({ top: Math.max(0, scroller.scrollTop + delta - 24), behavior: 'smooth' })
    }
    editor.chain().focus().setTextSelection(item.pos + 1).run()
    onJump?.()
  }

  return (
    <aside className="outline">
      <div className="outline-head">
        <span className="col-title">大纲</span>
        <span className="outline-count">{items.length}</span>
      </div>
      <div className="outline-list" ref={listRef}>
        {items.length === 0 && (
          <div className="outline-empty">
            <AlignLeft size={16} />
            <span>用标题（H1-H3）分段后，这里会自动生成目录</span>
          </div>
        )}
        {items.map((item, i) => (
          <button
            key={`${item.pos}-${i}`}
            type="button"
            className={`outline-item lv${item.level}${i === activeIdx ? ' is-active' : ''}`}
            title={item.text}
            onClick={() => jump(item)}
          >
            {item.text}
          </button>
        ))}
      </div>
    </aside>
  )
}
