import { marked } from 'marked'
import { codeToHtml } from './highlight'
import { normalizeLang } from './language'
import { readAttachment } from './attachments'

/** marked 统一配置：GFM（表格 / 任务列表 / 删除线），保留换行习惯由用户自己控制 */
const MD_OPTIONS = { gfm: true, breaks: false, async: false } as const

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'A', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  'HR', 'IMG', 'INPUT', 'SPAN', 'SUP', 'SUB', 'KBD', 'DIV',
])

/** 这些标签整块丢掉（连内容一起），避免脚本 / 外部资源混进预览 */
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'VIDEO', 'AUDIO'])

function escapeHtml(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unwrap(el: Element) {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}

/** 只保留结构：白名单标签 + 必要属性；att: 图片引用（本地附件）放行 */
function sanitize(root: Element) {
  for (const child of Array.from(root.children)) {
    const tag = child.tagName.toUpperCase()
    if (DROP_TAGS.has(tag)) {
      child.remove()
      continue
    }
    sanitize(child)
    if (!ALLOWED_TAGS.has(tag)) {
      unwrap(child)
      continue
    }
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value.trim()
      let keep = false
      if (tag === 'A') {
        if (name === 'href') keep = /^(https?:|mailto:|#|\/)/i.test(value)
        else if (name === 'title') keep = true
      } else if (tag === 'IMG') {
        if (name === 'src') keep = /^(https?:|data:image\/|att:)/i.test(value)
        else if (name === 'alt' || name === 'title') keep = true
      } else if (tag === 'INPUT') {
        keep = name === 'type' || name === 'checked' || name === 'disabled'
      } else if (tag === 'OL') {
        keep = name === 'start'
      } else if (tag === 'TD' || tag === 'TH') {
        keep = name === 'align' || name === 'colspan' || name === 'rowspan'
      } else if (tag === 'CODE') {
        keep = name === 'class' && /^language-[\w+#.-]+$/i.test(value)
      } else if (tag === 'LI') {
        keep = name === 'class' && /^task-list-item/.test(value)
      }
      if (!keep) child.removeAttribute(attr.name)
    }
    if (tag === 'INPUT' && (child.getAttribute('type') || '').toLowerCase() !== 'checkbox') child.remove()
  }
}

function toRoot(md: string): HTMLElement {
  const raw = marked.parse(String(md || ''), MD_OPTIONS as any) as unknown as string
  const doc = new DOMParser().parseFromString(`<div id="md-root">${raw}</div>`, 'text/html')
  const root = doc.getElementById('md-root') || doc.body
  sanitize(root)
  return root
}

function langOf(code: Element): string {
  const cls = code.getAttribute('class') || ''
  const hit = /(?:^|\s)language-([\w+#.-]+)/i.exec(cls)
  return hit ? hit[1] : ''
}

/** 预览：代码块换成与编辑器一致的外观（语言 + 行数 + 高亮），其余沿用宣纸排版 */
export function mdToPreviewHtml(md: string): string {
  const root = toRoot(md)
  for (const code of Array.from(root.querySelectorAll('pre > code'))) {
    const pre = code.parentElement
    if (!pre) continue
    const lang = langOf(code)
    const text = (code.textContent || '').replace(/\n$/, '')
    const lines = text ? text.split('\n').length : 1
    const label = lang ? normalizeLang(lang) : 'text'
    const wrap = root.ownerDocument.createElement('div')
    wrap.className = 'cb md-cb'
    wrap.innerHTML =
      `<div class="cb-head" contenteditable="false">` +
      `<span class="cb-lang-static">${escapeHtml(label)}</span>` +
      `<span class="cb-count">${lines} 行</span>` +
      `</div>` +
      `<div class="cb-body"><pre class="cb-pre"><code class="hljs">${codeToHtml(text, lang)}</code></pre></div>`
    pre.replaceWith(wrap)
  }
  return root.innerHTML
}

/**
 * 任务列表：marked 会把紧邻的普通列表和任务列表合并成一个 <ul>，
 * 这里按条目切开，普通条目留 bulletList、带 checkbox 的转 taskItem。
 */
function splitTaskLists(root: HTMLElement) {
  const doc = root.ownerDocument
  for (const ul of Array.from(root.querySelectorAll('ul'))) {
    const items = Array.from(ul.children).filter((el) => el.tagName === 'LI')
    if (!items.some((li) => li.querySelector('input[type="checkbox"]'))) continue

    const groups: { task: boolean; items: Element[] }[] = []
    for (const li of items) {
      const input = li.querySelector('input[type="checkbox"]')
      const task = !!input
      const last = groups[groups.length - 1]
      if (!last || last.task !== task) groups.push({ task, items: [li] })
      else last.items.push(li)

      if (input) {
        li.setAttribute('data-type', 'taskItem')
        li.setAttribute('data-checked', input.hasAttribute('checked') ? 'true' : 'false')
        input.remove()
        li.normalize()
        const target = li.querySelector('p') || li
        const first = target.firstChild
        if (first && first.nodeType === 3) first.textContent = (first.textContent || '').replace(/^\s+/, '')
      } else {
        li.removeAttribute('data-type')
        li.removeAttribute('data-checked')
      }
    }

    if (groups.length <= 1) {
      if (groups[0]?.task) ul.setAttribute('data-type', 'taskList')
      continue
    }

    for (const group of groups) {
      const list = doc.createElement('ul')
      if (group.task) list.setAttribute('data-type', 'taskList')
      group.items.forEach((li) => list.appendChild(li))
      ul.parentNode?.insertBefore(list, ul)
    }
    ul.remove()
  }
}

/** Markdown -> 富文本可解析的 HTML（代码块语言、任务列表、标题层级都要保住） */
export function mdToDocHtml(md: string): string {
  const root = toRoot(md)
  splitTaskLists(root)

  for (const el of Array.from(root.querySelectorAll('h4, h5, h6'))) {
    const h3 = root.ownerDocument.createElement('h3')
    h3.innerHTML = el.innerHTML
    el.replaceWith(h3)
  }

  return root.innerHTML
}

export interface MdHeading {
  level: number
  text: string
  /** 0 基行号 */
  line: number
}

/** 抽取标题（跳过代码围栏内的 # 注释），用于 Markdown 模式的大纲 */
export function extractMdHeadings(md: string): MdHeading[] {
  const out: MdHeading[] = []
  let fence: string | null = null
  String(md || '')
    .split('\n')
    .forEach((line, i) => {
      const fenceHit = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fenceHit) {
        if (!fence) fence = fenceHit[1][0]
        else if (fenceHit[1][0] === fence) fence = null
        return
      }
      if (fence) return
      const hit = /^(#{1,3})\s+(.*)$/.exec(line)
      if (hit) {
        out.push({
          level: hit[1].length,
          text: hit[2].replace(/[*_`~]/g, '').trim() || '（无标题）',
          line: i,
        })
      }
    })
  return out
}

/** 把预览 HTML 里的 att: 图片引用换成 dataURL（导出 HTML 用） */
export async function inlineAttachmentImages(html: string): Promise<string> {
  if (!html.includes('att:')) return html
  const doc = new DOMParser().parseFromString(`<div id="md-root">${html}</div>`, 'text/html')
  const root = doc.getElementById('md-root') || doc.body
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('att:')) continue
    const dataUrl = await readAttachment(src)
    if (dataUrl) img.setAttribute('src', dataUrl)
    else img.remove()
  }
  return root.innerHTML
}

const STANDALONE_CSS = `
*{box-sizing:border-box}
body{max-width:860px;margin:40px auto;padding:0 22px 80px;background:#fbf8f1;color:#241f19;
  font-family:-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;line-height:1.9;font-size:15px}
h1,h2,h3,h4{font-family:"Source Han Serif SC","Noto Serif SC","Songti SC","STSong","SimSun",serif;line-height:1.4;margin:1.5em 0 .6em}
h1{font-size:1.75em}h2{font-size:1.4em}h3{font-size:1.18em}
p{margin:.7em 0}
ul,ol{padding-left:1.6em}
li{margin:.22em 0}
blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid #b2372b;background:#f5f0e5;color:#6d6353}
code{font-family:"Cascadia Code",Consolas,Menlo,monospace;font-size:.9em;background:#efe7d6;padding:.12em .36em;border-radius:4px}
pre{background:#f3ecdd;border:1px solid #e3dacb;border-radius:6px;padding:12px 14px;overflow:auto}
pre code{background:none;padding:0;font-size:12.5px;line-height:1.7}
table{border-collapse:collapse;width:100%;margin:1em 0}
th,td{border:1px solid #e3dacb;padding:6px 10px;text-align:left;vertical-align:top}
th{background:#f5f0e5}
hr{border:none;border-top:1px solid #e3dacb;margin:1.8em 0}
a{color:#b2372b}
img{max-width:100%;border-radius:4px}
.hljs-comment,.hljs-quote{color:#a49a88;font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-type{color:#a33c2c}
.hljs-string,.hljs-regexp,.hljs-addition{color:#3f6b52}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-variable{color:#2f5d86}
.hljs-title,.hljs-section,.hljs-name,.hljs-selector-id,.hljs-selector-class{color:#5b4a86}
.hljs-attr,.hljs-attribute,.hljs-meta,.hljs-built_in{color:#8a6320}
`

/** 导出为可直接双击打开的独立 HTML（Markdown 页专用） */
export async function mdToStandaloneHtml(title: string, md: string): Promise<string> {
  const body = await inlineAttachmentImages(mdToPreviewHtml(md))
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title || '未命名页面')}</title>
<style>${STANDALONE_CSS}</style>
</head>
<body>
<h1>${escapeHtml(title || '未命名页面')}</h1>
${body}
</body>
</html>
`
}
