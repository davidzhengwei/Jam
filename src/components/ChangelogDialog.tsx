import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { APP_VERSION, CHANGELOG } from '../lib/changelog'

interface Props {
  open: boolean
  onClose: () => void
}

/** 更新记录弹窗：按版本倒序展示内置日志，离线可用 */
export function ChangelogDialog({ open, onClose }: Props) {
  if (!open) return null

  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="changelog">
        <div className="settings-head">
          <span>更新记录</span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="changelog-body">
          <div className="changelog-now">
            当前版本 <strong>v{APP_VERSION}</strong>
          </div>
          {CHANGELOG.map((item, i) => (
            <section key={item.version} className={`changelog-item${i === 0 ? ' is-latest' : ''}`}>
              <div className="cl-head">
                <span className="cl-ver">v{item.version}</span>
                {i === 0 && <span className="cl-tag">当前</span>}
                <span className="cl-date">{item.date}</span>
              </div>
              <div className="cl-summary">{item.summary}</div>
              <ul className="cl-list">
                {item.changes.map((change, j) => (
                  <li key={j}>{change}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="changelog-foot">更新记录随程序内置，可离线查看</div>
      </div>
    </div>,
    document.body
  )
}
