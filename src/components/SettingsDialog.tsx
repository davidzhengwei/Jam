import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Archive, FolderOpen, RefreshCw, X } from 'lucide-react'
import type { AppInfo, BackupItem, SkinId } from '../types'
import type { Store } from '../store'
import { storage } from '../lib/storage'
import { bytes, formatFullTime } from '../lib/utils'
import { toast } from '../lib/toast'
import { countPages } from '../store'
import { APP_VERSION } from '../lib/changelog'

interface Props {
  open: boolean
  onClose: () => void
  store: Store
  info: AppInfo | null
  theme: 'light' | 'dark'
  setTheme: (t: 'light' | 'dark') => void
  skin: SkinId
  setSkin: (skin: SkinId) => void
  confirm: (opts: { title: string; message?: string; okText?: string; danger?: boolean }) => Promise<boolean>
}

const SKINS: { id: SkinId; label: string; hint: string }[] = [
  { id: 'paper', label: '宣纸', hint: '温暖纸感 · 宋体标题 · 朱红书签' },
  { id: 'workbench', label: '工具台', hint: '极简工业 · 等宽元信息 · 信号蓝' },
  { id: 'ink', label: '夜墨', hint: '深色专注 · 三栏明度 · 暖铜强调' },
]

export function SettingsDialog({ open, onClose, store, info, theme, setTheme, skin, setSkin, confirm }: Props) {
  const [backups, setBackups] = useState<BackupItem[]>([])
  const [busy, setBusy] = useState(false)

  const loadBackups = async () => {
    const list = await storage.listBackups()
    setBackups(list)
  }

  useEffect(() => {
    if (!open) return
    void loadBackups()
  }, [open])

  if (!open) return null

  const doBackup = async () => {
    setBusy(true)
    const res = await storage.backupNow()
    setBusy(false)
    if (res.ok) {
      toast(`备份完成：${res.name}`, 'ok')
      void loadBackups()
    } else {
      toast(`备份失败：${res.error || '未知错误'}`, 'error')
    }
  }

  const doRestore = async (name: string) => {
    const ok = await confirm({
      title: '恢复这个备份？',
      message: '当前内容会先自动备份一份，然后用所选备份覆盖（恢复后不可撤销，但可从新备份找回）。',
      okText: '恢复',
      danger: true,
    })
    if (!ok) return
    setBusy(true)
    const res = await storage.restoreBackup(name)
    setBusy(false)
    if (res.ok && res.data) {
      store.reload(res.data)
      toast('已恢复备份', 'ok')
      void loadBackups()
    } else {
      toast(`恢复失败：${res.error || '未知错误'}`, 'error')
    }
  }

  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings">
        <div className="settings-head">
          <span>设置</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="settings-body">
          <div className="set-group">
            <div className="set-label">皮肤</div>
            <div className="seg seg-skin">
              {SKINS.map((s) => (
                <button
                  type="button"
                  key={s.id}
                  className={skin === s.id ? 'is-on' : ''}
                  title={s.hint}
                  onClick={() => setSkin(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="set-hint">{SKINS.find((s) => s.id === skin)?.hint || ''}</div>
          </div>

          <div className="set-group">
            <div className="set-label">明暗</div>
            <div className="seg">
              <button type="button" className={theme === 'light' ? 'is-on' : ''} onClick={() => setTheme('light')}>
                浅色
              </button>
              <button type="button" className={theme === 'dark' ? 'is-on' : ''} onClick={() => setTheme('dark')}>
                深色
              </button>
            </div>
          </div>

          <div className="set-group">
            <div className="set-label">数据</div>
            <div className="set-row">
              <span className="set-key">数据文件</span>
              <span className="set-value mono">{info?.dataFile || '—'}</span>
            </div>
            <div className="set-row">
              <span className="set-key">页面数量</span>
              <span className="set-value">{countPages(store.data)} 页</span>
            </div>
            <div className="set-row">
              <span className="set-key">运行模式</span>
              <span className="set-value">
                {info?.mode === 'electron' ? '桌面版（数据落本地文件）' : '浏览器预览（数据存 localStorage）'}
              </span>
            </div>
            <div className="set-actions">
              <button type="button" className="btn" onClick={() => void storage.openFolder()}>
                <FolderOpen size={14} /> 打开数据目录
              </button>
            </div>
          </div>

          <div className="set-group">
            <div className="set-label">备份（每天首次启动自动备份，保留最近 10 份）</div>
            <div className="set-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={doBackup}>
                <Archive size={14} /> 立即备份整库
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void loadBackups()}>
                <RefreshCw size={14} /> 刷新
              </button>
            </div>
            <div className="backup-list">
              {backups.length === 0 && <div className="empty-panel small">暂无备份</div>}
              {backups.map((b) => (
                <div key={b.name} className="backup-item">
                  <div className="backup-main">
                    <div className="backup-name">{b.name}</div>
                    <div className="backup-meta">
                      {formatFullTime(b.mtime)} · {bytes(b.size)}
                    </div>
                  </div>
                  <button type="button" className="btn btn-small" disabled={busy} onClick={() => void doRestore(b.name)}>
                    恢复
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="set-group">
            <div className="set-label">快捷键</div>
            <div className="kbd-grid">
              <span>全局搜索</span>
              <kbd>Ctrl + K</kbd>
              <span>立即保存</span>
              <kbd>Ctrl + S</kbd>
              <span>加粗 / 斜体 / 下划线</span>
              <kbd>Ctrl + B / I / U</kbd>
              <span>行内代码 / 代码块</span>
              <kbd>Ctrl + E / Ctrl + Alt + C</kbd>
              <span>代码块缩进 / 反缩进</span>
              <kbd>Tab / Shift + Tab</kbd>
              <span>关闭弹窗</span>
              <kbd>Esc</kbd>
            </div>
          </div>

          <div className="set-group about">
            <div className="set-label">关于</div>
            <div className="set-row">
              <span className="set-key">版本</span>
              <span className="set-value">Jam {info?.version || APP_VERSION}</span>
            </div>
            <div className="about-text">
              单机个人笔记与代码片段库，无登录、无联网。把整个文件夹拷走即可迁移。
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
