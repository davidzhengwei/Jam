import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { readAttachment } from '../lib/attachments'

/** 已解析过的附件 dataURL 缓存，避免重复读盘 */
const resolved = new Map<string, string>()

function ImageView({ node }: NodeViewProps) {
  const raw: string = (node.attrs?.src as string) || ''
  const inline = raw.startsWith('att:')
  const [src, setSrc] = useState(() => (inline ? resolved.get(raw) || '' : raw))
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!inline) {
      setSrc(raw)
      return
    }
    const hit = resolved.get(raw)
    if (hit) {
      setSrc(hit)
      return
    }
    let alive = true
    readAttachment(raw).then((dataUrl) => {
      if (!alive) return
      if (dataUrl) {
        resolved.set(raw, dataUrl)
        setSrc(dataUrl)
      } else {
        setFailed(true)
      }
    })
    return () => {
      alive = false
    }
  }, [raw, inline])

  if (failed) {
    return (
      <NodeViewWrapper as="span" className="img-broken" contentEditable={false}>
        图片丢失
      </NodeViewWrapper>
    )
  }

  return (
    <NodeViewWrapper as="span" className="img-wrap" data-att={inline ? raw : undefined}>
      <img
        src={src}
        alt={(node.attrs?.alt as string) || ''}
        title={(node.attrs?.title as string) || undefined}
        draggable={false}
      />
    </NodeViewWrapper>
  )
}

/** 本地图片节点：src 存 att: 引用（数据随 data.json），文件存 attachments/ */
export const NoteImage = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  draggable: true,
  atom: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      title: { default: null },
    }
  },

  parseHTML() {
    return [{ tag: 'img[src]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes)]
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})
