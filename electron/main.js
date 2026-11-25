'use strict'
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = fs.promises
const { createZip, readZip } = require('./zip')

const DATA_VERSION = 2
const BACKUP_KEEP = 10
const SMOKE = process.env.JAM_SMOKE === '1'

const BOOT_T0 = Date.now()
function bootMark(label) {
  if (process.env.JAM_PROFILE === '1') console.log(`[jam:start] ${label} +${Date.now() - BOOT_T0}ms`)
}

// 便携版：数据与 exe 同目录；开发期：项目根目录 /data
function resolveBaseDir() {
  if (!app.isPackaged) return path.join(__dirname, '..')
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR
  return path.dirname(app.getPath('exe'))
}

const BASE_DIR = resolveBaseDir()
const DATA_DIR = path.join(BASE_DIR, 'data')
const DATA_FILE = path.join(DATA_DIR, 'data.json')
const BACKUP_DIR = path.join(DATA_DIR, 'backups')
const ATTACH_DIR = path.join(DATA_DIR, 'attachments')

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
}

const MD_OPEN_FILTERS = [
  { name: 'Markdown 文档', extensions: ['md', 'markdown', 'mdown', 'txt'] },
  { name: '所有文件', extensions: ['*'] },
]
const MAX_MD_OPEN_BYTES = 20 * 1024 * 1024
let lastMarkdownDir = null
/** 冒烟测试注入的打开路径；非空时 file:open 跳过系统对话框 */
let smokeOpenPath = null

/** Buffer -> { text, encoding }：BOM 优先，UTF-8 严格解码失败再回退 GB18030 */
function decodeMarkdownText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString('utf8'), encoding: 'UTF-8 BOM' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.slice(2).toString('utf16le'), encoding: 'UTF-16LE' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const t = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = t
    }
    return { text: swapped.toString('utf16le'), encoding: 'UTF-16BE' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'UTF-8' }
  } catch (_) {
    let text
    try {
      text = new TextDecoder('gb18030').decode(buf)
    } catch (_2) {
      text = buf.toString('utf8')
    }
    return { text, encoding: 'GB18030' }
  }
}

function ensureDirs() {
  for (const dir of [DATA_DIR, BACKUP_DIR, ATTACH_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }
}

function safeFileName(name, ext) {
  let base = String(name || 'image').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(-60)
  if (!/\.[a-z0-9]+$/i.test(base)) base += ext || '.png'
  return base || 'image.png'
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 原子写：临时文件 -> fsync -> rename，避免半个文件 */
async function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await fsp.open(tmp, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, file)
  } catch (err) {
    // Windows 下目标被占用时的兜底
    await fsp.rm(file, { force: true })
    await fsp.rename(tmp, file)
  }
}

// ---------- 存档队列：串行化写入，杜绝并发写坏文件 ----------
let saveChain = Promise.resolve()
function queueSave(fn) {
  const next = saveChain.then(fn, fn)
  saveChain = next.catch(() => {})
  return next
}

async function readData() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8')
    const data = JSON.parse(raw)
    return { data, firstRun: false }
  } catch (err) {
    if (err.code === 'ENOENT') return { data: null, firstRun: true }
    // 损坏：把坏文件留档，交给前端用备份/空库继续
    try {
      await fsp.copyFile(DATA_FILE, `${DATA_FILE}.corrupt-${stamp()}`)
    } catch (_) {}
    return { data: null, firstRun: true, corrupted: true, error: String(err && err.message) }
  }
}

async function listBackups() {
  ensureDirs()
  const names = (await fsp.readdir(BACKUP_DIR)).filter((n) => n.endsWith('.zip'))
  const items = await Promise.all(
    names.map(async (name) => {
      const full = path.join(BACKUP_DIR, name)
      const st = await fsp.stat(full)
      return { name, size: st.size, mtime: st.mtime.toISOString() }
    })
  )
  items.sort((a, b) => (a.name < b.name ? 1 : -1))
  return items
}

async function pruneBackups() {
  const items = await listBackups()
  for (const item of items.slice(BACKUP_KEEP)) {
    await fsp.rm(path.join(BACKUP_DIR, item.name), { force: true })
  }
}

/** 收集 attachments/ 下全部文件（相对 ATTACH_DIR）；全程异步，不阻塞主进程 */
async function listAttachmentFiles() {
  const out = []
  if (!fs.existsSync(ATTACH_DIR)) return out
  const walk = async (dir, rel) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(full, r)
      } else {
        const st = await fsp.stat(full)
        out.push({ full, rel: r, size: st.size })
      }
    }
  }
  await walk(ATTACH_DIR, '')
  return out
}

async function createBackup(reason = 'manual') {
  ensureDirs()
  let payload
  try {
    payload = await fsp.readFile(DATA_FILE)
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, error: '还没有可备份的数据' }
    throw err
  }
  let stats = { pages: 0, images: 0 }
  try {
    const parsed = JSON.parse(payload.toString('utf8'))
    for (const nb of parsed.notebooks || []) {
      for (const sec of nb.sections || []) stats.pages += (sec.pages || []).length
    }
  } catch (_) {}

  const entries = [
    { name: 'data/data.json', data: payload },
  ]
  try {
    const files = await listAttachmentFiles()
    stats.images = files.length
    // 小批量并发读取：附件多时不会一次性占满内存，也不阻塞事件循环
    const CONCURRENCY = 8
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY)
      const buffers = await Promise.all(batch.map((f) => fsp.readFile(f.full)))
      batch.forEach((f, j) => entries.push({ name: `attachments/${f.rel}`, data: buffers[j] }))
    }
  } catch (_) {}

  const name = `jam-${stamp()}-${reason}.zip`
  const manifest = Buffer.from(
    JSON.stringify({ app: 'Jam', version: DATA_VERSION, createdAt: new Date().toISOString(), ...stats }, null, 2),
    'utf8'
  )
  entries.push({ name: 'manifest.json', data: manifest })
  const zip = createZip(entries)
  const target = path.join(BACKUP_DIR, name)
  await fsp.writeFile(target, zip)
  await pruneBackups()
  return { ok: true, name, path: target, size: zip.length }
}

async function restoreBackup(name) {
  ensureDirs()
  const safe = path.basename(String(name || ''))
  const full = path.join(BACKUP_DIR, safe)
  if (!fs.existsSync(full)) return { ok: false, error: '备份文件不存在' }
  // 覆盖前先把当前状态留一份
  await createBackup('pre-restore')
  const entries = readZip(await fsp.readFile(full))
  const entry = entries['data/data.json']
  if (!entry) return { ok: false, error: '备份中缺少 data.json' }
  const text = entry.toString('utf8')
  JSON.parse(text) // 校验可解析
  await queueSave(() => writeAtomic(DATA_FILE, text))
  // 还原 attachments/ 里的图片
  let images = 0
  const attachRoot = path.resolve(ATTACH_DIR)
  for (const [name2, data] of Object.entries(entries)) {
    if (!name2.startsWith('attachments/')) continue
    const rel = name2.slice('attachments/'.length)
    const target2 = path.resolve(ATTACH_DIR, rel)
    if (!target2.startsWith(attachRoot + path.sep)) continue
    await fsp.mkdir(path.dirname(target2), { recursive: true })
    await fsp.writeFile(target2, data)
    images += 1
  }
  if (images) console.log(`[Jam] 备份恢复：还原图片 ${images} 张`)
  return { ok: true, data: JSON.parse(text) }
}

async function dailyBackupIfNeeded() {
  try {
    const items = await listBackups()
    const today = dayKey()
    if (items.some((i) => i.name.startsWith(`jam-${today}`))) return
    if (!fs.existsSync(DATA_FILE)) return
    const res = await createBackup('daily')
    if (res.ok) console.log('[Jam] 今日自动备份:', res.name)
  } catch (err) {
    console.error('[Jam] 自动备份失败:', err)
  }
}

// ---------- 窗口 ----------
let mainWindow = null

function createWindow() {
  bootMark('createWindow:start')
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#ffffff',
    show: false,
    title: 'Jam',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html')
  if (!fs.existsSync(indexHtml)) {
    dialog.showErrorBox('未找到界面文件', `请先执行 npm run build。\n缺少：${indexHtml}`)
    app.quit()
    return
  }
  mainWindow.loadFile(indexHtml)
  bootMark('loadFile:called')
  mainWindow.once('ready-to-show', () => {
    bootMark('ready-to-show')
    mainWindow.show()
  })
  mainWindow.webContents.once('did-finish-load', () => bootMark('did-finish-load'))

  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (SMOKE || level >= 2) console.log(`[renderer:${level}]`, message)
  })

  if (!SMOKE) {
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url)
      return { action: 'deny' }
    })
  }

  // 关窗前给渲染进程一次落盘机会（最多等 1.5s）
  let allowClose = false
  mainWindow.on('close', (event) => {
    if (allowClose || SMOKE) return
    event.preventDefault()
    mainWindow.webContents.send('app:before-quit')
    const done = () => {
      allowClose = true
      clearTimeout(timer)
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close()
    }
    const timer = setTimeout(done, 1500)
    ipcMain.once('app:flush-done', done)
  })

  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      runSmoke(mainWindow.webContents).catch((err) => {
        console.error('[smoke] failed', err)
        app.exit(1)
      })
    })
  }
}

async function runSmoke(wc) {
  const fsp = require('fs').promises
  // 冒烟全程会改动真实数据（页签/卡片/拖拽），开始前留存原始 data.json 字节，
  // 结束时原样写回，确保用户数据不被测试污染（比各步骤各自还原更彻底）。
  let originalData = null
  try {
    originalData = await fsp.readFile(DATA_FILE)
  } catch (_) {}
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const shot = async (name) => {
    const img = await wc.capturePage()
    const out = path.join(__dirname, '..', name)
    await fsp.writeFile(out, img.toPNG())
    console.log(`[smoke] ${name} ok`)
  }
  const js = (code) => wc.executeJavaScript(code, true)

  await sleep(3500)
  await shot('smoke.png')

  // 1) Ctrl+K 搜索弹窗 + 输入关键词
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))`)
  await sleep(500)
  const typed = await js(`(() => {
    const i = document.querySelector('.search-input-row input')
    if (!i) return 'no-input'
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(i, '线程池')
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
  })()`)
  await sleep(800)
  const hitCount = await js(`document.querySelectorAll('.search-hit').length`)
  console.log(`[smoke] search: typed=${typed} hits=${hitCount}`)
  await shot('smoke-search.png')

  // 2) 回车跳转到命中页
  await js(`(() => { const h = document.querySelector('.search-hit'); if (h) h.click(); return !!h })()`)
  await sleep(700)

  // 3) 编辑器行为：代码块 Tab 缩进 / 回车继承缩进
  const editorTest = await js(`(() => {
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    let codePos = null
    ed.state.doc.descendants((n, p) => {
      if (n.type.name === 'codeBlock' && codePos === null) { codePos = p }
      return false
    })
    if (codePos === null) return { err: 'no codeblock' }
    const node = ed.state.doc.nodeAt(codePos)
    const endPos = codePos + node.nodeSize - 2
    ed.commands.setTextSelection(endPos)
    ed.view.focus()
    const before = node.textContent
    const dom = ed.view.dom
    const pressKey = (key, opts) => dom.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
    pressKey('Tab')
    const afterTab = ed.state.doc.nodeAt(codePos)?.textContent
    pressKey('Enter')
    const afterEnter = ed.state.doc.nodeAt(codePos)?.textContent
    return {
      beforeTail: JSON.stringify(before.slice(-20)),
      afterTabTail: JSON.stringify(afterTab.slice(-30)),
      afterEnterTail: JSON.stringify(afterEnter.slice(-40)),
      lang: node.attrs.language,
    }
  })()`)
  console.log('[smoke] editor:', JSON.stringify(editorTest))
  await sleep(400)
  await shot('smoke-editor.png')

  // 4) 主题切换
  await js(`(() => { const b = document.querySelector('.head-right .icon-btn[title*="深色"], .head-right .icon-btn[title*="浅色"]'); if (b) b.click(); return !!b })()`)
  await sleep(500)
  await shot('smoke-dark.png')
  // 切回浅色，后面按浅色验收
  await js(`(() => { const b = document.querySelector('.head-right .icon-btn[title*="深色"], .head-right .icon-btn[title*="浅色"]'); if (b) b.click(); return !!b })()`)
  await sleep(400)

  // 5) 粘贴 200 行 Java 进空代码块 -> 自动识别语言
  const pasteTest = await js(`(() => {
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const end = ed.state.doc.content.size
    ed.chain().focus().setTextSelection(end).splitBlock().setCodeBlock().run()
    let pos = null
    ed.state.doc.descendants((n, p) => { if (n.type.name === 'codeBlock') pos = p; return true })
    if (ed.state.doc.nodeAt(pos).content.size !== 0) return { err: 'block not empty' }
    const lines = []
    for (let i = 0; i < 197; i++) lines.push('    // line ' + i + ' demo of long paste')
    lines.push('public class SmokeTest {')
    lines.push('    public static void main(String[] args) { System.out.println("hi"); }')
    lines.push('}')
    const dt = new DataTransfer()
    dt.setData('text/plain', lines.join('\\n'))
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    ed.view.dom.dispatchEvent(ev)
    const node = ed.state.doc.nodeAt(pos)
    return { lang: node?.attrs.language, size: node?.content.size }
  })()`)
  console.log('[smoke] paste-detect:', JSON.stringify(pasteTest))
  await sleep(1500)
  await shot('smoke-paste.png')

  // 6) 代码块折叠 / 行号开关
  await js(`document.querySelector('.cb .cb-icon') ? (document.querySelector('.cb .cb-icon').click(), true) : false`)
  await sleep(500)
  const foldState = await js(`(() => {
    const cb = document.querySelector('.cb')
    if (!cb) return { err: 'no cb' }
    const body = cb.querySelector('.cb-body')
    return {
      collapsed: cb.getAttribute('data-collapsed'),
      display: body ? getComputedStyle(body).display : 'missing',
      count: cb.querySelector('.cb-count')?.textContent,
    }
  })()`)
  console.log('[smoke] fold:', JSON.stringify(foldState))
  await shot('smoke-fold.png')

  await js(`(() => { const b = document.querySelector('.cb .cb-actions .cb-btn'); if (b) b.click(); return !!b })()`)
  await sleep(450)
  const gutterState = await js(`(() => {
    const cb = document.querySelector('.cb')
    return { gutters: cb.querySelectorAll('.cb-gutter').length, off: !!cb.querySelector('.cb-btn.is-off') }
  })()`)
  console.log('[smoke] line-numbers-off:', JSON.stringify(gutterState))

  // 还原：展开 + 行号打开
  await js(`(() => {
    const cb = document.querySelector('.cb')
    if (!cb) return false
    if (cb.getAttribute('data-collapsed') === 'true') cb.querySelector('.cb-icon').click()
    const off = cb.querySelector('.cb-btn.is-off')
    if (off) off.click()
    return true
  })()`)
  await sleep(450)
  const restoreState = await js(`(() => {
    const cb = document.querySelector('.cb')
    return { collapsed: cb.getAttribute('data-collapsed'), gutters: cb.querySelectorAll('.cb-gutter').length }
  })()`)
  console.log('[smoke] fold-restore:', JSON.stringify(restoreState))

  // 7) 右侧大纲：条目数 + 点击跳转 + 当前章节高亮
  const outlineInfo = await js(`(() => {
    const items = [...document.querySelectorAll('.outline-item')]
    return { open: !!document.querySelector('.outline'), count: items.length, texts: items.slice(0, 5).map((i) => i.textContent) }
  })()`)
  console.log('[smoke] outline:', JSON.stringify(outlineInfo))
  await js(`(() => {
    const items = [...document.querySelectorAll('.outline-item')]
    const target = items[items.length - 1]
    if (!target) return false
    target.click()
    return true
  })()`)
  await sleep(1000)
  const outlineJump = await js(`(() => ({
    scrollTop: Math.round(document.querySelector('.editor-scroll')?.scrollTop || 0),
    active: document.querySelector('.outline-item.is-active')?.textContent || null,
  }))()`)
  console.log('[smoke] outline-jump:', JSON.stringify(outlineJump))
  await shot('smoke-outline.png')

  // 8) 页签级联 + 收藏常驻（中栏选中页面 → 顶部只显示该页面页签 + 全库收藏页签）
  //    a) 级联显示；b) 收藏页签跨页面常驻；c) 取消收藏后消失；d) 空页面空状态；e) 顶部加号；f) Ctrl+Tab；g) 关闭回退
  // 记录 A / B（两步不同页面，各有 1 个页签）
  await js(`(() => {
    const s = window.__store
    const pages = s.data.notebooks.flatMap(n=>n.sections).flatMap(s=>s.pages)
    window.__cascadeA = pages.find(p=>p.tabs.length)
    window.__cascadeB = pages.find(p=>p.tabs.length && p.id!==window.__cascadeA.id)
    s.selectPage(window.__cascadeA.id)
    return true
  })()`)
  await sleep(500)
  const titlesA = await js(`[...document.querySelectorAll('.tab-title')].map(t=>t.textContent)`)
  // 收藏 B 的页签，选中 A：B 页签应常驻
  await js(`(() => { const s=window.__store; s.toggleTabFavorite(window.__cascadeB.tabs[0].id); s.selectPage(window.__cascadeA.id); return true })()`)
  await sleep(500)
  const titlesWithFav = await js(`[...document.querySelectorAll('.tab-title')].map(t=>t.textContent)`)
  // 取消收藏：B 页签应从顶部消失
  await js(`(() => { const s=window.__store; s.toggleTabFavorite(window.__cascadeB.tabs[0].id); s.selectPage(window.__cascadeA.id); return true })()`)
  await sleep(500)
  const titlesNoFav = await js(`[...document.querySelectorAll('.tab-title')].map(t=>t.textContent)`)
  const cascade = await js(`(() => {
    const A = window.__cascadeA, B = window.__cascadeB
    const titlesA = ${JSON.stringify(titlesA)}
    const titlesWithFav = ${JSON.stringify(titlesWithFav)}
    const titlesNoFav = ${JSON.stringify(titlesNoFav)}
    const onlyA = titlesA.length === A.tabs.length
    const favPersists = titlesWithFav.includes(B.tabs[0].title) && titlesWithFav.length === A.tabs.length + 1
    const favGone = !titlesNoFav.includes(B.tabs[0].title)
    return { onlyA, favPersists, favGone, aTabs: A.tabs.length, withFav: titlesWithFav.length, titlesWithFav, titlesNoFav }
  })()`)

  // 空页面：造一个无页签页面并选中，顶部应无该页面页签、编辑区显示空状态
  const emptyPage = await js(`(() => {
    const s = window.__store
    const sec = s.data.notebooks.flatMap((n) => n.sections)[0]
    if (!sec) return { err: 'no section' }
    const pid = 'pg_empty_smoke'
    sec.pages.push({ id: pid, title: '空页面冒烟', updatedAt: new Date().toISOString(), tabs: [], tags: [], favorite: false })
    s.selectPage(pid)
    return { activeTabId: s.data.ui.activeTabId, activePageId: s.data.ui.activePageId }
  })()`)
  await sleep(500)
  const emptyUi = await js(`(() => ({
    tabCount: document.querySelectorAll('.tab').length,
    emptyTitle: document.querySelector('.empty-title')?.textContent || null,
  }))()`)

  // 顶部加号：在当前页面新建空白页签
  await js(`(() => { const b = document.querySelector('.tab-add'); if (b) b.click(); return !!b })()`)
  await sleep(500)
  const addViaPlus = await js(`(() => {
    const s = window.__store
    const p = s.data.notebooks.flatMap(n=>n.sections).flatMap(s=>s.pages).find(p=>p.id==='pg_empty_smoke')
    const t = p.tabs[0]
    return { count: p.tabs.length, blank: !!t && t.content.content.length === 1 && !t.content.content[0].content, active: s.data.ui.activeTabId === (t && t.id) }
  })()`)

  // 显式新建第二个页签（同一页面可多个，空白而非复制）
  const newTab = await js(`(() => {
    const store = window.__store
    const pid = store.data.ui.activePageId
    const page = store.data.notebooks.flatMap(n=>n.sections).flatMap(s=>s.pages).find(p=>p.id===pid)
    const firstLen = JSON.stringify((page.tabs[0] && page.tabs[0].content) || {}).length
    store.newTab(pid)
    const tabs = page.tabs
    const last = tabs[tabs.length - 1]
    const newLen = JSON.stringify(last.content || {}).length
    const newBlocks = (last.content && last.content.content || []).length
    const onlyEmptyPara = newBlocks === 1 && last.content.content[0].type === 'paragraph' && !last.content.content[0].content
    return { pid, count: tabs.length, firstLen, newLen, onlyEmptyPara, independent: last.id !== tabs[0].id }
  })()`)
  await sleep(500)
  const tabsAfterNew = await js(`document.querySelectorAll('.tab').length`)
  await shot('smoke-tabs.png')

  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }))`)
  await sleep(700)
  const afterCycle = await js(`(() => ({
    active: document.querySelector('.tab.is-active .tab-title')?.textContent || null,
    editorTitle: document.querySelector('.title-input')?.value || null,
  }))()`)

  await js(`(() => { const b = document.querySelector('.tab.is-active .tab-close'); if (b) b.click(); return !!b })()`)
  await sleep(700)
  const tabsClosed = await js(`(() => ({
    count: document.querySelectorAll('.tab').length,
    active: document.querySelector('.tab.is-active .tab-title')?.textContent || null,
    editorTitle: document.querySelector('.title-input')?.value || null,
  }))()`)
  console.log('[smoke] tabs:', JSON.stringify({ cascade, emptyPage, emptyUi, addViaPlus, newTab, tabsAfterNew, afterCycle, tabsClosed }))
  await shot('smoke-tabs-closed.png')

  // 清理冒烟专用空页面（避免污染后续步骤）
  await js(`(() => {
    const s = window.__store
    s.data.notebooks.forEach(n=>n.sections.forEach(sec=>{
      const i = sec.pages.findIndex(p=>p.id==='pg_empty_smoke')
      if (i>=0) sec.pages.splice(i,1)
    }))
    s.touch()
    return true
  })()`)
  await sleep(300)

  // 9) 标签 + 收藏 + 最近
  const tagSet = await js(`(() => {
    const store = window.__store
    if (!store) return { err: 'no store' }
    const pageId = store.data.ui.activePageId
    store.setPageTags(pageId, ['sql', '参考'])
    store.toggleFavorite(pageId)
    return { pageId }
  })()`)
  await sleep(900)
  const tagUi = await js(`(() => ({
    chips: [...document.querySelectorAll('.tag-chip')].map((c) => c.textContent),
    pageTags: [...document.querySelectorAll('.page-item .page-tag')].map((c) => c.textContent),
    star: !!document.querySelector('.page-item .page-star'),
  }))()`)
  await js(`(() => { const b = [...document.querySelectorAll('.vs-btn')][2]; if (b) b.click(); return !!b })()`)
  await sleep(450)
  const favView = await js(`(() => ({
    title: document.querySelector('.col-head.sub .col-title')?.textContent,
    items: document.querySelectorAll('.page-item').length,
  }))()`)
  await js(`(() => { const p = document.querySelector('.page-item'); if (p) p.click(); return !!p })()`)
  await sleep(600)
  const recentCount = await js(`window.__store.data.ui.recent.length`)
  await js(`(() => { const b = [...document.querySelectorAll('.vs-btn')][0]; if (b) b.click(); return !!b })()`)
  await sleep(300)
  await js(`(() => {
    const chip = [...document.querySelectorAll('.tag-chip')].find((c) => c.textContent === '#sql')
    if (chip) chip.click()
    return !!chip
  })()`)
  await sleep(450)
  const filtered = await js(`(() => ({
    items: document.querySelectorAll('.page-item').length,
    chipOn: document.querySelector('.tag-chip.is-on')?.textContent,
  }))()`)
  console.log('[smoke] tags:', JSON.stringify({ tagSet, tagUi, favView, recentCount, filtered }))
  await shot('smoke-tags.png')

  // 10) 图片粘贴：保存附件 -> 插入引用 -> 渲染 -> 备份包含附件
  const imgTest = await js(`(async () => {
    const store = window.__store
    if (!store) return { err: 'no store' }
    const tabId = store.data.ui.activeTabId
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#b2372b'
    ctx.fillRect(0, 0, 64, 64)
    const png = c.toDataURL('image/png')
    const res = await window.jam.saveAttachment({ tabId, name: 'smoke.png', dataUrl: png })
    if (!res.ok) return { err: res.error }
    const ed = window.__editor
    ed.chain().focus().insertContent({ type: 'image', attrs: { src: res.key, alt: 'smoke' } }).run()
    const ok = await new Promise((resolve) => {
      const started = Date.now()
      const timer = setInterval(() => {
        const img = document.querySelector('.ProseMirror .img-wrap img')
        if (img && img.complete && img.naturalWidth > 0) {
          clearInterval(timer)
          resolve({ rendered: true, natural: img.naturalWidth, src: img.src.slice(0, 30) })
        } else if (Date.now() - started > 4000) {
          clearInterval(timer)
          resolve({ rendered: !!img, natural: img ? img.naturalWidth : -1, src: img ? img.src.slice(0, 30) : '' })
        }
      }, 120)
    })
    const reread = await window.jam.readAttachment(res.key)
    return { key: res.key, ...ok, reread: reread && reread.ok ? 'ok:' + reread.dataUrl.slice(0, 22) : JSON.stringify(reread) }
  })()`)
  await sleep(1500)
  const probe = await js(`(() => {
    const img = document.querySelector('.ProseMirror .img-wrap img')
    return {
      html: img ? img.outerHTML.slice(0, 160) : null,
      broken: !!document.querySelector('.ProseMirror .img-broken'),
    }
  })()`)
  console.log('[smoke] image:', JSON.stringify({ ...imgTest, probe }))
  await sleep(1200)
  await shot('smoke-image.png')

  const backupRes = await createBackup('smoke')
  const backupEntries = backupRes.ok
    ? Object.keys(readZip(await fsp.readFile(backupRes.path))).filter((n) => n.startsWith('attachments/'))
    : []
  console.log('[smoke] backup:', JSON.stringify({ ok: backupRes.ok, name: backupRes.name, attachEntries: backupEntries }))

  // 清理：移除冒烟图片附件
  if (imgTest && imgTest.key) {
    const tabId = String(imgTest.key).slice(4).split('/')[0]
    await fsp.rm(path.join(ATTACH_DIR, tabId), { recursive: true, force: true })
  }

  // 12) Markdown 双栏：切换 -> 实时预览 -> 列表续行/缩进/加粗 -> 切回富文本
  const mdSeed = [
    '# Markdown 预览验收',
    '',
    '这是一段 **加粗**、*斜体*、`行内代码` 与 [链接](https://example.com) 混排的正文。',
    '',
    '## 二级标题',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '- [x] 已完成任务',
    '- [ ] 待办任务',
    '',
    '> 引用块测试',
    '',
    '```java',
    'public class MdDemo {',
    '    public static void main(String[] args) {',
    '        System.out.println("hello markdown");',
    '    }',
    '}',
    '```',
    '',
    '| 列 A | 列 B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '### 三级标题',
    '',
    '结尾段落。',
  ].join('\n')

  await js(`(() => { const b = document.querySelector('.head-right .icon-btn[title*="Markdown"]'); if (b) b.click(); return !!b })()`)
  await sleep(800)
  const mdSwitched = await js(`(() => ({
    pane: !!document.querySelector('.md-wrap'),
    bar: !!document.querySelector('.md-bar'),
    richHidden: (document.querySelector('.editor-body') || {}).style
      ? document.querySelector('.editor-body').style.display === 'none'
      : false,
  }))()`)

  const mdTyped = await js(`(() => {
    const ta = document.querySelector('.md-textarea')
    if (!ta) return { err: 'no textarea' }
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(mdSeed)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { chars: ta.value.length }
  })()`)
  await sleep(600)

  const mdPreview = await js(`(() => {
    const p = document.querySelector('.md-preview')
    if (!p) return { err: 'no preview' }
    return {
      h1: p.querySelectorAll('h1').length,
      h2: p.querySelectorAll('h2').length,
      h3: p.querySelectorAll('h3').length,
      strong: p.querySelectorAll('strong').length,
      table: p.querySelectorAll('table').length,
      task: p.querySelectorAll('input[type=checkbox]').length,
      codeBlocks: p.querySelectorAll('.md-cb').length,
      keywords: p.querySelectorAll('.md-cb .hljs-keyword').length,
      lang: (p.querySelector('.md-cb .cb-lang-static') || {}).textContent || null,
      outline: document.querySelectorAll('.md-outline .outline-item').length,
    }
  })()`)
  await shot('smoke-md.png')

  const mdKeys = await js(`(async () => {
    const ta = document.querySelector('.md-textarea')
    if (!ta) return { err: 'no textarea' }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const marker = '\\n- 列表项二'
    let at = ta.value.indexOf(marker)
    if (at < 0) return { err: 'marker missing' }
    at += marker.length
    ta.focus()
    ta.setSelectionRange(at, at)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await wait(260)
    const continued = ta.value.slice(at, at + 8)
    // 复原源码，避免续行产生的空列表项干扰后续断言
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    set.call(ta, ${JSON.stringify(mdSeed)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await wait(220)
    ta.setSelectionRange(ta.value.length, ta.value.length)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    await wait(260)
    const indented = JSON.stringify(ta.value.slice(ta.value.length - 4))
    const word = '混排'
    const wi = ta.value.indexOf(word)
    ta.setSelectionRange(wi, wi + word.length)
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }))
    await wait(260)
    return { continued: JSON.stringify(continued), indented, bold: ta.value.includes('**' + word + '**') }
  })()`)
  console.log('[smoke] markdown-draft:', JSON.stringify({ mdSwitched, mdTyped, mdPreview, mdKeys }))

  await js(`(() => { const b = document.querySelector('.head-right .icon-btn[title*="切回富文本"]'); if (b) b.click(); return !!b })()`)
  await sleep(1000)
  const mdConverted = await js(`(() => {
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const doc = ed.getJSON()
    const counts = { headings: 0, codeBlocks: 0, tasks: 0, tables: 0, strong: 0 }
    let lang = null
    const walk = (n) => {
      if (!n) return
      if (n.type === 'heading') counts.headings++
      if (n.type === 'codeBlock') { counts.codeBlocks++; lang = n.attrs && n.attrs.language }
      if (n.type === 'taskItem') counts.tasks++
      if (n.type === 'table') counts.tables++
      if (n.type === 'text' && (n.marks || []).some((m) => m.type === 'bold')) counts.strong++
      ;(n.content || []).forEach(walk)
    }
    walk(doc)
    const data = window.__store && window.__store.data
    let tab = null
    if (data) {
      for (const nb of data.notebooks) for (const sec of nb.sections) for (const p of sec.pages) {
        const t = (p.tabs || []).find((x) => x.id === data.ui.activeTabId)
        if (t) tab = t
      }
    }
    return {
      ...counts,
      lang,
      mode: tab && tab.mode,
      mdLen: tab && tab.md ? tab.md.length : 0,
      firstHeading: (doc.content || []).find((n) => n.type === 'heading')?.content?.[0]?.text || null,
    }
  })()`)
  console.log('[smoke] markdown:', JSON.stringify(mdConverted))
  await sleep(600)
  await shot('smoke-md-rich.png')
  await js(`window.__store && window.__store.flush()`)
  await sleep(800)

  // 12.5) 正文宽度：无 860px 上限、工具栏宽度浮层设定宽度后横向滚动；表格网格插入 + 动态增删行列
  await js(`(() => {
    const s = window.__store
    const pid = s.data.ui.activePageId
    s.newTab(pid)
    s.setUi({ contentWidth: 0 })
  })()`)
  await sleep(800)

  const layoutAuto = await js(`(() => {
    const pm = document.querySelector('.ProseMirror')
    const canvas = document.querySelector('.editor-canvas')
    const sc = document.querySelector('.editor-scroll')
    return {
      pmMax: pm ? getComputedStyle(pm).maxWidth : null,
      canvas: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
      client: sc ? sc.clientWidth : 0,
      overflowX: sc ? getComputedStyle(sc).overflowX : null,
      hasWidthBtn: !!document.querySelector('.tb-width-wrap .tb-btn'),
      hasOldHandle: !!document.querySelector('.width-handle'),
    }
  })()`)
  // 工具栏宽度浮层：点击按钮 -> 出现浮层 -> 点 1200 预设落盘；再开浮层用滑块微调
  const widthFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = document.querySelector('.tb-width-wrap .tb-btn')
    if (!btn) return { err: 'no width button' }
    btn.click()
    await wait(120)
    const popOpened = !!document.querySelector('.tb-width-pop')
    const presets = [...document.querySelectorAll('.tb-width-presets button')].map((b) => b.textContent)
    const slider = document.querySelector('.tb-width-slider input[type=range]')
    const p1200 = [...document.querySelectorAll('.tb-width-presets button')].find((b) => b.textContent === '1200')
    if (p1200) p1200.click()
    await wait(300)
    const afterPreset = window.__store.data.ui.contentWidth
    const popClosed = !document.querySelector('.tb-width-pop')
    // 滑块微调：重新打开并触发 change
    btn.click()
    await wait(120)
    const slider2 = document.querySelector('.tb-width-slider input[type=range]')
    if (slider2) {
      // React 受控组件：必须用原型 setter 赋值才能触发 onChange
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(slider2, '1400')
      slider2.dispatchEvent(new Event('input', { bubbles: true }))
      slider2.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await wait(250)
    const afterSlider = window.__store.data.ui.contentWidth
    return { popOpened, presets, hasSlider: !!slider, afterPreset, popClosed, afterSlider }
  })()`)

  await sleep(400)
  const layoutWide = await js(`(() => {
    const canvas = document.querySelector('.editor-canvas')
    const sc = document.querySelector('.editor-scroll')
    return {
      canvas: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
      client: sc ? sc.clientWidth : 0,
      scrollW: sc ? sc.scrollWidth : 0,
      overflowX: sc ? getComputedStyle(sc).overflowX : null,
    }
  })()`)
  await shot('smoke-wide.png')
  await js(`window.__store.setUi({ contentWidth: 0 })`)
  await sleep(500)
  console.log('[smoke] layout:', JSON.stringify({ layoutAuto, widthFlow, layoutWide }))

  const tableFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const btn = [...document.querySelectorAll('.toolbar .tb-btn')].find((b) => (b.title || '').includes('插入表格'))
    if (!btn) return { err: 'no table button' }
    btn.click()
    await wait(180)
    const cells = document.querySelectorAll('.tb-table-pop .tb-grid-cell')
    if (!cells.length) return { err: 'no grid' }
    const target = cells[(3 - 1) * 10 + (4 - 1)]
    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    await wait(120)
    const label = document.querySelector('.tb-table-label')?.textContent || null
    target.click()
    await wait(450)

    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const readTable = () => {
      let tbl = null
      const walk = (n) => {
        if (!n) return
        if (n.type === 'table' && !tbl) tbl = n
        ;(n.content || []).forEach(walk)
      }
      walk(ed.getJSON())
      return tbl ? { rows: tbl.content.length, cols: tbl.content[0] ? tbl.content[0].content.length : 0 } : null
    }
    const inserted = readTable()
    const firstCell = () => {
      let p = null
      ed.state.doc.descendants((node, pos) => {
        if (p !== null) return false
        const name = (node.type.name || '').toLowerCase()
        if (name.includes('cell') || name.includes('header')) { p = pos + 1; return false }
        return true
      })
      return p
    }
    const cp = firstCell()
    if (cp !== null) ed.chain().setTextSelection(cp).insertContent('哨兵').run()
    await wait(250)

    const ctxCount = document.querySelectorAll('.table-toolbar .tb-btn').length
    const rowBtn = [...document.querySelectorAll('.table-toolbar .tb-btn')].find((b) => (b.title || '').includes('下方插入行'))
    const colBtn = [...document.querySelectorAll('.table-toolbar .tb-btn')].find((b) => (b.title || '').includes('右侧插入列'))
    if (!rowBtn || !colBtn) return { err: 'no context buttons', inserted, ctxCount }
    if (cp !== null) ed.commands.setTextSelection(cp)
    await wait(150)
    rowBtn.click()
    await wait(280)
    const afterRow = readTable()
    const cp2 = firstCell()
    if (cp2 !== null) ed.commands.setTextSelection(cp2)
    await wait(150)
    const colBtn2 = [...document.querySelectorAll('.table-toolbar .tb-btn')].find((b) => (b.title || '').includes('右侧插入列'))
    if (colBtn2) colBtn2.click()
    await wait(280)
    const afterCol = readTable()
    const kept = JSON.stringify(ed.getJSON()).includes('哨兵')
    return {
      gridCount: cells.length, label, inserted, ctxCount, afterRow, afterCol, kept,
      rowsAdded: afterRow && inserted ? afterRow.rows === inserted.rows + 1 : false,
      colsAdded: afterCol && afterRow ? afterCol.cols === afterRow.cols + 1 : false,
    }
  })()`)
  await shot('smoke-table.png')
  console.log('[smoke] table:', JSON.stringify(tableFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  // 12.5b) 区域选中 / 缩放 / 样式编辑 / 矩阵粘贴
  const richFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const pm = document.querySelector('.ProseMirror')
    const findBtn = (sel, part) => [...document.querySelectorAll(sel)].find((b) => (b.title || '').includes(part))

    const findTableJson = () => {
      let table = null
      const walk = (n) => {
        if (!n || table) return
        if (n.type === 'table') { table = n; return }
        ;(n.content || []).forEach(walk)
      }
      walk(ed.getJSON())
      return table
    }
    const cellPos = (cell) => {
      if (!cell) return null
      const inner = cell.querySelector('p, div') || cell
      try { return ed.view.posAtDOM(inner, 0) } catch (_) { return null }
    }
    const firstCellPos = () => cellPos(document.querySelector('.ProseMirror table td, .ProseMirror table th'))
    const cellAttrs = () => {
      const t = findTableJson()
      const row = t && t.content.find((c) => c.type === 'tableRow')
      const cell = row && row.content.find((c) => /cell|header/i.test(c.type))
      return cell ? cell.attrs : null
    }

    // 对齐：光标落在首个单元格 -> 点击居中
    const cp = firstCellPos()
    if (cp === null) return { err: 'no cell' }
    ed.commands.setTextSelection(cp)
    await wait(120)
    const alignBtn = findBtn('.table-toolbar .tb-btn', '居中对齐')
    if (alignBtn) alignBtn.click()
    await wait(220)
    const alignAttrs = cellAttrs()

    // 区域选择：选区按钮 + Shift+方向键扩展 -> 观察 selectedCell 高亮
    ed.commands.setTextSelection(cp)
    await wait(100)
    const selectBtn = findBtn('.table-toolbar .tb-btn', '区域选择')
    if (selectBtn) selectBtn.click()
    await wait(120)
    pm.focus()
    pm.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }))
    await wait(200)
    const selectedCells = document.querySelectorAll('.ProseMirror table .selectedCell').length
    const selectionType = ed.state.selection.constructor.name

    // 合并 / 拆分
    const mergeBtn = findBtn('.table-toolbar .tb-btn', '合并选中单元格')
    if (mergeBtn && !mergeBtn.disabled) mergeBtn.click()
    await wait(220)
    const mergedAttrs = cellAttrs()
    const splitBtn = findBtn('.table-toolbar .tb-btn', '拆分选中单元格')
    if (splitBtn && !splitBtn.disabled) splitBtn.click()
    await wait(220)
    const splitAttrs = cellAttrs()

    // 整体宽度 / 行高
    const widthBtn = findBtn('.table-toolbar .tb-btn', '表格宽度 +80px')
    if (widthBtn) widthBtn.click()
    await wait(160)
    const rowBtn = findBtn('.table-toolbar .tb-btn', '行高 +8px')
    if (rowBtn) rowBtn.click()
    await wait(220)
    const sizeAttrs = cellAttrs()
    const tableWidth = findTableJson() ? findTableJson().attrs.width : 0

    // 矩阵粘贴：从最后一个单元格开始，3 行×3 列（含空行、多余空格）触发自动扩展
    const domCells = [...document.querySelectorAll('.ProseMirror table td, .ProseMirror table th')]
    const lastCell = domCells[domCells.length - 1]
    if (!lastCell) return { err: 'no dom cell', alignAttrs, selectedCells, selectionType }
    const lastPos = cellPos(lastCell)
    if (lastPos === null) return { err: 'no last cell pos', alignAttrs, selectedCells, selectionType }
    ed.commands.setTextSelection(lastPos)
    await wait(120)
    const beforeTable = findTableJson()
    const beforeRows = beforeTable ? beforeTable.content.filter((c) => c.type === 'tableRow').length : 0
    const dt = new DataTransfer()
    dt.setData('text/plain', 'a  b\\n\\nc   d   e')
    pm.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    await wait(500)
    const afterTable = findTableJson()
    const afterRows = afterTable ? afterTable.content.filter((c) => c.type === 'tableRow').length : 0
    const domRows = [...document.querySelectorAll('.ProseMirror table tr')].map((tr) =>
      [...tr.querySelectorAll('td, th')].map((td) => td.textContent.trim())
    )
    const tail = domRows.slice(-3)

    // 代码块：插入 -> 整块选中 -> 拖拽缩放
    const codeBtn = findBtn('.toolbar .tb-btn', '代码块 (Ctrl+Alt+C)')
    if (codeBtn) codeBtn.click()
    await wait(350)
    const selectCodeBtn = findBtn('.cb-actions .cb-btn', '选中整个代码块')
    if (selectCodeBtn) selectCodeBtn.click()
    await wait(150)
    const codeSelection = ed.state.selection.constructor.name
    const handle = document.querySelector('.cb-resize-handle')
    if (handle) {
      const r = handle.getBoundingClientRect()
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: r.left, clientY: r.top, button: 0, bubbles: true, cancelable: true,
      }))
      window.dispatchEvent(new PointerEvent('pointermove', {
        clientX: r.left + 120, clientY: r.top + 60, bubbles: true,
      }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    }
    await wait(300)
    let codeAttrs = null
    const walkCode = (n) => {
      if (!n || codeAttrs) return
      if (n.type === 'codeBlock') { codeAttrs = n.attrs; return }
      ;(n.content || []).forEach(walkCode)
    }
    walkCode(ed.getJSON())

    return {
      align: alignAttrs && alignAttrs.textAlign,
      selectedCells,
      selectionType,
      merged: mergedAttrs && (mergedAttrs.colspan || 1),
      split: splitAttrs && (splitAttrs.colspan || 1),
      tableWidth,
      rowHeight: sizeAttrs && sizeAttrs.rowHeight,
      rowsBefore: beforeRows,
      rowsAfter: afterRows,
      tail,
      codeSelection,
      codeSize: codeAttrs ? { width: codeAttrs.width, height: codeAttrs.height } : null,
    }
  })()`)
  await shot('smoke-rich-edit.png')
  console.log('[smoke] rich-edit:', JSON.stringify(richFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  // 12.5c) 对象控制框：整体选中 / 8 向缩放 / 拖拽移动 / 删除 / 双击进入编辑
  const objectFrameFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const pm = document.querySelector('.ProseMirror')
    const fire = (el, type, opts) => el.dispatchEvent(new MouseEvent(type, Object.assign({ bubbles: true, button: 0 }, opts)))
    const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: k }))
    const pointer = (el, type, opts) => el.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, button: 0 }, opts)))
    // 关掉上一步遗留的搜索弹窗，避免遮挡
    const searchMask = document.querySelector('.modal-mask.top')
    if (searchMask) searchMask.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wait(180)

    const selectCode = () => {
      const btn = [...document.querySelectorAll('.cb-actions .cb-btn')].find((b) => (b.title || '').includes('选中整个代码块'))
      if (btn) btn.click()
      return btn ? ed.state.selection.from : -1
    }
    const nodeWidthAt = (pos) => {
      const n = ed.state.doc.nodeAt(pos)
      return n && n.type.name === 'codeBlock' ? (n.attrs.width || 0) : 0
    }
    const codePos = () => {
      let p = -1
      ed.state.doc.descendants((node, pos) => { if (p < 0 && node.type.name === 'codeBlock') p = pos })
      return p
    }
    const cbCount = () => {
      let c = 0
      ed.state.doc.descendants((node) => { if (node.type.name === 'codeBlock') c++ })
      return c
    }

    // 0) 单击代码块正文：不再整体选中（整体选中只走「选中」按钮）
    const cbEl = document.querySelector('.ProseMirror .cb')
    if (cbEl) cbEl.scrollIntoView({ block: 'center' })
    await wait(160)
    ed.commands.setTextSelection(1)
    await wait(100)
    const codeInner = document.querySelector('.ProseMirror .cb .cb-pre code')
    let plainClickSel = null
    if (codeInner) {
      const rr = codeInner.getBoundingClientRect()
      const px = rr.left + Math.min(20, rr.width / 2), py = rr.top + 6
      fire(codeInner, 'mousedown', { clientX: px, clientY: py, detail: 1 })
      fire(codeInner, 'mouseup', { clientX: px, clientY: py, detail: 1 })
      await wait(150)
      plainClickSel = !!ed.state.selection.node ? 'NodeSelection' : 'TextSelection'
    }

    // 1) 点「选中」按钮 -> 代码块整体选中 -> 控制框出现（8 手柄 + 拖拽把手 + 删除按钮）
    const selectedPos = selectCode()
    await wait(220)
    const selAfterClick = ed.state.selection.constructor.name
    const frame = document.querySelector('.object-frame.of-codeBlock')
    const frameInfo = frame ? {
      handles: frame.querySelectorAll('.of-handle').length,
      hasDrag: !!frame.querySelector('.of-drag'),
      hasDelete: !!frame.querySelector('.of-delete'),
    } : null

    // 2) 拖拉右侧手柄 -> 宽度增加
    const widthBefore = nodeWidthAt(selectedPos)
    const eh = frame && frame.querySelector('.of-h-e')
    if (eh) {
      const hr = eh.getBoundingClientRect()
      pointer(eh, 'pointerdown', { clientX: hr.left + 5, clientY: hr.top + 5 })
      pointer(window, 'pointermove', { clientX: hr.left + 85, clientY: hr.top + 5 })
      pointer(window, 'pointerup', {})
      await wait(260)
    }
    const widthAfter = nodeWidthAt(selectedPos)

    // 3) 拖拽把手 -> 代码块整体移动到文档最前
    selectCode()
    await wait(160)
    const idxBefore = codePos()
    const drag = document.querySelector('.object-frame .of-drag')
    if (drag) {
      const dr = drag.getBoundingClientRect()
      const sx = dr.left + dr.width / 2, sy = dr.top + dr.height / 2
      const fy = pm.children[0].getBoundingClientRect().top + 2
      pointer(drag, 'pointerdown', { clientX: sx, clientY: sy })
      pointer(window, 'pointermove', { clientX: sx, clientY: fy })
      await wait(100)
      pointer(window, 'pointerup', { clientX: sx, clientY: fy })
      await wait(340)
    }
    const idxAfter = codePos()

    // 4) Delete 键整体删除
    selectCode()
    await wait(140)
    const selBeforeDel = ed.state.selection.constructor.name
    const before = cbCount()
    key(pm, 'Delete')
    await wait(260)
    const after = cbCount()
    const deleted = after === before - 1

    // 5) 表格悬浮三按钮（选中 / 插行 / 插列）+ 双击进入单元格编辑
    ed.commands.setTextSelection(1)
    await wait(120)
    const td = document.querySelector('.ProseMirror table td, .ProseMirror table th')
    let tableSel = null, tableFrame = false, dblSel = null
    let hoverBtns = 0, rowsBefore = 0, rowsAfter = 0, colsBefore = 0, colsAfter = 0
    if (td) {
      const tr = td.getBoundingClientRect()
      const tx = tr.left + 8, ty = tr.top + 8
      const hover = async () => {
        const t = document.querySelector('.ProseMirror table td, .ProseMirror table th')
        if (!t) return null
        const r = t.getBoundingClientRect()
        fire(t, 'mouseover', { clientX: r.left + 8, clientY: r.top + 8 })
        await wait(160)
        return document.querySelector('.table-hover-bar')
      }
      const gridCount = () => {
        let rows = 0, cols = 0
        ed.state.doc.descendants((node) => {
          if (node.type.name === 'table') {
            rows = node.childCount
            cols = node.firstChild ? node.firstChild.childCount : 0
            return false
          }
        })
        return { rows, cols }
      }
      fire(td, 'mouseover', { clientX: tx, clientY: ty })
      await wait(180)
      const bar = document.querySelector('.table-hover-bar')
      hoverBtns = bar ? bar.querySelectorAll('button').length : 0
      const g0 = gridCount()
      rowsBefore = g0.rows; colsBefore = g0.cols

      // 插行
      const rowBtn = bar && [...bar.querySelectorAll('button')].find((b) => (b.title || '').includes('插入行'))
      if (rowBtn) { rowBtn.click(); await wait(180) }
      const g1 = gridCount()
      // 插列（悬浮条重建后重新取按钮）
      const bar2 = await hover()
      const colBtn = bar2 && [...bar2.querySelectorAll('button')].find((b) => (b.title || '').includes('插入列'))
      if (colBtn) { colBtn.click(); await wait(180) }
      const g2 = gridCount()
      rowsAfter = g2.rows; colsAfter = g2.cols

      // 选中（悬浮条重建后重新取按钮）
      const bar3 = await hover()
      const selBtn = bar3 && [...bar3.querySelectorAll('button')].find((b) => (b.title || '').includes('选中整个表格'))
      if (selBtn) selBtn.click()
      await wait(200)
      tableSel = !!ed.state.selection.node ? 'NodeSelection' : 'TextSelection'
      tableFrame = !!document.querySelector('.object-frame.of-table')

      // 双击进入单元格编辑
      const td2 = document.querySelector('.ProseMirror table td, .ProseMirror table th')
      if (td2) {
        const r2 = td2.getBoundingClientRect()
        fire(td2, 'mousedown', { clientX: r2.left + 8, clientY: r2.top + 8, detail: 2 })
        fire(td2, 'dblclick', { clientX: r2.left + 8, clientY: r2.top + 8, detail: 2 })
        await wait(180)
        dblSel = !!ed.state.selection.node ? 'NodeSelection' : 'TextSelection'
      }
    }

    return {
      plainClickSel, selAfterClick, selectedPos, frameInfo,
      widthBefore, widthAfter, resized: widthAfter > widthBefore,
      idxBefore, idxAfter, moved: idxAfter !== idxBefore,
      selBeforeDel, deleted,
      hoverBtns, rowsBefore, rowsAfter, colsBefore, colsAfter,
      inserted: rowsAfter === rowsBefore + 1 && colsAfter === colsBefore + 1,
      tableSel, tableFrame, dblSel,
    }
  })()`)
  await shot('smoke-object-frame.png')
  console.log('[smoke] object-frame:', JSON.stringify(objectFrameFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  // 12.5d) 账号密码卡片：工具栏追加 / 字段编辑 / 密码显隐切换 / 图标状态同步
  const credentialFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const ed = window.__editor
    if (!ed) return { err: 'no editor' }
    const countCards = () => {
      let c = 0
      ed.state.doc.descendants((node) => { if (node.type.name === 'credentialCard') c++ })
      return c
    }
    const cardNode = () => {
      let n = null
      ed.state.doc.descendants((node) => { if (!n && node.type.name === 'credentialCard') n = node })
      return n
    }
    const setInput = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }

    const before = countCards()
    const btn = document.querySelector('.toolbar .tb-btn[title="追加账号密码卡片"]')
    if (!btn) return { err: 'no credential button' }
    btn.click()
    await wait(280)
    const after = countCards()
    const cardEl = document.querySelector('.ProseMirror .credential-card')
    const card = cardEl ? {
      fields: cardEl.querySelectorAll('.cc-input').length,
      eye: !!cardEl.querySelector('.cc-eye'),
      initialType: cardEl.querySelector('.cc-password')?.type || null,
      initialRevealed: cardEl.dataset.revealed,
      initialEyeLabel: cardEl.querySelector('.cc-eye')?.getAttribute('aria-label') || null,
      initialPressed: cardEl.querySelector('.cc-eye')?.getAttribute('aria-pressed') || null,
    } : null

    // 编辑三个字段（原生 setter 触发 React 受控输入）
    const inputs = cardEl ? [...cardEl.querySelectorAll('.cc-input')] : []
    if (inputs[0]) { setInput(inputs[0], '测试站点'); await wait(90) }
    if (inputs[1]) { setInput(inputs[1], 'tester@example.com'); await wait(90) }
    if (inputs[2]) { setInput(inputs[2], 's3cr3t'); await wait(90) }
    const saved = cardNode()?.attrs || null

    // 点眼睛 -> 明文 + 图标切换 + 状态同步
    const eye = cardEl && cardEl.querySelector('.cc-eye')
    if (eye) eye.click()
    await wait(180)
    const revealedCard = document.querySelector('.ProseMirror .credential-card')
    const revealed = revealedCard ? {
      type: revealedCard.querySelector('.cc-password')?.type || null,
      revealed: revealedCard.dataset.revealed,
      label: revealedCard.querySelector('.cc-eye')?.getAttribute('aria-label') || null,
      pressed: revealedCard.querySelector('.cc-eye')?.getAttribute('aria-pressed') || null,
      icon: revealedCard.querySelector('.cc-eye svg')?.getAttribute('class') || null,
      value: revealedCard.querySelector('.cc-password')?.value || null,
    } : null

    // 再点眼睛 -> 恢复圆点隐藏 + 图标状态回退
    const eye2 = revealedCard && revealedCard.querySelector('.cc-eye')
    if (eye2) eye2.click()
    await wait(180)
    const hiddenCard = document.querySelector('.ProseMirror .credential-card')
    const hidden = hiddenCard ? {
      type: hiddenCard.querySelector('.cc-password')?.type || null,
      revealed: hiddenCard.dataset.revealed,
      label: hiddenCard.querySelector('.cc-eye')?.getAttribute('aria-label') || null,
      pressed: hiddenCard.querySelector('.cc-eye')?.getAttribute('aria-pressed') || null,
      icon: hiddenCard.querySelector('.cc-eye svg')?.getAttribute('class') || null,
    } : null

    if (cardEl) cardEl.scrollIntoView({ block: 'center' })
    await wait(120)
    return {
      added: after === before + 1, before, after, card,
      saved: saved ? { name: saved.name, account: saved.account, password: saved.password } : null,
      revealed, hidden,
      toggledOn: revealed?.type === 'text' && revealed.revealed === 'true' && revealed.pressed === 'true' && (revealed.icon || '').includes('eye-off'),
      toggledOff: hidden?.type === 'password' && hidden.revealed === 'false' && hidden.pressed === 'false' && (hidden.icon || '').includes('eye') && !(hidden.icon || '').includes('eye-off'),
    }
  })()`)
  await shot('smoke-credential-card.png')
  console.log('[smoke] credential-card:', JSON.stringify(credentialFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(500)

  // 12.6) 左上角版本徽标 + 更新记录弹窗
  const versionInfo = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const badge = document.querySelector('.brand-row .version-badge')
    const label = badge ? badge.textContent.trim() : null
    if (!badge) return { err: 'no version badge', label }
    badge.click()
    await wait(300)
    const dlg = document.querySelector('.changelog')
    const res = {
      label,
      dialogOpen: !!dlg,
      current: document.querySelector('.changelog-now strong')?.textContent || null,
      versions: dlg ? [...dlg.querySelectorAll('.cl-ver')].map((n) => n.textContent) : [],
      itemCount: dlg ? dlg.querySelectorAll('.changelog-item').length : 0,
      changeCount: dlg ? dlg.querySelectorAll('.cl-list li').length : 0,
      latestTag: !!document.querySelector('.cl-tag'),
      currentMatchesCurrent: (document.querySelector('.changelog-now strong')?.textContent || '') === label,
    }
    window.__changelogCapture = res
    return res
  })()`)
  await shot('smoke-version.png')
  console.log('[smoke] version:', JSON.stringify(versionInfo))
  const versionClosed = await js(`(() => {
    const close = document.querySelector('.changelog .settings-head .icon-btn')
    if (close) close.click()
    return new Promise((r) => setTimeout(() => r(!document.querySelector('.changelog')), 200))
  })()`)
  console.log('[smoke] version-closed:', versionClosed)

  // 12.7) 回收站关闭：左下 toggle 进入/退出、面板返回按钮、Esc 关闭、弹窗优先级
  const trashFlow = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const foot = [...document.querySelectorAll('.foot-item')].find((b) => (b.textContent || '').includes('回收站'))
    if (!foot) return { err: 'no trash button' }
    const panel = () => document.querySelector('.col-list .col-title')?.textContent === '回收站'
    // 1) 点击进入
    foot.click()
    await wait(250)
    const openedByClick = panel()
    // 2) 再点一次（toggle）退出
    foot.click()
    await wait(250)
    const closedByToggle = !panel()
    // 3) 再次进入，用面板 X 返回
    foot.click()
    await wait(250)
    const backBtn = document.querySelector('.trash-head-actions .icon-btn')
    if (backBtn) backBtn.click()
    await wait(250)
    const closedByBack = !panel()
    // 4) 进入后按 Esc 退出
    foot.click()
    await wait(250)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(250)
    const closedByEsc = !panel()
    return { openedByClick, closedByToggle, closedByBack, closedByEsc, hasBackBtn: !!backBtn }
  })()`)
  console.log('[smoke] trash:', JSON.stringify(trashFlow))

  // 12.8) 打开本地 .md：工具栏图标 -> BOM/UTF-8 与 GB18030 解码 -> 新建 md 页签；失败提示
  const os = require('os')
  const iconv = require('iconv-lite')
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jam-md-'))
  const bomFile = path.join(tmpDir, 'bom-note.md')
  const gbkFile = path.join(tmpDir, 'gbk-note.md')
  await fsp.writeFile(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM 标题\n\n第一行内容', 'utf8')]))
  await fsp.writeFile(gbkFile, iconv.encode('# GBK 标题\n\n中文正文内容', 'gb18030'))
  // 确保有选中页面，打开按钮才有落点
  await js(`(() => { const s=window.__store, d=s.data; if(!d.ui.activePageId){ const p=d.notebooks[0].sections[0].pages[0]; if(p) s.selectPage(p.id) } return true })()`)
  const clickOpenBtn = `(() => {
    const btn = [...document.querySelectorAll('.head-right .icon-btn')].find(b => (b.title||'').includes('打开本地 Markdown'))
    if (!btn) return false
    btn.click()
    return true
  })()`
  const readActiveTab = `(() => {
    const d = window.__store.data
    for (const n of d.notebooks) for (const s of n.sections) for (const p of s.pages) {
      const t = p.tabs.find(x => x.id === d.ui.activeTabId)
      if (t) return { title: t.title, mode: t.mode, firstChar: (t.md||'').charCodeAt(0), md: (t.md||'').slice(0, 80) }
    }
    return null
  })()`

  smokeOpenPath = bomFile
  const openBtnFound = await js(clickOpenBtn)
  await sleep(1100)
  const bomResult = await js(readActiveTab)

  smokeOpenPath = gbkFile
  await js(clickOpenBtn)
  await sleep(1100)
  const gbkResult = await js(readActiveTab)

  // 失败场景：路径是目录 -> 主进程返回非文件错误 -> toast-error
  smokeOpenPath = tmpDir
  const tabsBeforeFail = await js(`(() => { const d=window.__store.data; let n=0; for(const nb of d.notebooks) for(const s of nb.sections) for(const p of s.pages) n+=p.tabs.length; return n })()`)
  await js(clickOpenBtn)
  await sleep(600)
  const failFlow = await js(`(() => {
    const toast = [...document.querySelectorAll('.toast-error')].map(n => n.textContent).join(' | ')
    const d = window.__store.data
    let n = 0
    for(const nb of d.notebooks) for(const s of nb.sections) for(const p of s.pages) n += p.tabs.length
    return { toast, tabs: n }
  })()`)
  smokeOpenPath = null
  const openMdFlow = {
    openBtnFound,
    bom: bomResult,
    gbk: gbkResult,
    failToast: failFlow.toast,
    tabsUnchangedOnFail: failFlow.tabs === tabsBeforeFail,
  }
  await shot('smoke-open-md.png')
  console.log('[smoke] open-md:', JSON.stringify(openMdFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(500)
  await fsp.rm(tmpDir, { recursive: true, force: true })

  // 12.9) 系统皮肤：宣纸/工具台/夜墨切换，验证 dataset + 关键变量 + 设置弹窗选中态，切回宣纸恢复默认
  const readSkin = `(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      skin: document.documentElement.dataset.skin || 'paper',
      theme: document.documentElement.dataset.theme || 'light',
      bg: cs.getPropertyValue('--bg').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
    }
  })()`
  const paperSkin = await js(readSkin)

  // 工具台：推荐浅色，强调色应为信号蓝
  const workbenchSkin = await js(`(async () => {
    const s = window.__store
    s.setUi({ skin: 'workbench', theme: 'light' })
    await new Promise(r => setTimeout(r, 200))
    const cs = getComputedStyle(document.documentElement)
    return { skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme,
      bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() }
  })()`)
  await shot('smoke-skin-workbench.png')

  // 夜墨：推荐深色，强调色应为暖铜
  const inkSkin = await js(`(async () => {
    const s = window.__store
    s.setUi({ skin: 'ink', theme: 'dark' })
    await new Promise(r => setTimeout(r, 200))
    const cs = getComputedStyle(document.documentElement)
    return { skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme,
      bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() }
  })()`)
  await shot('smoke-skin-ink.png')

  // 设置弹窗：皮肤分段选中态跟随 store，明暗仍可独立切换
  const skinDialog = await js(`(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms))
    const settingsBtn = [...document.querySelectorAll('.head-right .icon-btn')].find(b => (b.title || '') === '设置')
    if (settingsBtn) settingsBtn.click()
    await wait(300)
    const settings = document.querySelector('.settings')
    if (!settings) return { err: 'no settings dialog' }
    const seg = [...document.querySelectorAll('.seg-skin button')]
    const labels = seg.map(b => b.textContent.trim())
    const active = seg.find(b => b.classList.contains('is-on'))?.textContent.trim() || null
    // 切明暗不应改变皮肤
    const themeBtns = [...document.querySelectorAll('.seg:not(.seg-skin) button')]
    const dark = themeBtns.find(b => b.textContent.trim() === '深色')
    if (dark) dark.click()
    await wait(150)
    const skinAfterTheme = document.documentElement.dataset.skin
    const close = document.querySelector('.settings-head .icon-btn')
    if (close) close.click()
    return { labels, active, skinAfterTheme }
  })()`)

  // 切回宣纸 + 浅色：变量应与最初完全一致（默认皮肤零影响）
  const restoredSkin = await js(`(async () => {
    const s = window.__store
    s.setUi({ skin: 'paper', theme: 'light' })
    await new Promise(r => setTimeout(r, 200))
    const cs = getComputedStyle(document.documentElement)
    return { skin: document.documentElement.dataset.skin, theme: document.documentElement.dataset.theme,
      bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() }
  })()`)
  const skinFlow = {
    paper: paperSkin,
    workbench: workbenchSkin,
    ink: inkSkin,
    dialog: skinDialog,
    restored: restoredSkin,
    restoredDefault:
      restoredSkin.skin === paperSkin.skin && restoredSkin.bg === paperSkin.bg && restoredSkin.accent === paperSkin.accent,
    distinctAccents: workbenchSkin.accent !== paperSkin.accent && inkSkin.accent !== paperSkin.accent,
  }
  console.log('[smoke] skins:', JSON.stringify(skinFlow))

  // 13) 新模型不变量：正文只在第 4 层页签；前三层级只组织不存正文
  const model = await js(`(() => {
    const d = window.__store.data
    let pages = 0, tabs = 0
    const bad = []
    for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) {
      pages++
      if ('content' in p || 'md' in p || 'mode' in p) bad.push('page-has-body:' + p.id)
      if (!Array.isArray(p.tabs)) bad.push('tabs-not-array:' + p.id)
      if (!Array.isArray(p.tags)) bad.push('tags-not-array:' + p.id)
      if (typeof p.favorite !== 'boolean') bad.push('favorite-not-bool:' + p.id)
      for (const t of p.tabs) {
        tabs++
        if (!t.content || t.content.type !== 'doc') bad.push('tab-bad-content:' + t.id)
        if (typeof t.md !== 'string') bad.push('tab-bad-md:' + t.id)
        if (['rich','md'].indexOf(t.mode) < 0) bad.push('tab-bad-mode:' + t.id)
        if (typeof t.favorite !== 'boolean') bad.push('tab-bad-favorite:' + t.id)
      }
    }
    return { version: d.version, pages, tabs, bad }
  })()`)
  console.log('[smoke] model:', JSON.stringify(model))

  // 14) 边界条件：页签上限淘汰 + 关闭激活页签后激活态回退（不悬空）
  const boundary = await js(`(() => {
    const s = window.__store
    const d = s.data
    let page = null
    for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) {
      if (!page && p.tabs.length) page = p
    }
    if (!page) return { err: 'no page with tabs' }
    const pid = page.id
    for (let i = 0; i < 20; i++) s.newTab(pid)
    const count = page.tabs.length
    s.activateTab(page.tabs[0].id)
    const before = d.ui.activeTabId
    s.closeTab(before)
    const after = d.ui.activeTabId
    let found = false
    for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) {
      if (p.tabs.some((t) => t.id === after)) found = true
    }
    return { capped: count <= 12, count, closedActive: before === after ? false : true, afterValid: !!after && found }
  })()`)
  console.log('[smoke] boundary:', JSON.stringify(boundary))
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  // 15) 拖拽迁移：分区/页面/页签的同级排序与跨容器迁移 + 非法拖拽拦截
  const dragFlow = await js(`(() => {
    const s = window.__store
    const d = s.data
    // 快照：冒烟结束后把结构原位还原，避免污染用户真实数据
    window.__dragSnapshot = JSON.stringify(d.notebooks)
    window.__dragUi = JSON.stringify(d.ui)
    const findSection = (id) => { for (const nb of d.notebooks) { const i = nb.sections.findIndex((x) => x.id === id); if (i >= 0) return { nb, i, sec: nb.sections[i] } } return null }
    const findPage = (id) => { for (const nb of d.notebooks) for (const sec of nb.sections) { const i = sec.pages.findIndex((x) => x.id === id); if (i >= 0) return { nb, sec, i, page: sec.pages[i] } } return null }
    const findTab = (id) => { for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) { const i = p.tabs.findIndex((t) => t.id === id); if (i >= 0) return { nb, sec, page: p, i, tab: p.tabs[i] } } return null }
    const order = (id) => { const l = findSection(id); return l ? l.nb.sections.map((s) => s.id) : [] }
    const pageOrder = (sid) => { const l = findSection(sid); return l ? l.sec.pages.map((p) => p.id) : [] }
    const tabOrder = (pid) => { const l = findPage(pid); return l ? l.page.tabs.map((t) => t.id) : [] }
    const res = {}

    // 1) 分区同级排序：第一个分区拖到末尾之后
    const nbs = d.notebooks.filter((n) => n.sections.length >= 2)
    if (nbs.length) {
      const nb = nbs[0]
      const before = nb.sections.map((s) => s.id)
      const moved = s.moveNode({ type: 'section', id: before[0] }, { kind: 'notebook', id: nb.id, index: before.length })
      const after = findSection(before[0])
      res.sectionReorder = { moved, toEnd: !!after && after.i === before.length - 1, sameCount: nb.sections.length === before.length }
    } else res.sectionReorder = { skip: true }

    // 2) 分区跨笔记本：把某笔记本的第一个分区迁到另一个笔记本
    if (d.notebooks.length >= 2) {
      // 至少保留 1 个分区在源笔记本，避免清空导致后续冒烟步骤（依赖有分区）失败
      const from = d.notebooks.find((n) => n.sections.length >= 2)
      const to = d.notebooks.find((n) => n.id !== from?.id)
      if (from && to) {
        const sid = from.sections[0].id
        const moved = s.moveNode({ type: 'section', id: sid }, { kind: 'notebook', id: to.id, index: 0 })
        const loc = findSection(sid)
        res.sectionCross = { moved, inTarget: !!loc && loc.nb.id === to.id, atHead: !!loc && loc.i === 0 }
      }
    } else res.sectionCross = { skip: true }

    // 3) 页面跨分区：找两个分区，各取一个页面A、B，把 A 迁到 B 所在分区
    {
      let src = null, dst = null
      for (const nb of d.notebooks) for (const sec of nb.sections) {
        if (!src && sec.pages.length >= 1) src = sec
        else if (src && sec.id !== src.id && !dst && sec.pages.length >= 0) dst = sec
      }
      if (src && dst) {
        const pid = src.pages[0].id
        const moved = s.moveNode({ type: 'page', id: pid }, { kind: 'section', id: dst.id, index: 0 })
        const loc = findPage(pid)
        res.pageCross = { moved, inTarget: !!loc && loc.sec.id === dst.id, atHead: !!loc && loc.i === 0 }
      } else res.pageCross = { skip: true }
    }

    // 4) 页签跨页面：找两个各有页签的页面，把 A 的首个页签迁到 B
    {
      let pa = null, pb = null
      for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) {
        if (!pa && p.tabs.length >= 2) pa = p
        else if (pa && p.id !== pa.id && !pb) pb = p
      }
      if (pa && pb) {
        const tid = pa.tabs[0].id
        const moved = s.moveNode({ type: 'tab', id: tid }, { kind: 'page', id: pb.id, index: pb.tabs.length })
        const loc = findTab(tid)
        res.tabCross = { moved, inTarget: !!loc && loc.page.id === pb.id, atEnd: !!loc && loc.i === loc.page.tabs.length - 1, keptActive: d.ui.activeTabId === tid }
      } else res.tabCross = { skip: true }
    }

    // 5) 页签同页排序：把目标页面的第一个页签拖到末尾
    {
      const withTabs = []
      for (const nb of d.notebooks) for (const sec of nb.sections) for (const p of sec.pages) if (p.tabs.length >= 2) withTabs.push(p)
      const p = withTabs[0]
      if (p) {
        const before = p.tabs.map((t) => t.id)
        const moved = s.moveNode({ type: 'tab', id: before[0] }, { kind: 'page', id: p.id, index: before.length })
        const after = tabOrder(p.id)
        res.tabReorder = { moved, toEnd: after[after.length - 1] === before[0], sameCount: after.length === before.length }
      } else res.tabReorder = { skip: true }
    }

    // 6) 非法拖拽：页签拖到笔记本 / 页面拖到笔记本 / 分区拖到页面 —— 全部拦截且数据不变
    {
      const nb = d.notebooks[0]
      const snapshot = JSON.stringify(d.notebooks.map((n) => n.sections.map((s) => [s.id, s.pages.map((p) => [p.id, p.tabs.map((t) => t.id)])])))
      const anyTab = (() => { for (const n of d.notebooks) for (const sec of n.sections) for (const p of sec.pages) if (p.tabs[0]) return p.tabs[0].id; return null })()
      const anyPage = (() => { for (const n of d.notebooks) for (const sec of n.sections) if (sec.pages[0]) return sec.pages[0].id; return null })()
      const anySection = nb?.sections[0]?.id
      const r1 = s.moveNode({ type: 'tab', id: anyTab }, { kind: 'notebook', id: nb.id, index: 0 })
      const r2 = s.moveNode({ type: 'page', id: anyPage }, { kind: 'notebook', id: nb.id, index: 0 })
      const r3 = s.moveNode({ type: 'section', id: anySection }, { kind: 'page', id: anyPage, index: 0 })
      const after = JSON.stringify(d.notebooks.map((n) => n.sections.map((sec) => [sec.id, sec.pages.map((p) => [p.id, p.tabs.map((t) => t.id)])])))
      res.illegal = { rejected: r1 === false && r2 === false && r3 === false, unchanged: after === snapshot }
    }

    return res
  })()`)
  console.log('[smoke] drag:', JSON.stringify(dragFlow))
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  // 15b) DOM 级拖拽：合成 dragstart/dragover/drop，确认事件链真正触发迁移与插入线
  const dragDom = await js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const s = window.__store
    const tabs = [...document.querySelectorAll('.tab')]
    if (tabs.length < 2) return { err: 'not enough tabs', count: tabs.length }
    const src = tabs[0], dst = tabs[1]
    const aId = src.getAttribute('data-tab-id'), bId = dst.getAttribute('data-tab-id')
    const d = s.data
    const locate = (id) => {
      for (const n of d.notebooks) for (const sec of n.sections) for (const p of sec.pages) {
        const idx = p.tabs.findIndex((t) => t.id === id)
        if (idx >= 0) return { p, idx }
      }
      return null
    }
    const a = locate(aId), b = locate(bId)
    if (!a || !b) return { err: 'cannot resolve tabs', aId, bId }

    const dt = new DataTransfer()
    const fire = (el, type, cx, cy) => {
      const ev = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy })
      el.dispatchEvent(ev)
      return ev
    }
    const pageBefore = b.p.id
    const samePageBefore = a.p.id === b.p.id
    fire(src, 'dragstart', 0, 0)
    const r = dst.getBoundingClientRect()
    const over = fire(dst, 'dragover', r.left + 2, r.top + 2)
    await wait(100)
    const hintShown = dst.className.includes('is-drop-before') || dst.className.includes('is-drop-after')
    fire(dst, 'drop', r.left + 2, r.top + 2)
    await wait(320)
    fire(src, 'dragend', 0, 0)
    await wait(120)

    const after = locate(aId)
    // 插在 b 之前：目标位 = b.idx；若原本同数组且在 b 之前，删除源后修正为 b.idx - 1
    const expectIdx = Math.max(0, b.idx - (samePageBefore && a.idx < b.idx ? 1 : 0))
    return {
      aId, bId, pageBefore, prevented: over.defaultPrevented,
      hintShown, movedToDstPage: !!after && after.p.id === pageBefore,
      atExpected: !!after && after.idx === expectIdx, expectIdx,
      afterIdx: after ? after.idx : null,
    }
  })()`)
  console.log('[smoke] drag-dom:', JSON.stringify(dragDom))
  // 把拖拽测试期间的结构改动原位还原，避免污染用户数据
  const dragRestored = await js(`(() => {
    const s = window.__store
    const d = s.data
    const snap = window.__dragSnapshot
    if (!snap) return false
    const notebooks = JSON.parse(snap)
    d.notebooks.length = 0
    for (const n of notebooks) d.notebooks.push(n)
    const ui = JSON.parse(window.__dragUi)
    for (const k of Object.keys(d.ui)) delete d.ui[k]
    Object.assign(d.ui, ui)
    // 必须经 mutate 标记 dirty，否则 store.flush() 因 dirtyRef=false 直接跳过写盘
    s.setUi({})
    return true
  })()`)
  console.log('[smoke] drag-restored:', dragRestored)
  await js(`window.__store && window.__store.flush()`)
  await sleep(600)

  await sleep(1200)
  // 冒烟结束：把测试期间对真实数据的所有改动原样写回。
  // app.exit(0) 是强退且不触发 before-quit 的 flush，因此这里的写回就是磁盘最终状态。
  if (originalData) {
    try {
      await fsp.writeFile(DATA_FILE, originalData)
      console.log('[smoke] data-restored: true')
    } catch (e) {
      console.log('[smoke] data-restored: false', e && e.message)
    }
  }
  console.log('[smoke] done')
  app.exit(0)
}

function buildMenu() {
  const template = [
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------- IPC ----------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  dataDir: DATA_DIR,
  dataFile: DATA_FILE,
  backupDir: BACKUP_DIR,
  isPackaged: app.isPackaged,
  mode: 'electron',
}))

ipcMain.handle('data:load', async () => {
  ensureDirs()
  const res = await readData()
  return { ...res, dataDir: DATA_DIR }
})

ipcMain.handle('data:save', async (_e, json) => {
  if (typeof json !== 'string' || json.length < 2) return { ok: false, error: '内容为空' }
  if (json.length > 200 * 1024 * 1024) return { ok: false, error: '数据超过 200MB' }
  try {
    JSON.parse(json)
  } catch (err) {
    return { ok: false, error: 'JSON 解析失败，已阻止写入' }
  }
  return queueSave(async () => {
    ensureDirs()
    await writeAtomic(DATA_FILE, json)
    return { ok: true, at: new Date().toISOString() }
  }).catch((err) => ({ ok: false, error: String(err && err.message) }))
})

ipcMain.handle('folder:open', async (_e, target) => {
  ensureDirs()
  const dir = target === 'backups' ? BACKUP_DIR : DATA_DIR
  const res = await shell.openPath(dir)
  return { ok: !res, error: res || undefined, dir }
})

ipcMain.handle('backup:create', async () => createBackup('manual'))
ipcMain.handle('backup:list', async () => listBackups())
ipcMain.handle('backup:restore', async (_e, name) => restoreBackup(name))

// ---------- 附件（图片） ----------
ipcMain.handle('attachment:save', async (_e, payload) => {
  try {
    const { tabId, name, dataUrl } = payload || {}
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(tabId || ''))) return { ok: false, error: '页签标识不合法' }
    const m = /^data:(image\/[a-z0-9.+]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''))
    if (!m) return { ok: false, error: '不是有效的图片数据' }
    const buf = Buffer.from(m[2], 'base64')
    if (buf.length === 0) return { ok: false, error: '图片内容为空' }
    if (buf.length > 20 * 1024 * 1024) return { ok: false, error: '单张图片不能超过 20MB' }
    const dir = path.join(ATTACH_DIR, String(tabId))
    await fsp.mkdir(dir, { recursive: true })
    const ext = `.${m[1].split('/')[1].split('+')[0]}`
    const fname = `${Date.now()}-${safeFileName(name, ext)}`
    await fsp.writeFile(path.join(dir, fname), buf)
    return { ok: true, key: `att:${tabId}/${fname}` }
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
})

ipcMain.handle('attachment:read', async (_e, key) => {
  try {
    const k = String(key || '')
    if (!k.startsWith('att:')) return { ok: false, error: '图片引用不合法' }
    const full = path.resolve(ATTACH_DIR, k.slice(4))
    const root = path.resolve(ATTACH_DIR)
    if (!full.startsWith(root + path.sep)) return { ok: false, error: '路径不合法' }
    if (!fs.existsSync(full)) return { ok: false, error: '图片文件不存在' }
    const buf = await fsp.readFile(full)
    const mime = IMAGE_MIME[path.extname(full).toLowerCase()] || 'application/octet-stream'
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
})

ipcMain.handle('attachment:delete', async (_e, tabId) => {
  try {
    const id = String(tabId || '')
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) return { ok: true }
    await fsp.rm(path.join(ATTACH_DIR, id), { recursive: true, force: true })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
})

ipcMain.handle('file:open', async () => {
  try {
    const res = smokeOpenPath
      ? { canceled: false, filePaths: [smokeOpenPath] }
      : await dialog.showOpenDialog(mainWindow, {
          title: '打开 Markdown 文档',
          defaultPath: lastMarkdownDir || app.getPath('documents'),
          filters: MD_OPEN_FILTERS,
          properties: ['openFile'],
        })
    if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true }
    const filePath = res.filePaths[0]
    const st = await fsp.stat(filePath)
    if (!st.isFile()) return { ok: false, error: '所选路径不是文件' }
    if (st.size > MAX_MD_OPEN_BYTES) return { ok: false, error: '文件超过 20MB，无法打开' }
    const buf = await fsp.readFile(filePath)
    const { text, encoding } = decodeMarkdownText(buf)
    if (text.includes('\u0000')) return { ok: false, error: '文件不是有效的文本内容' }
    const content = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
    if (!smokeOpenPath) lastMarkdownDir = path.dirname(filePath)
    return {
      ok: true,
      path: filePath,
      name: path.basename(filePath, path.extname(filePath)),
      content,
      encoding,
      size: st.size,
    }
  } catch (err) {
    return { ok: false, error: String(err && err.message) }
  }
})

ipcMain.handle('file:export', async (_e, payload) => {
  const { defaultName = 'note.txt', content = '', filters } = payload || {}
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }
  await fsp.writeFile(res.filePath, content, 'utf8')
  return { ok: true, path: res.filePath }
})

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text || ''))
  return { ok: true }
})

app.whenReady().then(() => {
  bootMark('app:ready')
  ensureDirs()
  buildMenu()
  createWindow()

  // 每日备份不参与窗口启动：等窗口显示后再后台执行，避免首屏被 zip 操作卡住
  if (!SMOKE && mainWindow) {
    mainWindow.once('ready-to-show', () => {
      setTimeout(() => {
        void dailyBackupIfNeeded()
      }, 200)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // 给渲染进程最后一次落盘机会
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('app:before-quit')
    } catch (_) {}
  }
})
