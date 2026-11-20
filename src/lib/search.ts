import type { Page } from '../types'

/** 从 ProseMirror JSON 中提取纯文本（用于搜索） */
export function docToText(content: any): string {
  if (!content) return ''
  const out: string[] = []
  const walk = (node: any) => {
    if (!node) return
    if (node.type === 'text' && typeof node.text === 'string') out.push(node.text)
    if (node.type === 'hardBreak') out.push('\n')
    if (Array.isArray(node.content)) node.content.forEach(walk)
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem' || node.type === 'tableRow') {
      out.push('\n')
    }
  }
  walk(content)
  return out.join(' ').replace(/[ \t]+/g, ' ').trim()
}

export interface IndexEntry {
  updatedAt: string
  title: string
  text: string
  lower: string
  lowerTitle: string
  tabId: string
  tabTitle: string
}

export interface Hit {
  pageId: string
  pageTitle: string
  tabId: string
  tabTitle: string
  notebookId: string
  notebookTitle: string
  sectionId: string
  sectionTitle: string
  snippet: string
  titleMatch: boolean
}

/** Markdown 源码转纯文本（去掉围栏、链接语法），让 Markdown 页也能被搜到 */
function mdToPlain(md?: string): string {
  if (!md) return ''
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`~>]/g, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 按页签增量维护内存索引：内容在页签上，一个页面可能有多个页签 */
export function ensureIndex(data: any, cache: Map<string, IndexEntry>) {
  const alive = new Set<string>()
  for (const nb of data.notebooks) {
    for (const sec of nb.sections) {
      for (const pg of sec.pages) {
        // 正文只在第 4 层页签；逐页签建索引
        for (const tab of pg.tabs) {
          alive.add(tab.id)
          const prev = cache.get(tab.id)
          if (prev && prev.updatedAt === tab.updatedAt && prev.title === tab.title) continue
          const text = [docToText(tab.content), mdToPlain(tab.md)].filter(Boolean).join('\n')
          cache.set(tab.id, {
            updatedAt: tab.updatedAt,
            title: pg.title,
            text,
            lower: text.toLowerCase(),
            lowerTitle: pg.title.toLowerCase(),
            tabId: tab.id,
            tabTitle: tab.title,
          })
        }
      }
    }
  }
  for (const key of Array.from(cache.keys())) if (!alive.has(key)) cache.delete(key)
}

export function searchPages(data: any, cache: Map<string, IndexEntry>, rawQuery: string, limit = 50): Hit[] {
  const q = rawQuery.trim().toLowerCase()
  if (q.length === 0) return []
  ensureIndex(data, cache)
  const hits: Hit[] = []

  for (const nb of data.notebooks) {
    for (const sec of nb.sections) {
      for (const pg of sec.pages) {
        for (const tab of pg.tabs) {
          const entry = cache.get(tab.id)
          if (!entry) continue
          const inTitle = entry.lowerTitle.includes(q)
          const at = entry.lower.indexOf(q)
          if (!inTitle && at < 0) continue
          hits.push({
            pageId: pg.id,
            pageTitle: pg.title,
            tabId: entry.tabId,
            tabTitle: entry.tabTitle,
            notebookId: nb.id,
            notebookTitle: nb.title,
            sectionId: sec.id,
            sectionTitle: sec.title,
            titleMatch: inTitle,
            snippet: at >= 0 ? makeSnippet(entry.text, at, q.length) : entry.text.slice(0, 60),
          })
          if (hits.length > 400) break
        }
      }
    }
  }

  hits.sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1
    return b.snippet.length - a.snippet.length
  })
  return hits.slice(0, limit)
}

function makeSnippet(text: string, at: number, len: number) {
  const start = Math.max(0, at - 34)
  const end = Math.min(text.length, at + len + 66)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

export function snippetParts(snippet: string, q: string): { pre: string; hit: string; post: string } {
  const needle = q.trim().toLowerCase()
  if (!needle) return { pre: snippet, hit: '', post: '' }
  const at = snippet.toLowerCase().indexOf(needle)
  if (at < 0) return { pre: snippet, hit: '', post: '' }
  return {
    pre: snippet.slice(0, at),
    hit: snippet.slice(at, at + needle.length),
    post: snippet.slice(at + needle.length),
  }
}

/** 页面体积 = 其所有页签正文之和（页面本身不存正文） */
export function pageSize(page: Page) {
  try {
    return page.tabs.reduce((n, t) => n + JSON.stringify(t.content).length, 0)
  } catch (_) {
    return 0
  }
}
