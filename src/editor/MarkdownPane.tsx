import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Columns2, Eye, FileCode2 } from 'lucide-react'
import { extractMdHeadings, mdToPreviewHtml } from '../lib/markdown'
import { readAttachment, saveAttachment } from '../lib/attachments'
import { toast } from '../lib/toast'

export type MdLayout = 'split' | 'source' | 'preview'

interface Props {
  /** 正文载体 id：第 4 层页签 id */
  tabId: string
  value: string
  layout: MdLayout
  onLayout: (layout: MdLayout) => void
  onChange: (value: string) => void
  showOutline?: boolean
  focusQuery?: { query: string; nonce: number } | null
}

const LINE_HEIGHT = 22

const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/** Markdown 源码 + 实时预览双栏 */
export function MarkdownPane({ tabId, value, layout, onLayout, onChange, showOutline = true, focusQuery }: Props) {
  const [text, setText] = useState(value)
  const [html, setHtml] = useState(() => mdToPreviewHtml(value))
  const [caretLine, setCaretLine] = useState(0)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const lastNonce = useRef(0)

  // 输入停顿后再渲染，避免每个字符都跑一遍高亮
  useEffect(() => {
    const timer = setTimeout(() => setHtml(mdToPreviewHtml(text)), 110)
    return () => clearTimeout(timer)
  }, [text])

  // 预览里的本地图片引用（att:）异步换成 dataURL
  useEffect(() => {
    const root = previewRef.current
    if (!root || !html.includes('att:')) return
    let alive = true
    root.querySelectorAll('img').forEach((img) => {
      const key = img.getAttribute('src') || ''
      if (!key.startsWith('att:')) return
      void readAttachment(key).then((dataUrl) => {
        if (!alive) return
        if (dataUrl) img.setAttribute('src', dataUrl)
        else img.replaceWith(document.createTextNode('［图片丢失］'))
      })
    })
    return () => {
      alive = false
    }
  }, [html])

  const lines = useMemo(() => {
    const arr = text.split('\n')
    return { count: arr.length, numbers: arr.map((_, i) => i + 1) }
  }, [text])

  const headings = useMemo(() => extractMdHeadings(text), [text])
  const activeHeading = useMemo(() => {
    let idx = -1
    headings.forEach((h, i) => {
      if (h.line <= caretLine) idx = i
    })
    return idx
  }, [headings, caretLine])

  const stats = useMemo(() => {
    const chars = text.replace(/\s/g, '').length
    const words = (text.match(/[A-Za-z0-9_$#@.-]+/g) || []).length
    return { chars, words }
  }, [text])

  /** 统一的「写回 + 定位光标」入口 */
  const apply = useCallback((next: string, selStart: number, selEnd = selStart) => {
    setText(next)
    onChangeRef.current(next)
    requestAnimationFrame(() => {
      const ta = taRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(selStart, selEnd)
      const line = next.slice(0, selStart).split('\n').length - 1
      setCaretLine(line)
    })
  }, [])

  const syncScroll = (el: HTMLTextAreaElement) => {
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-el.scrollTop}px)`
    const preview = previewRef.current
    if (layout !== 'split' || !preview) return
    const max = el.scrollHeight - el.clientHeight
    const ratio = max > 0 ? el.scrollTop / max : 0
    const pMax = preview.scrollHeight - preview.clientHeight
    if (pMax > 0) preview.scrollTop = ratio * pMax
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    const start = ta.selectionStart
    const end = ta.selectionEnd

    // Tab / Shift+Tab：缩进两级空格
    if (e.key === 'Tab') {
      e.preventDefault()
      if (start !== end) {
        const from = text.lastIndexOf('\n', start - 1) + 1
        const chunk = text.slice(from, end)
        const next = chunk
          .split('\n')
          .map((line) => (e.shiftKey ? line.replace(/^ {1,2}/, '') : '  ' + line))
          .join('\n')
        apply(text.slice(0, from) + next + text.slice(end), from, from + next.length)
      } else {
        apply(text.slice(0, start) + '  ' + text.slice(end), start + 2)
      }
      return
    }

    // 回车自动续列表；空条目回车结束列表
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && start === end) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1
      const line = text.slice(lineStart, start)
      const hit = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/.exec(line)
      if (hit) {
        e.preventDefault()
        if (!hit[4].trim()) {
          apply(text.slice(0, lineStart) + text.slice(start), lineStart)
          return
        }
        const ordered = /^\d/.test(hit[2])
        const marker = ordered ? `${parseInt(hit[2], 10) + 1}${hit[2].slice(-1)} ` : `${hit[2]} `
        const insert = '\n' + hit[1] + marker
        apply(text.slice(0, start) + insert + text.slice(end), start + insert.length)
        return
      }
    }

    // Ctrl+B / Ctrl+I / Ctrl+E：加粗、斜体、行内代码
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase()
      const wrap = key === 'b' ? '**' : key === 'i' ? '*' : key === 'e' ? '`' : ''
      if (wrap) {
        e.preventDefault()
        const selected = text.slice(start, end) || '文本'
        const next = text.slice(0, start) + wrap + selected + wrap + text.slice(end)
        apply(next, start + wrap.length, start + wrap.length + selected.length)
      }
    }
  }

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    const ta = e.currentTarget
    const at = ta.selectionStart
    void (async () => {
      let insert = ''
      for (const file of files) {
        try {
          const dataUrl = await fileToDataUrl(file)
          const res = await saveAttachment(tabId, file.name || 'image.png', dataUrl)
          if (!res.ok || !res.key) {
            toast(`图片保存失败：${res.error || '未知错误'}`, 'error')
            continue
          }
          insert += `![${file.name || '图片'}](${res.key})\n`
        } catch (err: any) {
          toast(`图片读取失败：${err?.message || err}`, 'error')
        }
      }
      if (!insert) return
      const pos = ta.selectionStart
      const next = text.slice(0, pos) + insert + text.slice(ta.selectionEnd)
      apply(next, pos + insert.length)
      toast('已插入图片', 'ok')
    })()
  }

  const jumpToHeading = (line: number, index: number) => {
    const ta = taRef.current
    if (!ta) return
    let pos = 0
    for (let i = 0; i < line; i++) pos = text.indexOf('\n', pos) + 1
    ta.focus()
    ta.setSelectionRange(pos, pos)
    ta.scrollTop = Math.max(0, line * LINE_HEIGHT - 80)
    setCaretLine(line)
    const heads = previewRef.current?.querySelectorAll('h1, h2, h3')
    heads?.[index]?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  // 搜索命中：把光标落到命中处并同步滚动
  useEffect(() => {
    if (!focusQuery || focusQuery.nonce === lastNonce.current) return
    const needle = focusQuery.query.trim()
    if (!needle) return
    lastNonce.current = focusQuery.nonce
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at < 0) return
    const line = text.slice(0, at).split('\n').length - 1
    const ta = taRef.current
    if (!ta) return
    ta.focus()
    ta.setSelectionRange(at, at + needle.length)
    ta.scrollTop = Math.max(0, line * LINE_HEIGHT - 80)
    setCaretLine(line)
  }, [focusQuery, text])

  return (
    <div className="md-wrap">
      <div className="md-bar">
        <span className="md-bar-title">MARKDOWN</span>
        <div className="md-seg" role="group" aria-label="Markdown 视图">
          <button
            type="button"
            className={layout === 'split' ? 'is-on' : ''}
            title="源码 + 预览"
            onClick={() => onLayout('split')}
          >
            <Columns2 size={13} />
            双栏
          </button>
          <button
            type="button"
            className={layout === 'source' ? 'is-on' : ''}
            title="只看源码"
            onClick={() => onLayout('source')}
          >
            <FileCode2 size={13} />
            源码
          </button>
          <button
            type="button"
            className={layout === 'preview' ? 'is-on' : ''}
            title="只看预览"
            onClick={() => onLayout('preview')}
          >
            <Eye size={13} />
            预览
          </button>
        </div>
        <div className="md-stat">
          <span>{lines.count} 行</span>
          <span>{stats.chars} 字</span>
          <span>{headings.length} 个标题</span>
        </div>
      </div>

      <div className="md-body">
        <div className={`md-split is-${layout}`}>
          <div className="md-source">
            <div className="md-gutter" aria-hidden="true">
              <div className="md-gutter-inner" ref={gutterRef}>
                {lines.numbers.map((n) => (
                  <div key={n} className={n - 1 === caretLine ? 'is-here' : undefined}>
                    {n}
                  </div>
                ))}
              </div>
            </div>
            <textarea
              ref={taRef}
              className="md-textarea"
              value={text}
              spellCheck={false}
              placeholder={'用 Markdown 记录…\n\n# 标题\n- 列表 / 任务\n```js 代码块```\n图片可直接粘贴'}
              onChange={(e) => {
                setText(e.target.value)
                onChangeRef.current(e.target.value)
              }}
              onScroll={(e) => syncScroll(e.currentTarget)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onSelect={(e) => {
                const el = e.currentTarget
                setCaretLine(text.slice(0, el.selectionStart).split('\n').length - 1)
              }}
              onBlur={() => onChangeRef.current(text)}
            />
          </div>

          <div
            className="md-preview"
            ref={previewRef}
            onScroll={(e) => {
              if (layout !== 'split') return
              const preview = e.currentTarget
              const ta = taRef.current
              if (!ta) return
              const max = preview.scrollHeight - preview.clientHeight
              const ratio = max > 0 ? preview.scrollTop / max : 0
              const tMax = ta.scrollHeight - ta.clientHeight
              if (tMax > 0) ta.scrollTop = ratio * tMax
            }}
          >
            {html.trim() ? (
              <div className="ProseMirror md-prose" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <div className="md-empty">左边写 Markdown，这里会实时渲染。</div>
            )}
          </div>
        </div>

        {showOutline && (
          <aside className="outline md-outline">
            <div className="outline-head">
              <span className="col-title">大纲</span>
              <span className="outline-count">{headings.length}</span>
            </div>
            <div className="outline-list">
              {headings.length === 0 && <div className="outline-empty">用 # 标题分段后，这里会自动生成目录</div>}
              {headings.map((h, i) => (
                <button
                  key={`${h.line}-${i}`}
                  type="button"
                  className={`outline-item lv${h.level}${i === activeHeading ? ' is-active' : ''}`}
                  title={`第 ${h.line + 1} 行`}
                  onClick={() => jumpToHeading(h.line, i)}
                >
                  {h.text}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}
