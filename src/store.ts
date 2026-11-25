import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { BackupItem, Data, Doc, Notebook, Page, Section, Tab, TrashItem, UiState } from './types'
import { storage } from './lib/storage'
import { deleteAttachments } from './lib/attachments'
import { pageBodyToMarkdown } from './lib/export'
import { nowIso, uid } from './lib/utils'
import { toast } from './lib/toast'
import { SECTION_COLORS } from './types'
import type { DragPayload, DropTarget } from './lib/dnd'
import { PARENT_KIND } from './lib/dnd'

export type SaveState = 'idle' | 'saved' | 'saving' | 'error'

const DEBOUNCE_MS = 800
const MAX_TABS = 12
const MAX_RECENT = 12

// ------------------------------------------------------------------
// 数据构造（全部是「新格式」，没有旧结构入参）
// ------------------------------------------------------------------

const para = (text: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : undefined,
})
const heading = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
})
const codeBlock = (language: string, code: string) => ({
  type: 'codeBlock',
  attrs: { language },
  content: [{ type: 'text', text: code }],
})

export function emptyDoc(): Doc {
  return { type: 'doc', content: [{ type: 'paragraph' }] }
}

/** 构造一个空白页签：正文恒为空白 doc，mode 恒为 rich。 */
function blankTab(pageTitle: string): Tab {
  const at = nowIso()
  return {
    id: uid('tab'), title: pageTitle, createdAt: at, updatedAt: at,
    content: emptyDoc(), md: '', mode: 'rich', favorite: false,
  }
}

function defaultUi(): UiState {
  return {
    activeTabId: null,
    activePageId: null,
    activeNotebookId: null,
    activeSectionId: null,
    theme: 'light',
    skin: 'paper',
    sidebarWidth: 200,
    listWidth: 240,
    contentWidth: 0,
    outlineOpen: true,
    listView: 'section',
    tagFilter: null,
    recent: [],
    mdLayout: 'split',
  }
}

/** 全新种子数据：笔记本层级「我的笔记 → 开始 / 代码库」，正文全部落在页签。 */
export function createInitialData(): Data {
  const nbId = uid('nb')
  const secStart = uid('sec')
  const secCode = uid('sec')
  const pgWelcome = uid('pg')
  const pgSql = uid('pg')
  const now = nowIso()

  const welcomeDoc: Doc = {
    type: 'doc',
    content: [
      para('结构是「笔记本 → 分区 → 页面 → 页签」四层，正文只写在页签里。左栏选笔记本，中栏选分区和页面，展开页面后点页签即可编辑。所有内容都存在 data/data.json —— 拷走整个文件夹就等于迁移和备份。'),
      heading(2, '代码块（核心功能）'),
      para('下面这块是代码块：右上角能选语言、一键复制，行号自动统计。把整段代码粘贴进空代码块时会自动识别语言。'),
      codeBlock(
        'java',
        `public class ThreadPoolDemo {
    public static void main(String[] args) {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        for (int i = 0; i < 8; i++) {
            pool.submit(() -> System.out.println("task " + Thread.currentThread().getName()));
        }
        pool.shutdown();
    }
}`
      ),
      heading(2, '马上可以试这三件事'),
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [para('新建一个分区，拖拽调整页面顺序')] },
          { type: 'taskItem', attrs: { checked: false }, content: [para('把一段 200 行的代码粘进代码块，看是否顺畅')] },
          { type: 'taskItem', attrs: { checked: false }, content: [para('按 Ctrl+K 搜索「线程池」')] },
        ],
      },
      {
        type: 'blockquote',
        content: [para('数据安全优先：停止输入 800ms 自动落盘，写入走「临时文件 → 原子改名」，不会出现半个文件。')],
      },
      heading(2, '快捷键'),
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [para('操作')] },
              { type: 'tableHeader', content: [para('快捷键')] },
            ],
          },
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [para('全局搜索')] }, { type: 'tableCell', content: [para('Ctrl+K')] }],
          },
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [para('立即保存')] }, { type: 'tableCell', content: [para('Ctrl+S')] }],
          },
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [para('行内代码')] }, { type: 'tableCell', content: [para('Ctrl+E')] }],
          },
          {
            type: 'tableRow',
            content: [{ type: 'tableCell', content: [para('加粗 / 斜体')] }, { type: 'tableCell', content: [para('Ctrl+B / Ctrl+I')] }],
          },
        ],
      },
      para('设置里还有：导出 Markdown / HTML、整库 zip 备份、备份恢复。'),
    ],
  }

  const welcomeTab: Tab = {
    id: uid('tab'),
    title: '欢迎使用 Jam',
    createdAt: now,
    updatedAt: now,
    content: welcomeDoc,
    md: '',
    mode: 'rich',
    favorite: false,
  }
  const welcome: Page = {
    id: pgWelcome,
    title: '欢迎使用 Jam',
    updatedAt: now,
    tabs: [welcomeTab],
    tags: [],
    favorite: false,
  }

  const sqlDoc: Doc = {
    type: 'doc',
    content: [
      para('分页查询（MySQL）：'),
      codeBlock(
        'sql',
        `SELECT id, title, updated_at
FROM notes
WHERE notebook_id = ?
ORDER BY updated_at DESC
LIMIT 20 OFFSET 40;`
      ),
      para('复制出去是纯文本，缩进与换行 1:1 保留。'),
    ],
  }
  const sqlTab: Tab = {
    id: uid('tab'),
    title: '常用 SQL',
    createdAt: now,
    updatedAt: now,
    content: sqlDoc,
    md: '',
    mode: 'rich',
    favorite: false,
  }
  const sql: Page = {
    id: pgSql,
    title: '常用 SQL',
    updatedAt: now,
    tabs: [sqlTab],
    tags: [],
    favorite: false,
  }

  const ui = defaultUi()
  ui.activeNotebookId = nbId
  ui.activeSectionId = secStart
  ui.activePageId = pgWelcome
  ui.activeTabId = welcomeTab.id
  ui.recent = [pgWelcome]

  const data: Data = {
    version: 2,
    updatedAt: nowIso(),
    notebooks: [
      {
        id: nbId,
        title: '我的笔记',
        sections: [
          { id: secStart, title: '开始', color: '#b2372b', pages: [welcome] },
          { id: secCode, title: '代码库', color: '#2f5d86', pages: [sql] },
        ],
      },
    ],
    trash: [],
    ui,
  }
  return data
}

// ------------------------------------------------------------------
// 数据校验：只认 v2 结构，不合法一律丢弃用种子重建（没有任何迁移分支）
// ------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === 'object' && !Array.isArray(x)
const isArr = Array.isArray
const isStr = (x: unknown): x is string => typeof x === 'string'
const hasStr = (o: any, k: string) => isStr(o[k])

function isDoc(x: unknown): x is Doc {
  return isObj(x) && x.type === 'doc' && isArr(x.content)
}

function isTab(x: unknown): x is Tab {
  return (
    isObj(x) &&
    hasStr(x, 'id') &&
    hasStr(x, 'title') &&
    hasStr(x, 'createdAt') &&
    hasStr(x, 'updatedAt') &&
    isDoc(x.content) &&
    isStr(x.md) &&
    (x.mode === 'rich' || x.mode === 'md') &&
    typeof x.favorite === 'boolean'
  )
}

function isPage(x: unknown): x is Page {
  return (
    isObj(x) &&
    hasStr(x, 'id') &&
    hasStr(x, 'title') &&
    hasStr(x, 'updatedAt') &&
    isArr(x.tabs) &&
    x.tabs.every(isTab) &&
    isArr(x.tags) &&
    x.tags.every(isStr) &&
    typeof x.favorite === 'boolean'
  )
}

/** 严格校验 v2 数据；只要任意一层结构不对就判为非法，交给调用方重建种子。 */
export function isValidData(x: unknown): x is Data {
  if (!isObj(x) || x.version !== 2) return false
  if (!hasStr(x, 'updatedAt') || !isArr(x.notebooks) || !isArr(x.trash)) return false
  for (const nb of x.notebooks) {
    if (!isObj(nb) || !hasStr(nb, 'id') || !hasStr(nb, 'title') || !isArr(nb.sections)) return false
    for (const sec of nb.sections) {
      if (!isObj(sec) || !hasStr(sec, 'id') || !hasStr(sec, 'title') || !hasStr(sec, 'color') || !isArr(sec.pages)) return false
      if (!sec.pages.every(isPage)) return false
    }
  }
  const ui = x.ui
  if (!isObj(ui)) return false
  const uiStrKeys: (keyof UiState)[] = [
    'activeTabId', 'activePageId', 'activeNotebookId', 'activeSectionId',
    'theme', 'sidebarWidth', 'listWidth', 'contentWidth', 'outlineOpen', 'listView', 'tagFilter', 'mdLayout',
  ]
  for (const k of uiStrKeys) if (!(k in ui)) return false
  if (!isArr(ui.recent) || !ui.recent.every(isStr)) return false
  return true
}

// ------------------------------------------------------------------
// 定位辅助
// ------------------------------------------------------------------

export interface PageLocate {
  notebook: Notebook
  section: Section
  page: Page
  pageIndex: number
}

export function locatePage(data: Data | null, pageId: string | null): PageLocate | null {
  if (!data || !pageId) return null
  for (const notebook of data.notebooks) {
    for (const section of notebook.sections) {
      const pageIndex = section.pages.findIndex((p) => p.id === pageId)
      if (pageIndex >= 0) return { notebook, section, page: section.pages[pageIndex], pageIndex }
    }
  }
  return null
}

export function locateSection(data: Data | null, sectionId: string | null) {
  if (!data || !sectionId) return null
  for (const notebook of data.notebooks) {
    const index = notebook.sections.findIndex((s) => s.id === sectionId)
    if (index >= 0) return { notebook, section: notebook.sections[index], index }
  }
  return null
}

function allPages(data: Data): Page[] {
  const out: Page[] = []
  for (const nb of data.notebooks) for (const sec of nb.sections) out.push(...sec.pages)
  return out
}

/**
 * 中栏当前可见的页面 id（收藏置顶）。由视图 / 分区 / 标签筛选决定，只服务中栏列表，
 * 与第 4 层页签（全库 allTabs）彻底解耦。
 */
export function visiblePageIds(data: Data | null): string[] {
  if (!data) return []
  const ui = data.ui
  let list: Page[] = []
  if (ui.listView === 'section') {
    const nb = data.notebooks.find((n) => n.id === ui.activeNotebookId) || data.notebooks[0]
    const sec = nb?.sections.find((s) => s.id === ui.activeSectionId) || null
    const base = sec?.pages || []
    list = [...base.filter((p) => p.favorite), ...base.filter((p) => !p.favorite)]
  } else if (ui.listView === 'recent') {
    const byId = new Map(allPages(data).map((p) => [p.id, p]))
    list = ui.recent.map((id) => byId.get(id)).filter((p): p is Page => !!p)
  } else {
    list = allPages(data).filter((p) => p.favorite)
  }
  if (ui.tagFilter) list = list.filter((p) => p.tags.includes(ui.tagFilter!))
  return list.map((p) => p.id)
}

export function countPages(data: Data | null) {
  return data ? allPages(data).length : 0
}

export interface TabLoc {
  tab: Tab
  page: Page
  section: Section
  notebook: Notebook
}

/** 全库按创建时间收集所有页签；页签来源只由其从属层级决定，与中栏可见集合无关。 */
export function allTabs(data: Data | null): TabLoc[] {
  const out: TabLoc[] = []
  if (!data) return out
  for (const nb of data.notebooks) for (const sec of nb.sections) for (const page of sec.pages) {
    for (const tab of page.tabs) out.push({ tab, page, section: sec, notebook: nb })
  }
  out.sort((a, b) => a.tab.createdAt.localeCompare(b.tab.createdAt))
  return out
}

/**
 * 顶部页签栏的级联集合：当前中栏选中页面的全部页签 + 全库已收藏页签（去重、按创建时间）。
 * 未收藏页签随中栏选中页面切换；收藏页签常驻，不受切换影响。
 */
export function visibleTabs(data: Data | null): TabLoc[] {
  if (!data) return []
  const selectedPageId = data.ui.activePageId
  const seen = new Set<string>()
  const out: TabLoc[] = []
  for (const loc of allTabs(data)) {
    if (loc.page.id === selectedPageId || loc.tab.favorite) {
      if (!seen.has(loc.tab.id)) {
        seen.add(loc.tab.id)
        out.push(loc)
      }
    }
  }
  return out
}

/** 按 id 定位页签及其从属四层。 */
export function locateTab(data: Data | null, tabId: string | null): TabLoc | null {
  if (!data || !tabId) return null
  for (const nb of data.notebooks) for (const sec of nb.sections) for (const page of sec.pages) {
    const tab = page.tabs.find((t) => t.id === tabId)
    if (tab) return { tab, page, section: sec, notebook: nb }
  }
  return null
}

/** 页签在所属页面 tabs[] 中的索引（拖拽排序用） */
export function locateTabIndex(data: Data | null, tabId: string | null): number {
  if (!data || !tabId) return -1
  for (const nb of data.notebooks) for (const sec of nb.sections) for (const page of sec.pages) {
    const idx = page.tabs.findIndex((t) => t.id === tabId)
    if (idx >= 0) return idx
  }
  return -1
}

// ------------------------------------------------------------------
// 激活态：activeTabId 是唯一真相，其余派生 / 浏览字段由它维护
// ------------------------------------------------------------------

/**
 * 激活一个页签：同步 activeTabId；有效页签同时把中栏上下文（页面/分区/笔记本）定位到它所属层级。
 * tabId 为 null 是合法的「空页面空状态」——不清除 activePageId，保留中栏当前选中的页面。
 */
function activateTabInData(data: Data, tabId: string | null) {
  const ui = data.ui
  ui.activeTabId = tabId
  const loc = locateTab(data, tabId)
  if (loc) {
    ui.activePageId = loc.page.id
    ui.activeSectionId = loc.section.id
    ui.activeNotebookId = loc.notebook.id
  }
}

/**
 * 不变量修复。角色分工：
 *  - activeNotebookId / activeSectionId：中栏浏览上下文，节点被删时兜底，不主动覆盖用户浏览。
 *  - activePageId：中栏选中页面真相；null 是合法空状态，非 null 但页面不存在才回退。
 *  - activeTabId：编辑真相；null 合法，非 null 但页签不存在则置空（保留空状态，不跳全库）。
 */
function reconcileActive(data: Data) {
  const ui = data.ui

  // 0. 皮肤兜底：旧数据无此字段或非法一律用默认宣纸，保证默认表现不变
  if (ui.skin !== 'paper' && ui.skin !== 'workbench' && ui.skin !== 'ink') ui.skin = 'paper'

  // 1. 笔记本 / 分区上下文兜底
  if (!data.notebooks.some((n) => n.id === ui.activeNotebookId)) {
    ui.activeNotebookId = data.notebooks[0]?.id ?? null
  }
  const nb = data.notebooks.find((n) => n.id === ui.activeNotebookId)
  if (!nb) {
    ui.activeSectionId = null
  } else if (!nb.sections.some((s) => s.id === ui.activeSectionId)) {
    ui.activeSectionId = nb.sections[0]?.id ?? null
  }

  // 2. activePageId 兜底：页面被删则回退到当前分区 / 全库第一个页面，并激活其首个页签
  if (ui.activePageId !== null && !locatePage(data, ui.activePageId)) {
    const sec = nb?.sections.find((s) => s.id === ui.activeSectionId)
    const next = sec?.pages[0] ?? allPages(data)[0] ?? null
    ui.activePageId = next?.id ?? null
    ui.activeTabId = next?.tabs[0]?.id ?? null
  }

  // 3. activeTabId 兜底：页签被删则置空，保留当前页面的空状态（不跳到别的页面）
  if (ui.activeTabId !== null && !locateTab(data, ui.activeTabId)) {
    ui.activeTabId = null
  }

  // 4. 激活页签有效时，确保中栏上下文与它一致（仅当 activePageId 落后时同步）
  const loc = locateTab(data, ui.activeTabId)
  if (loc && ui.activePageId !== loc.page.id) {
    ui.activePageId = loc.page.id
    ui.activeSectionId = loc.section.id
    ui.activeNotebookId = loc.notebook.id
  }
}

/**
 * 在指定页面新建一个空白页签，超过上限淘汰最早创建的非激活页签。
 * 新流程只有一种页签：空白页签；不存在任何「继承页面正文」的模式。
 */
function openBlankTab(data: Data, pageId: string): string {
  const loc = locatePage(data, pageId)
  if (!loc) return ''
  const tab = blankTab(loc.page.title)
  loc.page.tabs.push(tab)
  loc.page.updatedAt = nowIso()
  while (loc.page.tabs.length > MAX_TABS) {
    const idx = loc.page.tabs.findIndex((t) => t.id !== data.ui.activeTabId)
    loc.page.tabs.splice(idx >= 0 ? idx : 0, 1)
  }
  return tab.id
}

/**
 * 在指定页面把外部 .md 导入为一个新页签：标题取文件名，正文落在 md 字段，
 * mode 直接为 md（打开即进入双栏查看）。超过上限同样淘汰最早非激活页签。
 */
function openImportedMarkdown(data: Data, pageId: string, title: string, md: string): string {
  const loc = locatePage(data, pageId)
  if (!loc) return ''
  const tab = blankTab(title || '未命名文档')
  tab.md = md
  tab.mode = 'md'
  tab.title = title || tab.title
  loc.page.tabs.push(tab)
  loc.page.updatedAt = nowIso()
  while (loc.page.tabs.length > MAX_TABS) {
    const idx = loc.page.tabs.findIndex((t) => t.id !== data.ui.activeTabId)
    loc.page.tabs.splice(idx >= 0 ? idx : 0, 1)
  }
  return tab.id
}

function pushRecent(data: Data, pageId: string) {
  const ui = data.ui
  const list = ui.recent.filter((id) => id !== pageId)
  list.unshift(pageId)
  ui.recent = list.slice(0, MAX_RECENT)
}

/** 彻底删除页面时清理其所有页签的附件（附件归属页签）。进回收站不调用，支持还原。 */
function dropPageAttachments(page: Page) {
  for (const t of page.tabs) void deleteAttachments(t.id)
}

// ------------------------------------------------------------------
// Store
// ------------------------------------------------------------------

export function useStore() {
  const dataRef = useRef<Data | null>(null)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const [ready, setReady] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const bigPageWarned = useRef<Set<string>>(new Set())

  const doSave = useCallback(async () => {
    if (!dataRef.current || !dirtyRef.current || savingRef.current) return
    savingRef.current = true
    setSaveState('saving')
    const snapshot = JSON.stringify({ ...dataRef.current, updatedAt: nowIso() })
    try {
      const res = await storage.save(snapshot)
      if (res?.ok) {
        dirtyRef.current = false
        setSaveState('saved')
        setSaveError(null)
        setLastSavedAt(new Date().toISOString())
      } else {
        setSaveState('error')
        setSaveError(res?.error || '保存失败')
        toast(`保存失败：${res?.error || '未知错误'}`, 'error')
      }
    } catch (err: any) {
      setSaveState('error')
      setSaveError(String(err?.message || err))
      toast(`保存失败：${err?.message || err}`, 'error')
    } finally {
      savingRef.current = false
    }
  }, [])

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true
    setSaveState('saving')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void doSave()
    }, DEBOUNCE_MS)
  }, [doSave])

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await doSave()
  }, [doSave])

  /** 所有写操作的统一入口：改数据 → 校验不变量 → 触发渲染 → 排队落盘。 */
  const mutate = useCallback(
    (fn: (d: Data) => void, options?: { render?: boolean; save?: boolean }) => {
      const data = dataRef.current
      if (!data) return
      fn(data)
      data.updatedAt = nowIso()
      reconcileActive(data)
      if (options?.render !== false) bump()
      if (options?.save !== false) scheduleSave()
    },
    [scheduleSave]
  )

  // 加载：只加载合法 v2 数据；损坏 / 版本不符 / 结构非法一律用种子重建，不迁移
  useEffect(() => {
    let alive = true
    ;(async () => {
      const res = await storage.load()
      if (!alive) return
      const data = res.data
      if (data && isValidData(data)) {
        dataRef.current = data
        reconcileActive(data)
        setReady(true)
        bump()
        return
      }
      if (res.corrupted) toast('数据文件无法识别，已用全新数据启动', 'error')
      const seed = createInitialData()
      dataRef.current = seed
      dirtyRef.current = true
      setReady(true)
      bump()
      void doSave()
    })()
    return () => {
      alive = false
    }
  }, [doSave])

  // 关窗前强制落盘（唯一兜底通道：主进程 app:before-quit → flush）
  useEffect(() => {
    const off = window.jam?.onBeforeQuit?.(async () => {
      await flush()
      window.jam?.flushDone?.()
    })
    return () => off?.()
  }, [flush])

  const api = useMemo(() => {
    const withData = (fn: (d: Data) => void, options?: { render?: boolean; save?: boolean }) => mutate(fn, options)

    return {
      get data(): Data | null {
        return dataRef.current
      },
      ready,
      saveState,
      saveError,
      lastSavedAt,
      flush,

      /** 恢复备份：只接受合法 v2 数据，否则拒绝并提示（不迁移旧备份）。 */
      reload: (next: Data) => {
        if (!isValidData(next)) {
          toast('备份数据不是当前版本格式，无法恢复', 'error')
          return
        }
        dataRef.current = next
        reconcileActive(next)
        dirtyRef.current = true
        bump()
        void doSave()
      },

      setUi: (patch: Partial<UiState>, render = true) =>
        withData((d) => Object.assign(d.ui, patch), { render, save: true }),

      // ---- 浏览上下文：中栏切笔记本 / 分区 / 页面，级联决定顶部页签集合 ----
      selectNotebook: (notebookId: string) =>
        withData((d) => {
          if (!d.notebooks.some((n) => n.id === notebookId)) return
          d.ui.activeNotebookId = notebookId
          const nb = d.notebooks.find((n) => n.id === notebookId)!
          if (!nb.sections.some((s) => s.id === d.ui.activeSectionId)) d.ui.activeSectionId = nb.sections[0]?.id ?? null
          const sec = nb.sections.find((s) => s.id === d.ui.activeSectionId)
          const page = sec?.pages[0]
          d.ui.activePageId = page?.id ?? null
          d.ui.activeTabId = page?.tabs[0]?.id ?? null
        }),

      selectSection: (sectionId: string) =>
        withData((d) => {
          const loc = locateSection(d, sectionId)
          if (!loc) return
          d.ui.activeNotebookId = loc.notebook.id
          d.ui.activeSectionId = sectionId
          const page = loc.section.pages[0]
          d.ui.activePageId = page?.id ?? null
          d.ui.activeTabId = page?.tabs[0]?.id ?? null
        }),

      /**
       * 中栏左键选中页面：这是顶部页签级联的唯一来源。
       * 有页签则激活第一个；无页签则置空编辑态（顶部留空，由加号新建），不自动造页签。
       */
      selectPage: (pageId: string | null) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          d.ui.activePageId = loc.page.id
          d.ui.activeNotebookId = loc.notebook.id
          d.ui.activeSectionId = loc.section.id
          pushRecent(d, loc.page.id)
          const first = loc.page.tabs[0]
          activateTabInData(d, first ? first.id : null)
        }),

      // ---- 页签（第 4 层，正文唯一载体）----
      activateTab: (tabId: string) =>
        withData((d) => {
          if (!locateTab(d, tabId)) return
          activateTabInData(d, tabId)
        }),

      /** 显式新建空白页签：同一页面可开多个，各自独立且不复制现有内容。 */
      newTab: (pageId: string) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          const tabId = openBlankTab(d, pageId)
          d.ui.activeNotebookId = loc.notebook.id
          d.ui.activeSectionId = loc.section.id
          pushRecent(d, pageId)
          activateTabInData(d, tabId)
        }),

      /** 打开外部 .md：在当前页面新建 md 模式页签并激活，不改数据模型。 */
      openMarkdownTab: (pageId: string, title: string, md: string) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          const tabId = openImportedMarkdown(d, pageId, title, md)
          if (!tabId) return
          d.ui.activeNotebookId = loc.notebook.id
          d.ui.activeSectionId = loc.section.id
          pushRecent(d, pageId)
          activateTabInData(d, tabId)
        }),

      renameTab: (tabId: string, title: string) =>
        withData((d) => {
          const loc = locateTab(d, tabId)
          if (!loc) return
          loc.tab.title = title.trim() || '未命名页签'
          loc.tab.updatedAt = nowIso()
        }),

      closeTab: (tabId: string) =>
        withData((d) => {
          const loc = locateTab(d, tabId)
          if (!loc) return
          const tabs = loc.page.tabs
          const idx = tabs.findIndex((t) => t.id === tabId)
          if (idx < 0) return
          tabs.splice(idx, 1)
          loc.page.updatedAt = nowIso()
          // 关闭即删除该页签的正文与附件
          void deleteAttachments(tabId)
          if (d.ui.activeTabId !== tabId) return
          const neighbor = tabs[Math.min(idx, tabs.length - 1)]
          const fallback = allTabs(d).slice(-1)[0]
          activateTabInData(d, neighbor ? neighbor.id : fallback ? fallback.tab.id : null)
        }),

      closeOtherTabs: (tabId: string) =>
        withData((d) => {
          if (!locateTab(d, tabId)) return
          for (const n of d.notebooks) for (const s of n.sections) for (const p of s.pages) {
            for (const t of p.tabs) if (t.id !== tabId) void deleteAttachments(t.id)
            p.tabs = p.tabs.filter((t) => t.id === tabId)
          }
          reconcileActive(d)
          activateTabInData(d, tabId)
        }),

      closeAllTabs: () =>
        withData((d) => {
          // 保留当前页签，避免关完界面全空
          const keep = d.ui.activeTabId
          for (const n of d.notebooks) for (const s of n.sections) for (const p of s.pages) {
            for (const t of p.tabs) if (t.id !== keep) void deleteAttachments(t.id)
            p.tabs = keep ? p.tabs.filter((t) => t.id === keep) : []
          }
          reconcileActive(d)
        }),

      /** Ctrl+Tab 在当前顶部可见页签（当前页面页签 + 收藏页签）间循环 */
      cycleTab: (delta: number) =>
        withData((d) => {
          const tabs = visibleTabs(d)
          if (tabs.length < 2) return
          const idx = tabs.findIndex((t) => t.tab.id === d.ui.activeTabId)
          const next = tabs[((idx < 0 ? 0 : idx) + delta + tabs.length) % tabs.length]
          activateTabInData(d, next.tab.id)
        }),

      // ---- 笔记本（第 1 层）----
      createNotebook: (title: string) => {
        const id = uid('nb')
        withData((d) => {
          d.notebooks.push({ id, title: title.trim() || '新建笔记本', sections: [] })
          d.ui.activeNotebookId = id
          d.ui.activeSectionId = null
        })
        return id
      },
      renameNotebook: (id: string, title: string) =>
        withData((d) => {
          const nb = d.notebooks.find((n) => n.id === id)
          if (nb) nb.title = title
        }),
      deleteNotebook: (id: string) =>
        withData((d) => {
          const idx = d.notebooks.findIndex((n) => n.id === id)
          if (idx < 0) return
          const nb = d.notebooks[idx]
          for (const sec of nb.sections) {
            for (const page of sec.pages) {
              d.trash.unshift({
                id: uid('tr'), page, deletedAt: nowIso(),
                notebookId: nb.id, notebookTitle: nb.title, sectionId: sec.id, sectionTitle: sec.title,
              })
            }
          }
          d.notebooks.splice(idx, 1)
          if (d.ui.activeNotebookId === id) {
            d.ui.activeNotebookId = d.notebooks[0]?.id ?? null
            d.ui.activeSectionId = d.notebooks[0]?.sections[0]?.id ?? null
          }
          reconcileActive(d)
        }),

      // ---- 分区（第 2 层）----
      createSection: (notebookId: string, title: string) => {
        const id = uid('sec')
        withData((d) => {
          const nb = d.notebooks.find((n) => n.id === notebookId)
          if (!nb) return
          nb.sections.push({
            id,
            title: title.trim() || '新建分区',
            color: SECTION_COLORS[nb.sections.length % SECTION_COLORS.length],
            pages: [],
          })
          d.ui.activeNotebookId = notebookId
          d.ui.activeSectionId = id
        })
        return id
      },
      renameSection: (id: string, title: string) =>
        withData((d) => {
          const loc = locateSection(d, id)
          if (loc) loc.section.title = title
        }),
      setSectionColor: (id: string, color: string) =>
        withData((d) => {
          const loc = locateSection(d, id)
          if (loc) loc.section.color = color
        }),
      deleteSection: (id: string) =>
        withData((d) => {
          const loc = locateSection(d, id)
          if (!loc) return
          const { notebook, section, index } = loc
          for (const page of section.pages) {
            d.trash.unshift({
              id: uid('tr'), page, deletedAt: nowIso(),
              notebookId: notebook.id, notebookTitle: notebook.title, sectionId: section.id, sectionTitle: section.title,
            })
          }
          notebook.sections.splice(index, 1)
          if (d.ui.activeSectionId === id) d.ui.activeSectionId = notebook.sections[0]?.id ?? null
          reconcileActive(d)
        }),
      moveSection: (sectionId: string, targetNotebookId: string, index: number) =>
        withData((d) => {
          const loc = locateSection(d, sectionId)
          const target = d.notebooks.find((n) => n.id === targetNotebookId)
          if (!loc || !target) return
          loc.notebook.sections.splice(loc.index, 1)
          target.sections.splice(Math.max(0, Math.min(index, target.sections.length)), 0, loc.section)
          d.ui.activeNotebookId = target.id
          d.ui.activeSectionId = sectionId
        }),
      moveSectionBy: (sectionId: string, delta: number) =>
        withData((d) => {
          const loc = locateSection(d, sectionId)
          if (!loc) return
          const to = loc.index + delta
          if (to < 0 || to >= loc.notebook.sections.length) return
          const [sec] = loc.notebook.sections.splice(loc.index, 1)
          loc.notebook.sections.splice(to, 0, sec)
        }),

      // ---- 页面（第 3 层）----
      createPage: (sectionId: string, title?: string) => {
        const id = uid('pg')
        withData((d) => {
          const loc = locateSection(d, sectionId)
          if (!loc) return
          const page: Page = {
            id,
            title: (title || '未命名页面').trim() || '未命名页面',
            updatedAt: nowIso(),
            tabs: [],
            tags: [],
            favorite: false,
          }
          loc.section.pages.unshift(page)
          d.ui.activeNotebookId = loc.notebook.id
          d.ui.activeSectionId = sectionId
          // 新页面自带一个空白页签：正文只能写在页签里
          const tabId = openBlankTab(d, id)
          activateTabInData(d, tabId)
          pushRecent(d, id)
        })
        return id
      },
      renamePage: (id: string, title: string) =>
        withData((d) => {
          const loc = locatePage(d, id)
          if (loc) {
            loc.page.title = title
            loc.page.updatedAt = nowIso()
            // 页签标题独立，重命名页面不覆盖页签标题
          }
        }),
      duplicatePage: (id: string) => {
        let newId = ''
        withData((d) => {
          const loc = locatePage(d, id)
          if (!loc) return
          newId = uid('pg')
          const now = nowIso()
          const copy: Page = {
            id: newId,
            title: `${loc.page.title} 副本`,
            updatedAt: now,
            tags: [...loc.page.tags],
            favorite: false,
            tabs: loc.page.tabs.map((t) => ({
              id: uid('tab'),
              title: t.title,
              createdAt: now,
              updatedAt: now,
              content: JSON.parse(JSON.stringify(t.content)),
              md: t.md,
              mode: t.mode,
              favorite: t.favorite,
            })),
          }
          if (!copy.tabs.length) copy.tabs.push(blankTab(copy.title))
          loc.section.pages.splice(loc.pageIndex + 1, 0, copy)
          d.ui.activeSectionId = loc.section.id
          activateTabInData(d, copy.tabs[0].id)
          pushRecent(d, newId)
        })
        return newId
      },
      deletePage: (id: string) =>
        withData((d) => {
          const loc = locatePage(d, id)
          if (!loc) return
          const [removed] = loc.section.pages.splice(loc.pageIndex, 1)
          d.trash.unshift({
            id: uid('tr'), page: removed, deletedAt: nowIso(),
            notebookId: loc.notebook.id, notebookTitle: loc.notebook.title,
            sectionId: loc.section.id, sectionTitle: loc.section.title,
          })
          reconcileActive(d)
        }),
      movePageBy: (pageId: string, delta: number) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          const to = loc.pageIndex + delta
          if (to < 0 || to >= loc.section.pages.length) return
          const [pg] = loc.section.pages.splice(loc.pageIndex, 1)
          loc.section.pages.splice(to, 0, pg)
        }),
      movePage: (pageId: string, targetSectionId: string, index: number) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          const target = locateSection(d, targetSectionId)
          if (!loc || !target) return
          loc.section.pages.splice(loc.pageIndex, 1)
          target.section.pages.splice(Math.max(0, Math.min(index, target.section.pages.length)), 0, loc.page)
          d.ui.activeNotebookId = target.notebook.id
          d.ui.activeSectionId = targetSectionId
        }),

      /**
       * 统一拖拽迁移：分区 / 页面 / 页签共用，先校验合法性再原子搬迁。
       * target.index 是「删除源之前」的视觉插入位；同数组搬迁时自动修正偏移。
       * 返回是否真正发生了移动，非法拖拽一律返回 false 且保持原状态。
       */
      moveNode: (payload: DragPayload, target: DropTarget): boolean => {
        if (!payload || !payload.id || PARENT_KIND[payload.type] !== target.kind) return false
        let moved = false
        withData((d) => {
          // ---- 定位源数组 / 源索引 ----
          let src: any[] | null = null
          let from = -1
          let node: any = null
          if (payload.type === 'section') {
            const loc = locateSection(d, payload.id)
            if (loc) {
              src = loc.notebook.sections
              from = loc.index
              node = loc.section
            }
          } else if (payload.type === 'page') {
            const loc = locatePage(d, payload.id)
            if (loc) {
              src = loc.section.pages
              from = loc.pageIndex
              node = loc.page
            }
          } else {
            const loc = locateTab(d, payload.id)
            const idx = locateTabIndex(d, payload.id)
            if (loc && idx >= 0) {
              src = loc.page.tabs
              from = idx
              node = loc.tab
            }
          }
          if (!src || from < 0 || !node) return

          // ---- 定位目标容器数组，并解析目标笔记本/分区/页面用于同步浏览上下文 ----
          let dst: any[] | null = null
          let targetNbId: string | null = null
          let targetSecId: string | null = null
          let targetPageId: string | null = null
          if (target.kind === 'notebook') {
            const nb = d.notebooks.find((n) => n.id === target.id)
            if (nb) {
              dst = nb.sections
              targetNbId = nb.id
            }
          } else if (target.kind === 'section') {
            const loc = locateSection(d, target.id)
            if (loc) {
              dst = loc.section.pages
              targetNbId = loc.notebook.id
              targetSecId = loc.section.id
            }
          } else {
            const loc = locatePage(d, target.id)
            if (loc) {
              dst = loc.page.tabs
              targetNbId = loc.notebook.id
              targetSecId = loc.section.id
              targetPageId = loc.page.id
            }
          }
          if (!dst) return

          // ---- 索引修正：同数组内前移，删除源后目标位减一 ----
          let to = Math.max(0, Math.min(target.index, dst.length))
          if (src === dst && from < to) to -= 1
          // 落在原位：无变化，直接返回
          if (src === dst && from === to) return

          src.splice(from, 1)
          dst.splice(Math.max(0, Math.min(to, dst.length)), 0, node)
          moved = true

          // ---- 浏览上下文跟随到目标层级，保证迁走后仍可见 ----
          if (targetNbId) d.ui.activeNotebookId = targetNbId
          if (targetSecId) d.ui.activeSectionId = targetSecId
          if (targetPageId) d.ui.activePageId = targetPageId
          // 被移动的若是页签，保持它激活；页签/页面时间随迁移更新
          if (payload.type === 'tab') {
            d.ui.activeTabId = payload.id
            node.updatedAt = nowIso()
          } else if (payload.type === 'page') {
            node.updatedAt = nowIso()
          }
        })
        return moved
      },

      // ---- 正文写入：只接受 tabId（前三层无正文入口）----
      updateContent: (tabId: string, content: Doc) => {
        const data = dataRef.current
        if (!data) return
        const loc = locateTab(data, tabId)
        if (!loc) return
        loc.tab.content = content
        loc.tab.updatedAt = nowIso()
        loc.page.updatedAt = nowIso()
        data.updatedAt = nowIso()
        const size = JSON.stringify(content || {}).length
        if (size > 1024 * 1024 && !bigPageWarned.current.has(tabId)) {
          bigPageWarned.current.add(tabId)
          toast('这一页已超过 1MB，建议拆分成多个页签以免变慢', 'info')
        }
        scheduleSave()
      },

      // ---- Markdown 双栏（作用于页签）----
      setPageMode: (tabId: string, mode: 'rich' | 'md') =>
        withData((d) => {
          const loc = locateTab(d, tabId)
          if (!loc) return
          if (mode === 'md' && loc.tab.mode !== 'md') loc.tab.md = pageBodyToMarkdown(loc.tab)
          loc.tab.mode = mode
          loc.tab.updatedAt = nowIso()
        }),
      togglePageMode: (tabId: string) =>
        withData((d) => {
          const loc = locateTab(d, tabId)
          if (!loc) return
          if (loc.tab.mode === 'md') {
            loc.tab.mode = 'rich'
          } else {
            loc.tab.md = pageBodyToMarkdown(loc.tab)
            loc.tab.mode = 'md'
          }
          loc.tab.updatedAt = nowIso()
        }),
      updateMarkdown: (tabId: string, md: string) => {
        const data = dataRef.current
        if (!data) return
        const loc = locateTab(data, tabId)
        if (!loc) return
        loc.tab.md = md
        loc.tab.updatedAt = nowIso()
        loc.page.updatedAt = nowIso()
        data.updatedAt = nowIso()
        scheduleSave()
      },

      // ---- 标签与收藏（作用于页面，仅组织层）----
      setPageTags: (pageId: string, tags: string[]) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          loc.page.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 8)
        }),
      toggleFavorite: (pageId: string) =>
        withData((d) => {
          const loc = locatePage(d, pageId)
          if (!loc) return
          loc.page.favorite = !loc.page.favorite
        }),
      /** 收藏页签：收藏后常驻顶部，不随中栏页面切换而消失 */
      toggleTabFavorite: (tabId: string) =>
        withData((d) => {
          const loc = locateTab(d, tabId)
          if (!loc) return
          loc.tab.favorite = !loc.tab.favorite
          loc.tab.updatedAt = nowIso()
        }),

      // ---- 回收站 ----
      restoreTrash: (trashId: string) =>
        withData((d) => {
          const idx = d.trash.findIndex((t) => t.id === trashId)
          if (idx < 0) return
          const item = d.trash[idx]
          let target =
            d.notebooks.find((n) => n.id === item.notebookId)?.sections.find((s) => s.id === item.sectionId) || null
          if (!target) {
            const nb = d.notebooks.find((n) => n.id === item.notebookId) || d.notebooks[0]
            if (!nb) return
            if (!nb.sections.length) nb.sections.push({ id: uid('sec'), title: '恢复', color: '#7c5cff', pages: [] })
            target = nb.sections[0]
          }
          // id 冲突时重新分配，保证四层 id 唯一（数据完整性，不是旧格式兼容）
          if (allPages(d).some((p) => p.id === item.page.id)) item.page.id = uid('pg')
          for (const t of item.page.tabs) if (locateTab(d, t.id)) t.id = uid('tab')
          if (!item.page.tabs.length) item.page.tabs.push(blankTab(item.page.title))
          target.pages.unshift(item.page)
          d.trash.splice(idx, 1)
          d.ui.activeSectionId = target.id
          d.ui.activeNotebookId = d.notebooks.find((n) => n.sections.includes(target!))?.id ?? d.ui.activeNotebookId
          activateTabInData(d, item.page.tabs[0].id)
          pushRecent(d, item.page.id)
        }),
      purgeTrash: (trashId: string) =>
        withData((d) => {
          const idx = d.trash.findIndex((t) => t.id === trashId)
          if (idx < 0) return
          const [item] = d.trash.splice(idx, 1)
          dropPageAttachments(item.page)
        }),
      emptyTrash: () =>
        withData((d) => {
          const pages = d.trash.map((t) => t.page)
          d.trash = []
          pages.forEach(dropPageAttachments)
        }),

      getData: () => dataRef.current,
      touch: () => bump(),
    }
  }, [mutate, ready, saveState, saveError, lastSavedAt, flush, doSave])

  return api
}

export type Store = ReturnType<typeof useStore>
