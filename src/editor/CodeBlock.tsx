import { useCallback, useEffect, useRef, useState } from 'react'
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { NodeSelection } from '@tiptap/pm/state'
import { Check, ChevronRight, Copy, ListOrdered, MousePointer2 } from 'lucide-react'
import { LANGUAGES, lowlight, normalizeLang } from '../lib/language'
import { copyText } from '../lib/utils'
import { toast } from '../lib/toast'
import { codeBlockPlugin, indentSelection, smartEnter } from './codePlugins'

function CodeBlockView({ node, updateAttributes, editor, selected, getPos }: NodeViewProps) {
  const lang = normalizeLang(node.attrs?.language)
  const code = node.textContent || ''
  const lineCount = Math.max(1, code.split('\n').length)
  const collapsed = node.attrs?.collapsed === true
  const showNumbers = node.attrs?.lineNumbers !== false
  const [copied, setCopied] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({
    width: Number(node.attrs?.width) || 0,
    height: Number(node.attrs?.height) || 0,
  })
  const sizeRef = useRef(size)
  sizeRef.current = size

  useEffect(() => {
    setSize({
      width: Number(node.attrs?.width) || 0,
      height: Number(node.attrs?.height) || 0,
    })
  }, [node.attrs?.width, node.attrs?.height])

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))

  const onResizeDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const startY = event.clientY
      const startW = sizeRef.current.width || wrapRef.current?.offsetWidth || 600
      const startH = sizeRef.current.height || bodyRef.current?.offsetHeight || 180

      const onMove = (ev: PointerEvent) => {
        const next = {
          width: clamp(startW + ev.clientX - startX, 320, 3200),
          height: clamp(startH + ev.clientY - startY, 96, 1200),
        }
        // 连续 pointermove 不等待 React 重渲染，直接同步引用，pointerup 才能拿到最终尺寸
        sizeRef.current = next
        setSize(next)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        const next = sizeRef.current
        updateAttributes({ width: next.width || null, height: next.height || null })
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [updateAttributes]
  )

  const resetSize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      setSize({ width: 0, height: 0 })
      updateAttributes({ width: null, height: null })
    },
    [updateAttributes]
  )

  const selectBlock = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const pos = getPos()
      if (typeof pos !== 'number') return
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
      editor.view.focus()
    },
    [editor, getPos]
  )

  const onCopy = useCallback(async () => {
    const ok = await copyText(code)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      toast('复制失败，请手动选中', 'error')
    }
  }, [code])

  const numbers = []
  if (showNumbers) {
    for (let i = 1; i <= lineCount; i++) numbers.push(i)
  }

  return (
    <NodeViewWrapper
      ref={wrapRef}
      className={`cb${selected ? ' is-node-selected' : ''}`}
      data-language={lang}
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ width: size.width ? `${size.width}px` : undefined }}
    >
      <div className="cb-head" contentEditable={false}>
        <button
          type="button"
          className={`cb-icon${collapsed ? ' is-collapsed' : ''}`}
          title={collapsed ? '展开代码' : '折叠代码'}
          aria-label={collapsed ? '展开代码' : '折叠代码'}
          onClick={() => updateAttributes({ collapsed: !collapsed })}
        >
          <ChevronRight size={13} />
        </button>
        <select
          className="cb-lang"
          value={lang}
          title="选择语言"
          onChange={(e) => updateAttributes({ language: e.target.value })}
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
          {!LANGUAGES.some((l) => l.id === lang) && <option value={lang}>{lang}</option>}
        </select>
        <span className="cb-count">
          {lineCount} 行{collapsed ? ' · 已折叠' : ''}
        </span>
        <div className="cb-actions">
          <button type="button" className="cb-btn" onClick={selectBlock} title="选中整个代码块 (Ctrl+Shift+C)">
            <MousePointer2 size={13} />
            <span>选中</span>
          </button>
          <button
            type="button"
            className={`cb-btn${showNumbers ? '' : ' is-off'}`}
            onClick={() => updateAttributes({ lineNumbers: !showNumbers })}
            title={showNumbers ? '隐藏行号' : '显示行号'}
          >
            <ListOrdered size={13} />
            <span>行号</span>
          </button>
          <button type="button" className="cb-btn" onClick={onCopy} title={editor.isEditable ? '复制全部代码' : '复制'}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            <span>{copied ? '已复制' : '复制'}</span>
          </button>
        </div>
      </div>
      <div className="cb-body" ref={bodyRef} style={{ height: size.height ? `${size.height}px` : undefined }}>
        {showNumbers && (
          <div className="cb-gutter" contentEditable={false} aria-hidden="true">
            {numbers.map((n) => (
              <div key={n} className="cb-ln">
                {n}
              </div>
            ))}
          </div>
        )}
        <pre className="cb-pre hljs-striped">
          <NodeViewContent as="code" className={`hljs language-${lang}`} />
        </pre>
      </div>
      <div
        className="cb-resize-handle"
        contentEditable={false}
        title="拖拽缩放代码块；双击恢复自适应"
        onPointerDown={onResizeDown}
        onDoubleClick={resetSize}
      />
    </NodeViewWrapper>
  )
}

export const CodeBlock = CodeBlockLowlight.extend({
  addAttributes() {
    const parent = (this.parent && this.parent()) || {}
    return {
      ...parent,
      // 折叠状态：随页面一起落盘，重开仍是收起的
      collapsed: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs: Record<string, any>) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
      },
      // 行号开关：默认显示，可单块关闭
      lineNumbers: {
        default: true,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-line-numbers') !== 'false',
        renderHTML: (attrs: Record<string, any>) =>
          attrs.lineNumbers === false ? { 'data-line-numbers': 'false' } : {},
      },
      // 手动缩放：null = 自适应；数字为 px（保存在页签正文里，重开保持）
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const value = Number.parseInt(el.style.width || '', 10)
          return Number.isFinite(value) && value > 0 ? value : null
        },
        renderHTML: (attrs: Record<string, any>) =>
          attrs.width ? { style: `width:${attrs.width}px` } : {},
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const value = Number.parseInt(el.style.height || '', 10)
          return Number.isFinite(value) && value > 0 ? value : null
        },
        renderHTML: (attrs: Record<string, any>) =>
          attrs.height ? { style: `height:${attrs.height}px` } : {},
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockView)
  },

  addKeyboardShortcuts() {
    const parent = (this.parent && this.parent()) || {}
    return {
      ...parent,
      Tab: () => indentSelection(this.editor, false),
      'Shift-Tab': () => indentSelection(this.editor, true),
      Enter: () => smartEnter(this.editor),
      'Mod-Shift-c': () => {
        const { state, view } = this.editor
        const { $from } = state.selection
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'codeBlock') {
            view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, $from.before(d))))
            return true
          }
        }
        return false
      },
    }
  },

  addProseMirrorPlugins() {
    const parent = (this.parent && this.parent()) || []
    return [...parent, codeBlockPlugin()]
  },
}).configure({
  lowlight,
  defaultLanguage: null,
  languageClassPrefix: 'language-',
})
