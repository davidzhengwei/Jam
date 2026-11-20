import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import type { Data } from '../types'
import { ensureIndex, searchPages, snippetParts } from '../lib/search'

interface Props {
  open: boolean
  data: Data | null
  onClose: () => void
  onSelect: (pageId: string, query: string, tabId: string) => void
}

export function SearchDialog({ open, data, onClose, onSelect }: Props) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const cacheRef = useRef<Map<string, any>>(new Map())
  const startedAt = useRef(0)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [open])

  const hits = useMemo(() => {
    if (!open || !data || !query.trim()) return []
    ensureIndex(data, cacheRef.current)
    startedAt.current = performance.now()
    const res = searchPages(data, cacheRef.current, query, 60)
    return res
  }, [open, data, query])

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const el = listRef.current?.querySelector('.search-hit.is-active') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const choose = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    onSelect(hit.pageId, query, hit.tabId)
    onClose()
  }

  return createPortal(
    <div className="modal-mask top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-box">
        <div className="search-input-row">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索标题与正文…（↑↓ 选择，回车跳转）"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => Math.min(a + 1, hits.length - 1))
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => Math.max(a - 1, 0))
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                choose(active)
              }
            }}
          />
          <span className="search-hint">{query.trim() ? `${hits.length} 条` : 'Ctrl+K'}</span>
        </div>

        <div className="search-results" ref={listRef}>
          {!query.trim() && <div className="search-empty">输入关键词，跨笔记本搜索标题与正文</div>}
          {query.trim() && hits.length === 0 && <div className="search-empty">没有找到「{query}」</div>}
          {hits.map((hit, index) => {
            const parts = snippetParts(hit.snippet, query)
            return (
              <div
                key={hit.tabId}
                className={`search-hit${index === active ? ' is-active' : ''}`}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <div className="hit-top">
                  <span className="hit-title">{hit.pageTitle}</span>
                  {hit.tabTitle && hit.tabTitle !== hit.pageTitle && (
                    <span className="hit-tab">{hit.tabTitle}</span>
                  )}
                  <span className="hit-path">
                    {hit.notebookTitle} / {hit.sectionTitle}
                  </span>
                </div>
                <div className="hit-snippet">
                  {parts.pre}
                  {parts.hit && <mark>{parts.hit}</mark>}
                  {parts.post}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>,
    document.body
  )
}
