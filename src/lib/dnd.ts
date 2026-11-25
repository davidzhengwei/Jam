/**
 * 拖拽协议：分区 / 页面 / 页签共用的载荷、合法性判定与落点计算。
 * 数据层级固定四层，拖拽只发生在「同类 → 上一级容器」之间：
 *   section → notebook.sections[]，page → section.pages[]，tab → page.tabs[]
 */

import type { DragEvent } from 'react'

export type DragKind = 'section' | 'page' | 'tab'
export type ContainerKind = 'notebook' | 'section' | 'page'

export interface DragPayload {
  type: DragKind
  id: string
}

/** 落点：目标容器 id + 插入到该容器 children 的索引（store 层会修正同数组删除后的偏移） */
export type DropTarget =
  | { kind: 'notebook'; id: string; index: number }
  | { kind: 'section'; id: string; index: number }
  | { kind: 'page'; id: string; index: number }

export const DND_MIME = 'application/x-jam'

/**
 * 当前正在拖拽的载荷。浏览器在 dragover 阶段不允许读 dataTransfer 数据，
 * 因此用模块级变量记录真实载荷，供各目标做精确的合法性判定与高亮。
 */
let currentDrag: DragPayload | null = null
export const getCurrentDrag = () => currentDrag
export function startDrag(payload: DragPayload) {
  currentDrag = payload
}
export function endDrag() {
  currentDrag = null
}

/** 每种节点唯一合法的容器类型 */
export const PARENT_KIND: Record<DragKind, ContainerKind> = {
  section: 'notebook',
  page: 'section',
  tab: 'page',
}

export function writePayload(dt: DataTransfer, payload: DragPayload) {
  dt.setData(DND_MIME, JSON.stringify(payload))
  dt.effectAllowed = 'move'
}

export function readPayload(dt: DataTransfer): DragPayload | null {
  const raw = dt.getData(DND_MIME)
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value.id !== 'string') return null
    if (value.type !== 'section' && value.type !== 'page' && value.type !== 'tab') return null
    return value as DragPayload
  } catch (_) {
    return null
  }
}

/** 载荷与目标容器是否匹配；不匹配即非法拖拽，UI 不高亮、drop 不改数据 */
export function canDrop(payload: DragPayload | null, targetKind: ContainerKind): boolean {
  return !!payload && PARENT_KIND[payload.type] === targetKind
}

/**
 * 根据指针在目标元素上的位置算「插入到目标前 / 后」。
 * 纵向列表用 clientY，横向页签栏用 clientX。
 */
export function edgeFromEvent(e: DragEvent, axis: 'y' | 'x' = 'y'): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const at = axis === 'y' ? e.clientY : e.clientX
  const mid = axis === 'y' ? rect.top + rect.height / 2 : rect.left + rect.width / 2
  return at < mid ? 'before' : 'after'
}

/** 目标 key：用于组件内部记录当前高亮的是哪个落点 */
export function dropKey(kind: ContainerKind, id: string, edge: 'before' | 'after'): string {
  return `${kind}:${id}:${edge}`
}
