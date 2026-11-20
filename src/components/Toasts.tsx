import { useEffect, useState } from 'react'
import { subscribeToast, type ToastMsg } from '../lib/toast'

export function Toasts() {
  const [list, setList] = useState<ToastMsg[]>([])

  useEffect(() => {
    const off = subscribeToast(setList)
    return () => {
      off()
    }
  }, [])

  return (
    <div className="toasts">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
