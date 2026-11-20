/** 图片附件归属「页签」：正文在第 4 层 Tab，附件随页签删除而清理。
 *  桌面版存 data/attachments/<tabId>/，浏览器降级存 localStorage。 */

interface SaveResult {
  ok: boolean
  key?: string
  error?: string
}

function safeName(name: string) {
  const base = String(name || 'image.png').replace(/[\\/:*?"<>|]/g, '_').slice(-60)
  return base || 'image.png'
}

export async function saveAttachment(tabId: string, name: string, dataUrl: string): Promise<SaveResult> {
  if (window.jam?.saveAttachment) {
    return window.jam.saveAttachment({ tabId, name, dataUrl })
  }
  // 浏览器预览模式：localStorage
  const key = `att:${tabId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}/${safeName(name)}`
  try {
    localStorage.setItem('jam:att:' + key, dataUrl)
    return { ok: true, key }
  } catch (_) {
    return { ok: false, error: '浏览器存储空间不足，无法保存图片' }
  }
}

export async function readAttachment(key: string): Promise<string | null> {
  if (!key || !key.startsWith('att:')) return null
  if (window.jam?.readAttachment) {
    const res = await window.jam.readAttachment(key)
    return res?.ok ? res.dataUrl || null : null
  }
  try {
    return localStorage.getItem('jam:att:' + key)
  } catch (_) {
    return null
  }
}

/** 页签被彻底删除（关闭页签 / 彻底删除页面）后清理其附件；进回收站时不调用，支持还原。 */
export async function deleteAttachments(tabId: string): Promise<void> {
  if (window.jam?.deleteAttachments) {
    await window.jam.deleteAttachments(tabId)
    return
  }
  try {
    const prefix = 'jam:att:att:' + tabId + '/'
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) stale.push(k)
    }
    stale.forEach((k) => localStorage.removeItem(k))
  } catch (_) {}
}
