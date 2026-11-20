import { Plugin } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { detectLanguage } from '../lib/language'

function codeParent(editor: Editor) {
  const { $from, $to } = editor.state.selection
  if ($from.parent.type.name !== 'codeBlock' || $from.parent !== $to.parent) return null
  return $from
}

/** Tab / Shift+Tab：单光标对齐到 4 空格制表位；多行选中整体缩进/反缩进 */
export function indentSelection(editor: Editor, outdent: boolean): boolean {
  const $from = codeParent(editor)
  if (!$from) return false
  const { state, view } = editor
  const { from, to } = state.selection
  const blockStart = $from.start()
  const text = $from.parent.textContent
  const relFrom = from - blockStart
  const relTo = to - blockStart

  if (from === to) {
    const lineStart = text.lastIndexOf('\n', relFrom - 1) + 1
    const col = relFrom - lineStart
    if (!outdent) {
      const add = 4 - (col % 4)
      view.dispatch(state.tr.insertText(' '.repeat(add), from, to))
      return true
    }
    const before = text.slice(lineStart, relFrom)
    const spaces = before.length - before.replace(/ +$/, '').length
    const want = col === 0 ? 0 : ((col - 1) % 4) + 1
    const remove = Math.min(spaces, want)
    if (remove > 0) view.dispatch(state.tr.delete(from - remove, from))
    return true
  }

  const firstLineStart = text.lastIndexOf('\n', relFrom - 1) + 1
  const lineStarts: number[] = []
  let cursor = firstLineStart
  while (cursor <= relTo) {
    lineStarts.push(cursor)
    const next = text.indexOf('\n', cursor)
    if (next < 0) break
    cursor = next + 1
  }

  const tr = state.tr
  if (!outdent) {
    for (let i = lineStarts.length - 1; i >= 0; i--) tr.insertText('    ', blockStart + lineStarts[i])
  } else {
    for (let i = lineStarts.length - 1; i >= 0; i--) {
      const ls = lineStarts[i]
      let n = 0
      while (n < 4 && text[ls + n] === ' ') n++
      if (n > 0) tr.delete(blockStart + ls, blockStart + ls + n)
    }
  }
  view.dispatch(tr)
  return true
}

/** 回车：继承缩进；行尾是 { ( [ : 时多缩进一级 */
export function smartEnter(editor: Editor): boolean {
  const { state, view } = editor
  const { $from, empty } = state.selection
  if ($from.parent.type.name !== 'codeBlock' || !empty) return false
  const text = $from.parent.textContent
  const offset = $from.parentOffset
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  const line = text.slice(lineStart, offset)
  const indentMatch = /^[ \t]*/.exec(line)
  const indent = indentMatch ? indentMatch[0] : ''
  const trimmed = line.replace(/[ \t]+$/, '')
  const extra = /[{([]$/.test(trimmed) || /:$/.test(trimmed) ? '    ' : ''
  view.dispatch(state.tr.insertText('\n' + indent + extra, $from.pos).scrollIntoView())
  return true
}

/** 代码块附加行为：粘贴自动识别语言、输入 } 自动回退一级 */
export function codeBlockPlugin() {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const { state } = view
        const { $from } = state.selection
        if ($from.parent.type.name !== 'codeBlock') return false
        const clipboard = event.clipboardData
        const text = clipboard?.getData('text/plain') || ''
        if (!text.trim()) return false
        // 仅在空代码块时自动识别，不覆盖用户已选语言
        if ($from.parent.content.size === 0) {
          const lang = detectLanguage(text)
          if (lang && lang !== 'plaintext' && lang !== $from.parent.attrs.language) {
            view.dispatch(
              state.tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, language: lang })
            )
          }
        }
        // 返回 false 让默认粘贴继续，保证空格与换行 1:1 保留
        return false
      },
      handleTextInput(view, from, to, text) {
        if (text !== '}') return false
        const { state } = view
        const $from = state.doc.resolve(from)
        if ($from.parent.type.name !== 'codeBlock') return false
        const parentText = $from.parent.textContent
        const offset = $from.parentOffset
        const lineStart = parentText.lastIndexOf('\n', offset - 1) + 1
        const line = parentText.slice(lineStart, offset)
        if (!/^ +$/.test(line)) return false
        const want = line.length === 0 ? 0 : ((line.length - 1) % 4) + 1
        const remove = Math.min(line.length, want)
        if (remove <= 0) return false
        const tr = state.tr.delete(from - remove, to)
        tr.insertText('}', from - remove, from - remove)
        view.dispatch(tr.scrollIntoView())
        return true
      },
    },
  })
}
