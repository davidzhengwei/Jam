import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import { Eye, EyeOff, Trash2 } from 'lucide-react'

/** 账号密码卡片：一张卡片记录一条账号信息，密码默认圆点隐藏 */
function CredentialCardView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const name = typeof node.attrs.name === 'string' ? node.attrs.name : ''
  const account = typeof node.attrs.account === 'string' ? node.attrs.account : ''
  const password = typeof node.attrs.password === 'string' ? node.attrs.password : ''
  const revealed = !!node.attrs.revealed

  const set = (key: 'name' | 'account' | 'password', value: string) => updateAttributes({ [key]: value })

  return (
    <NodeViewWrapper
      as="div"
      className="credential-card"
      data-revealed={revealed ? 'true' : 'false'}
      data-node-view-wrapper
    >
      <div className="cc-head">
        <span className="cc-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="10.5" width="16" height="10" rx="2" />
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          </svg>
        </span>
        <span className="cc-title">账号密码</span>
        <button
          type="button"
          className="cc-delete"
          title="删除这张卡片"
          aria-label="删除这张卡片"
          onClick={deleteNode}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="cc-body">
        <label className="cc-row">
          <span className="cc-label">账号名称</span>
          <input
            className="cc-input"
            value={name}
            placeholder="例如：GitHub"
            aria-label="账号名称"
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="cc-row">
          <span className="cc-label">账号</span>
          <input
            className="cc-input"
            value={account}
            placeholder="用户名 / 邮箱 / 手机号"
            aria-label="账号"
            autoComplete="off"
            onChange={(e) => set('account', e.target.value)}
          />
        </label>
        <label className="cc-row">
          <span className="cc-label">密码</span>
          <span className="cc-secret">
            <input
              className="cc-input cc-password"
              type={revealed ? 'text' : 'password'}
              value={password}
              placeholder="输入密码"
              aria-label="密码"
              autoComplete="new-password"
              onChange={(e) => set('password', e.target.value)}
            />
            <button
              type="button"
              className="cc-eye"
              title={revealed ? '隐藏密码' : '显示密码'}
              aria-label={revealed ? '隐藏密码' : '显示密码'}
              aria-pressed={revealed}
              onClick={() => updateAttributes({ revealed: !revealed })}
            >
              {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </span>
        </label>
      </div>
    </NodeViewWrapper>
  )
}

export const CredentialCard = Node.create({
  name: 'credentialCard',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: '' },
      account: { default: '' },
      password: { default: '' },
      revealed: { default: false },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-credential-card]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-credential-card': '',
        'data-name': a.name || '',
        'data-account': a.account || '',
        'data-password': a.password || '',
        'data-revealed': a.revealed ? 'true' : 'false',
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CredentialCardView)
  },
})
