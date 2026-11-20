/**
 * Jam 数据模型 v2 —— 四层内容结构（新版本，无历史兼容分支）
 *
 *   第 1 层  笔记本 Notebook   按「资料域 / 项目」分类；顺序 = notebooks[]；从属：根
 *   第 2 层  分区   Section    相当于磁盘，按「知识领域 / 项目阶段」分类；顺序 = notebook.sections[]；从属：笔记本
 *   第 3 层  页面   Page       相当于文件夹，按「具体主题 / 事项」分类；顺序 = section.pages[]；从属：分区
 *   第 4 层  页签   Tab        相当于文件，最小内容单元；顺序 = page.tabs[]；从属：页面
 *
 * 铁律：正文（content / md / mode）只存在于第 4 层 Tab。
 * 前三层只做组织与分类，没有任何正文入口；创建 / 编辑 / 删除正文一律落到某个具体 Tab。
 *
 * 顶部页签栏规则：只显示「当前中栏选中页面的页签」+「全库已收藏页签」；
 * 收藏页签不随中栏页面切换而消失，常驻顶部。favorite 是页签级字段，与页面级 favorite 无关。
 */

/** 空文档的标准形状（ProseMirror JSON） */
export interface Doc {
  type: 'doc'
  content: any[]
}

/** 第 4 层：页签（文件）。唯一承载并编辑正文的节点，同一页面下可开多个、彼此独立。 */
export interface Tab {
  id: string
  /** 页签显示名（创建时取页面标题，之后可独立重命名） */
  title: string
  createdAt: string
  /** 页签最后修改时间 */
  updatedAt: string
  /** 富文本内容，恒为合法 Doc（新建空白页签为单个空段落） */
  content: Doc
  /** Markdown 源码；富文本模式下也保留最近一次切换时的源码快照 */
  md: string
  /** 编辑模式：富文本 / Markdown 双栏 */
  mode: 'rich' | 'md'
  /** 收藏的页签常驻顶部，不随中栏选中页面切换而消失 */
  favorite: boolean
}

/** 第 3 层：页面（文件夹）。只组织页签，本身不承载正文。 */
export interface Page {
  id: string
  title: string
  updatedAt: string
  /** 该页面下的页签（第 4 层，正文唯一载体），恒为数组 */
  tabs: Tab[]
  /** 页面标签（不打标签时为空数组） */
  tags: string[]
  /** 收藏置顶 */
  favorite: boolean
}

/** 第 2 层：分区（磁盘）。按知识领域 / 项目阶段分类，从属于笔记本。 */
export interface Section {
  id: string
  title: string
  color: string
  pages: Page[]
}

/** 第 1 层：笔记本（根）。按资料域 / 项目分类，最高组织单位。 */
export interface Notebook {
  id: string
  title: string
  sections: Section[]
}

/** 回收站条目：删除页面时连同其下所有页签一起进入，还原时原样放回。 */
export interface TrashItem {
  id: string
  page: Page
  deletedAt: string
  notebookId: string
  notebookTitle: string
  sectionId: string
  sectionTitle: string
}

/**
 * 界面状态。
 *  - activePageId 是中栏「选中页面」的真相，也是顶部页签级联的来源：
 *    顶部只显示它的页签 + 全库收藏页签；切换中栏页面即切换顶部未收藏页签。
 *  - activeTabId 是编辑区的唯一真相，指向一个具体页签，可属于收藏常驻页签。
 *  - activeNotebookId / activeSectionId 是中栏「浏览上下文」，跟随 activePageId 定位。
 */
/** 系统皮肤：宣纸（默认）/ 工具台 / 夜墨。与 theme 明暗正交，样式的具体取值由 CSS 变量决定。 */
export type SkinId = 'paper' | 'workbench' | 'ink'

export interface UiState {
  activeTabId: string | null
  /** 中栏选中的页面 id；顶部页签集合由它级联（+ 收藏常驻页签） */
  activePageId: string | null
  /** 中栏浏览的笔记本 / 分区 */
  activeNotebookId: string | null
  activeSectionId: string | null
  theme: 'light' | 'dark'
  /** 系统皮肤；缺省按宣纸处理（旧数据兼容，不进严格必填列表） */
  skin?: SkinId
  sidebarWidth: number
  listWidth: number
  /** 正文内容区宽度（px）：0 = 自适应铺满可用宽度；>0 为固定宽度，超出可视区时横向滚动 */
  contentWidth: number
  /** 右侧大纲是否展开 */
  outlineOpen: boolean
  /** 中栏页面列表视图 */
  listView: 'section' | 'recent' | 'favorites'
  /** 中栏标签筛选（只过滤中栏列表，与顶部页签无关） */
  tagFilter: string | null
  /** 最近打开的页面 id（新的在前，最多 12 个） */
  recent: string[]
  /** Markdown 模式布局 */
  mdLayout: 'split' | 'source' | 'preview'
}

export interface Data {
  /** 数据格式版本；新版本固定为 2，加载时版本不符按损坏处理，用种子数据重建 */
  version: 2
  updatedAt: string
  notebooks: Notebook[]
  trash: TrashItem[]
  ui: UiState
}

export interface AppInfo {
  version: string
  dataDir: string
  dataFile: string
  backupDir: string
  isPackaged: boolean
  mode: string
}

export interface BackupItem {
  name: string
  size: number
  mtime: string
}

/** 附件归属到「页签」：正文载体是 Tab，图片随页签删除而清理。 */
export interface JamBridge {
  mode: string
  load: () => Promise<{ data: Data | null; firstRun: boolean; dataDir: string; corrupted?: boolean }>
  save: (json: string) => Promise<{ ok: boolean; at?: string; error?: string }>
  openFolder: (target?: 'data' | 'backups') => Promise<{ ok: boolean; dir?: string; error?: string }>
  backupNow: () => Promise<{ ok: boolean; name?: string; path?: string; size?: number; error?: string }>
  listBackups: () => Promise<BackupItem[]>
  restoreBackup: (name: string) => Promise<{ ok: boolean; data?: Data; error?: string }>
  exportFile: (payload: {
    defaultName: string
    content: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>
  openMarkdown: () => Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    name?: string
    content?: string
    encoding?: string
    size?: number
    error?: string
  }>
  copyText?: (text: string) => Promise<{ ok: boolean }>
  saveAttachment?: (payload: { tabId: string; name: string; dataUrl: string }) => Promise<{
    ok: boolean
    key?: string
    error?: string
  }>
  readAttachment?: (key: string) => Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  deleteAttachments?: (tabId: string) => Promise<{ ok: boolean }>
  appInfo: () => Promise<AppInfo>
  onBeforeQuit?: (cb: () => void) => () => void
  flushDone?: () => void
}

declare global {
  interface Window {
    jam?: JamBridge
  }
}

export const SECTION_COLORS = [
  '#b2372b',
  '#2f5d86',
  '#3f6b52',
  '#8a6320',
  '#5b4a86',
  '#6d6353',
  '#a33c2c',
  '#2f6e5e',
  '#7c4a2d',
]
