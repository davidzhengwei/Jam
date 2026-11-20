export type ToastTone = 'info' | 'ok' | 'error'
export interface ToastMsg {
  id: number
  text: string
  tone: ToastTone
}

let seq = 0
const listeners = new Set<(list: ToastMsg[]) => void>()
let current: ToastMsg[] = []

export function toast(text: string, tone: ToastTone = 'info') {
  const msg: ToastMsg = { id: ++seq, text, tone }
  current = [...current, msg]
  listeners.forEach((fn) => fn(current))
  setTimeout(() => {
    current = current.filter((m) => m.id !== msg.id)
    listeners.forEach((fn) => fn(current))
  }, tone === 'error' ? 5200 : 2600)
}

export function subscribeToast(fn: (list: ToastMsg[]) => void) {
  listeners.add(fn)
  fn(current)
  return () => listeners.delete(fn)
}
