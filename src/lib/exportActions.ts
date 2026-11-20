import { type ExportDoc, pageToHtml, pageToMarkdown, resolveAttachmentSrc } from './export'
import { mdToStandaloneHtml } from './markdown'
import { storage } from './storage'
import { safeFileName } from './utils'
import { toast } from './toast'

/** 导出一个正文单元（页签）。组织层级节点没有正文，不提供导出。 */
export async function exportPage(page: ExportDoc, kind: 'md' | 'html') {
  const base = safeFileName(page.title || '未命名页面')
  const name = `${base}.${kind === 'md' ? 'md' : 'html'}`
  let content: string
  if (page.mode === 'md' && typeof page.md === 'string') {
    // Markdown 页：源码就是最终形态，导出不再从富文本反推
    content =
      kind === 'md'
        ? `# ${page.title || '未命名页面'}\n\n${page.md}\n`
        : await mdToStandaloneHtml(page.title || '未命名页面', page.md)
  } else {
    const resolvedContent = await resolveAttachmentSrc(page.content)
    const resolved: ExportDoc = { ...page, content: resolvedContent }
    content = kind === 'md' ? pageToMarkdown(resolved) : pageToHtml(resolved)
  }
  const res = await storage.exportFile(name, content, [
    { name: kind === 'md' ? 'Markdown 文件' : 'HTML 文件', extensions: [kind === 'md' ? 'md' : 'html'] },
  ])
  if (res.ok) toast(`已导出：${res.path || name}`, 'ok')
  else if (!res.canceled) toast('导出失败', 'error')
}
