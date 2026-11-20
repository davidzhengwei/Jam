import type { BackupItem, Data } from '../types'
import { APP_VERSION } from './changelog'

const LS_KEY = 'jam:data'

export const isElectron = typeof window !== 'undefined' && !!window.jam

/** 浏览器预览模式的存储适配（Electron 下走 IPC） */
export const storage = {
  mode: isElectron ? 'electron' : 'browser',

  async load(): Promise<{ data: Data | null; firstRun: boolean; dataDir?: string; corrupted?: boolean }> {
    if (window.jam) return window.jam.load()
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (!raw) return { data: null, firstRun: true, dataDir: '（浏览器 localStorage）' }
      return { data: JSON.parse(raw), firstRun: false, dataDir: '（浏览器 localStorage）' }
    } catch (err) {
      return { data: null, firstRun: true, dataDir: '（浏览器 localStorage）' }
    }
  },

  async save(json: string): Promise<{ ok: boolean; error?: string }> {
    if (window.jam) return window.jam.save(json)
    try {
      localStorage.setItem(LS_KEY, json)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: '浏览器存储空间不足' }
    }
  },

  async openFolder(): Promise<void> {
    if (window.jam) await window.jam.openFolder('data')
  },

  async backupNow(): Promise<{ ok: boolean; name?: string; error?: string }> {
    if (window.jam) return window.jam.backupNow()
    return { ok: false, error: '浏览器预览模式不支持 zip 备份，请使用桌面版' }
  },

  async listBackups(): Promise<BackupItem[]> {
    if (window.jam) return window.jam.listBackups()
    return []
  },

  async restoreBackup(name: string): Promise<{ ok: boolean; data?: Data; error?: string }> {
    if (window.jam) return window.jam.restoreBackup(name)
    return { ok: false, error: '浏览器预览模式不支持恢复备份' }
  },

  async exportFile(defaultName: string, content: string, filters?: { name: string; extensions: string[] }[]) {
    if (window.jam) return window.jam.exportFile({ defaultName, content, filters })
    try {
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
      return { ok: true, path: defaultName }
    } catch (err) {
      return { ok: false }
    }
  },

  async openMarkdown(): Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    name?: string
    content?: string
    encoding?: string
    size?: number
    error?: string
  }> {
    if (window.jam?.openMarkdown) return window.jam.openMarkdown()
    // 浏览器降级：隐藏 file input 选取，按 UTF-8 读取；编码细节由桌面版保证
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.md,.markdown,.mdown,.txt,text/markdown,text/plain'
      input.style.display = 'none'
      document.body.appendChild(input)
      const cleanup = () => {
        document.body.removeChild(input)
      }
      input.onchange = () => {
        const file = input.files?.[0]
        cleanup()
        if (!file) return resolve({ ok: false, canceled: true })
        if (file.size > 20 * 1024 * 1024) return resolve({ ok: false, error: '文件超过 20MB，无法打开' })
        const reader = new FileReader()
        reader.onload = () => {
          const raw = String(reader.result || '')
          const content = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
          resolve({
            ok: true,
            path: (file as any).path || file.name,
            name: file.name.replace(/\.[^.]+$/, ''),
            content,
            encoding: 'UTF-8',
            size: file.size,
          })
        }
        reader.onerror = () => resolve({ ok: false, error: '文件读取失败' })
        reader.readAsText(file, 'UTF-8')
      }
      // 用户取消对话框时 change 不触发：切回窗口后再决定是否按取消处理
      window.addEventListener(
        'focus',
        () => {
          setTimeout(() => {
            if (input.files?.length) return
            cleanup()
            resolve({ ok: false, canceled: true })
          }, 500)
        },
        { once: true }
      )
      input.click()
    })
  },

  async info() {
    if (window.jam) return window.jam.appInfo()
    return {
      version: APP_VERSION,
      dataDir: '浏览器 localStorage',
      dataFile: LS_KEY,
      backupDir: '—',
      isPackaged: false,
      mode: 'browser',
    }
  },
}
