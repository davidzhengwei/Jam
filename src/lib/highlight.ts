import { createElement } from 'react'
import type { ReactNode } from 'react'
import { lowlight, normalizeLang, isRegistered } from './language'

export interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, any>
  children?: HastNode[]
}

/** 代码 -> hast 语法树；语言无效时回退为纯文本 */
export function codeToHast(code: string, lang?: string): HastNode {
  const id = normalizeLang(lang)
  if (id && isRegistered(id)) {
    try {
      return lowlight.highlight(id, code) as unknown as HastNode
    } catch (_) {
      /* 语法解析失败时按纯文本渲染 */
    }
  }
  return { type: 'root', children: [{ type: 'text', value: code }] }
}

/** 把 hast 拆成「按行」的节点数组，供行号渲染使用（不破坏 span 结构） */
export function hastToLines(root: HastNode): HastNode[][] {
  const lines: HastNode[][] = [[]]
  appendInto(root, lines)
  return lines
}

function appendInto(node: HastNode | undefined, lines: HastNode[][]) {
  if (!node) return
  if (node.type === 'text') {
    const parts = String(node.value ?? '').split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([])
      if (parts[i]) lines[lines.length - 1].push({ type: 'text', value: parts[i] })
    }
    return
  }
  if (node.type === 'element') {
    const childLines: HastNode[][] = [[]]
    for (const child of node.children || []) appendInto(child, childLines)
    for (let i = 0; i < childLines.length; i++) {
      if (i > 0) lines.push([])
      const cl = childLines[i]
      if (cl.length) {
        lines[lines.length - 1].push({
          type: 'element',
          tagName: node.tagName,
          properties: node.properties,
          children: cl,
        })
      }
    }
  }
}

function classNameOf(node: HastNode): string | undefined {
  const cls = node.properties?.className
  if (!cls) return undefined
  return Array.isArray(cls) ? cls.join(' ') : String(cls)
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function hastToHtml(node: HastNode): string {
  if (!node) return ''
  if (node.type === 'text') return escapeHtml(String(node.value ?? ''))
  if (node.type === 'element') {
    const cls = classNameOf(node)
    const inner = (node.children || []).map(hastToHtml).join('')
    const tag = node.tagName || 'span'
    return `<${tag}${cls ? ` class="${cls}"` : ''}>${inner}</${tag}>`
  }
  return (node.children || []).map(hastToHtml).join('')
}

/** hast 节点 -> React 元素（供自定义渲染使用） */
export function hastToReact(node: HastNode, key: string | number): ReactNode {
  if (node.type === 'text') return node.value
  if (node.type === 'element') {
    return createElement(
      node.tagName || 'span',
      { key, className: classNameOf(node) },
      (node.children || []).map((c, i) => hastToReact(c, `${key}-${i}`))
    )
  }
  return null
}

export function codeToHtml(code: string, lang?: string): string {
  return hastToHtml(codeToHast(code, lang))
}
