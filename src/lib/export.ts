/** 可导出的正文单元：第 4 层页签（title/content/md/mode）。页面/分区/笔记本无正文，不可导出。 */
export interface ExportDoc {
  title: string
  content: { type: 'doc'; content: any[] }
  md: string
  mode: 'rich' | 'md'
}

import { codeToHtml } from './highlight'
import { normalizeLang } from './language'
import { readAttachment } from './attachments'

/** 导出前把 att: 图片引用解析成 dataURL（失败则留空，导出里标注图片丢失） */
export async function resolveAttachmentSrc(content: any): Promise<any> {
  const walk = async (node: any): Promise<any> => {
    if (!node || typeof node !== 'object') return node
    const next = { ...node }
    if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src.startsWith('att:')) {
      const dataUrl = await readAttachment(node.attrs.src)
      next.attrs = { ...node.attrs, src: dataUrl || '' }
    }
    if (Array.isArray(next.content)) next.content = await Promise.all(next.content.map(walk))
    return next
  }
  if (!content || typeof content !== 'object') return content
  return walk(content)
}

// ---------------- Markdown ----------------
function inlineMd(nodes: any[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '  \n'
      if (node.type !== 'text') return ''
      let s = String(node.text ?? '')
      const marks: any[] = node.marks || []
      const has = (t: string) => marks.some((m) => m.type === t)
      const link = marks.find((m) => m.type === 'link')
      if (has('code')) {
        s = '`' + s + '`'
      } else {
        if (has('bold')) s = `**${s}**`
        if (has('italic')) s = `*${s}*`
        if (has('strike')) s = `~~${s}~~`
        if (has('underline')) s = `<u>${s}</u>`
      }
      if (link?.attrs?.href) s = `[${s}](${link.attrs.href})`
      return s
    })
    .join('')
}

function indentBlock(text: string, prefix: string) {
  const pad = ' '.repeat(prefix.length)
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? prefix + line : line ? pad + line : ''))
    .join('\n')
}

function listMd(node: any): string {
  const ordered = node.type === 'orderedList'
  const start = Number(node.attrs?.start || 1)
  let index = 0
  return (node.content || [])
    .map((li: any) => {
      const isTask = li.type === 'taskItem'
      let prefix = '- '
      if (ordered) prefix = `${start + index}. `
      index += 1
      if (isTask) prefix = li.attrs?.checked ? '- [x] ' : '- [ ] '
      const inner = (li.content || []).map(blockMd).filter(Boolean).join('\n\n')
      return indentBlock(inner, prefix)
    })
    .join('\n')
}

function tableMd(node: any): string {
  const rows = (node.content || []).filter((r: any) => r.type === 'tableRow')
  if (!rows.length) return ''
  const cellsOf = (row: any) =>
    (row.content || []).map((cell: any) => inlineMd(cell.content?.[0]?.content || cell.content || []).replace(/\|/g, '\\|'))
  const head = cellsOf(rows[0])
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`]
  rows.slice(1).forEach((r: any) => lines.push(`| ${cellsOf(r).join(' | ')} |`))
  return lines.join('\n')
}

function blockMd(node: any): string {
  if (!node) return ''
  switch (node.type) {
    case 'paragraph':
      return inlineMd(node.content)
    case 'heading': {
      const level = Number(node.attrs?.level || 1)
      return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${inlineMd(node.content)}`
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listMd(node)
    case 'blockquote':
      return (node.content || [])
        .map(blockMd)
        .join('\n\n')
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'codeBlock': {
      const lang = normalizeLang(node.attrs?.language)
      const code = (node.content || []).map((c: any) => c.text || '').join('')
      return '```' + (lang === 'plaintext' ? '' : lang) + '\n' + code.replace(/\n$/, '') + '\n```'
    }
    case 'horizontalRule':
      return '---'
    case 'image': {
      const alt = node.attrs?.alt || '图片'
      const src = node.attrs?.src || ''
      if (!src) return `[图片丢失：${alt}]`
      return `![${alt}](${src})`
    }
    case 'table':
      return tableMd(node)
    case 'listItem':
    case 'taskItem':
      return (node.content || []).map(blockMd).join('\n\n')
    default:
      if (Array.isArray(node.content)) return node.content.map(blockMd).filter(Boolean).join('\n\n')
      return ''
  }
}

/** 页面正文（不含标题）的 Markdown —— 切到 Markdown 模式时用它初始化源码 */
export function pageBodyToMarkdown(page: ExportDoc): string {
  return page.content.content
    .map(blockMd)
    .filter((s) => s !== '')
    .join('\n\n')
}

export function pageToMarkdown(page: ExportDoc): string {
  const body = pageBodyToMarkdown(page)
  const header = `# ${page.title || '未命名页面'}\n\n`
  return header + body + '\n'
}

// ---------------- HTML ----------------
function esc(s: string) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function inlineHtml(nodes: any[] = []): string {
  return nodes
    .map((node) => {
      if (node.type === 'hardBreak') return '<br />'
      if (node.type !== 'text') return ''
      let s = esc(node.text ?? '')
      const marks: any[] = node.marks || []
      const has = (t: string) => marks.some((m) => m.type === t)
      if (has('code')) s = `<code>${s}</code>`
      if (has('bold')) s = `<strong>${s}</strong>`
      if (has('italic')) s = `<em>${s}</em>`
      if (has('strike')) s = `<s>${s}</s>`
      if (has('underline')) s = `<u>${s}</u>`
      const link = marks.find((m) => m.type === 'link')
      if (link?.attrs?.href) s = `<a href="${esc(link.attrs.href)}">${s}</a>`
      return s
    })
    .join('')
}

function blockHtml(node: any): string {
  if (!node) return ''
  switch (node.type) {
    case 'paragraph':
      return `<p>${inlineHtml(node.content)}</p>`
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level || 1)))
      return `<h${level}>${inlineHtml(node.content)}</h${level}>`
    }
    case 'bulletList':
      return `<ul>${(node.content || []).map(blockHtml).join('')}</ul>`
    case 'orderedList':
      return `<ol${node.attrs?.start && Number(node.attrs.start) !== 1 ? ` start="${node.attrs.start}"` : ''}>${(
        node.content || []
      )
        .map(blockHtml)
        .join('')}</ol>`
    case 'taskList':
      return `<ul class="task-list">${(node.content || []).map(blockHtml).join('')}</ul>`
    case 'listItem':
      return `<li>${(node.content || []).map(blockHtml).join('')}</li>`
    case 'taskItem':
      return `<li class="task-item"><input type="checkbox" disabled ${
        node.attrs?.checked ? 'checked' : ''
      } /> ${(node.content || []).map(blockHtml).join('')}</li>`
    case 'blockquote':
      return `<blockquote>${(node.content || []).map(blockHtml).join('')}</blockquote>`
    case 'codeBlock': {
      const lang = normalizeLang(node.attrs?.language)
      const code = (node.content || []).map((c: any) => c.text || '').join('')
      return `<pre class="hljs"><code class="language-${esc(lang)}">${codeToHtml(code, lang)}</code></pre>`
    }
    case 'horizontalRule':
      return '<hr />'
    case 'image': {
      const src = node.attrs?.src || ''
      const alt = node.attrs?.alt || ''
      if (!src) return `<p>[图片丢失：${esc(alt)}]</p>`
      return `<img src="${esc(src)}" alt="${esc(alt)}" style="max-width:100%" />`
    }
    case 'table':
      return `<table>${(node.content || []).map(blockHtml).join('')}</table>`
    case 'tableRow':
      return `<tr>${(node.content || []).map(blockHtml).join('')}</tr>`
    case 'tableHeader':
      return `<th>${(node.content || []).map(blockHtml).join('')}</th>`
    case 'tableCell':
      return `<td>${(node.content || []).map(blockHtml).join('')}</td>`
    default:
      if (Array.isArray(node.content)) return node.content.map(blockHtml).filter(Boolean).join('')
      return ''
  }
}

const HLJS_CSS = `
.hljs{color:#24292e;background:#f6f8fa}
.hljs-comment,.hljs-quote{color:#6a737d;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#d73a49}
.hljs-string,.hljs-doctag,.hljs-regexp,.hljs-addition{color:#032f62}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable,.hljs-template-variable{color:#005cc5}
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#6f42c1}
.hljs-attr,.hljs-attribute,.hljs-meta,.hljs-built_in,.hljs-builtin-name{color:#e36209}
.hljs-deletion{color:#b31d28;background:#ffeef0}
.hljs-emphasis{font-style:italic}
.hljs-strong{font-weight:700}
`

export function pageToHtml(page: ExportDoc): string {
  const body = page.content.content.map(blockHtml).filter(Boolean).join('\n')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${esc(page.title || '未命名页面')}</title>
<style>
*{box-sizing:border-box}
body{max-width:820px;margin:40px auto;padding:0 20px 60px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.75;color:#1f2329;background:#fff}
h1,h2,h3{line-height:1.35;margin:1.4em 0 .6em}
h1{font-size:1.9em}
h2{font-size:1.5em}
h3{font-size:1.2em}
p{margin:.7em 0}
ul,ol{padding-left:1.6em}
li{margin:.25em 0}
.task-list{list-style:none;padding-left:0}
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid #d0d5dd;color:#5b6470;background:#fafbfc}
code{font-family:"Cascadia Code",Consolas,Menlo,monospace;font-size:.9em;background:#f1f3f5;padding:.15em .35em;border-radius:4px}
pre{background:#f6f8fa;border:1px solid #e5e8eb;border-radius:8px;padding:14px 16px;overflow:auto}
pre code{background:none;padding:0;font-size:13px;line-height:1.6}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #d0d5dd;padding:6px 10px;text-align:left}
th{background:#f6f8fa}
hr{border:none;border-top:1px solid #e5e8eb;margin:1.6em 0}
a{color:#2563eb}
${HLJS_CSS}
</style>
</head>
<body>
<h1>${esc(page.title || '未命名页面')}</h1>
${body}
</body>
</html>
`
}
