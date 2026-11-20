import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface DialogRequest {
  kind: 'prompt' | 'confirm'
  title: string
  message?: string
  value?: string
  placeholder?: string
  okText?: string
  danger?: boolean
  resolve: (value: any) => void
}

export function useDialogs() {
  const [req, setReq] = useState<DialogRequest | null>(null)

  const prompt = (opts: {
    title: string
    message?: string
    value?: string
    placeholder?: string
    okText?: string
  }) =>
    new Promise<string | null>((resolve) => {
      setReq({ kind: 'prompt', resolve, ...opts })
    })

  const confirm = (opts: { title: string; message?: string; okText?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => {
      setReq({ kind: 'confirm', resolve, ...opts })
    })

  const close = (value: any) => {
    req?.resolve(value)
    setReq(null)
  }

  const host = <DialogHost req={req} onClose={close} />

  return { prompt, confirm, host }
}

function DialogHost({ req, onClose }: { req: DialogRequest | null; onClose: (v: any) => void }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!req) return
    setValue(req.value ?? '')
    setTimeout(() => {
      if (req.kind === 'prompt') {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }, 20)
  }, [req])

  if (!req) return null

  const submit = () => {
    if (req.kind === 'prompt') {
      const v = value.trim()
      if (!v) return
      onClose(v)
    } else {
      onClose(true)
    }
  }

  return createPortal(
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose(req.kind === 'prompt' ? null : false)}>
      <div className="modal" onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose(req.kind === 'prompt' ? null : false)
        }
      }}>
        <div className="modal-title">{req.title}</div>
        {req.message && <div className="modal-msg">{req.message}</div>}
        {req.kind === 'prompt' && (
          <input
            ref={inputRef}
            className="modal-input"
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
        )}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => onClose(req.kind === 'prompt' ? null : false)}>
            取消
          </button>
          <button type="button" className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} onClick={submit}>
            {req.okText || '确定'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
