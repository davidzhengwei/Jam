import type { Editor } from '@tiptap/react'
import { CellSelection } from '@tiptap/pm/tables'

export interface CellInfo {
  pos: number
  node: any
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface TableGrid {
  tablePos: number
  rowCount: number
  colCount: number
  cells: CellInfo[]
  cellAt: (row: number, col: number) => CellInfo | null
}

export interface GridPoint {
  tablePos: number
  row: number
  col: number
  cell: CellInfo
  anchor: { row: number; col: number }
  head: { row: number; col: number }
  rows: number
  cols: number
}

/** 找到包含 pos 的 table 节点位置；pos 可以是单元格内部位置 */
export function findTablePosAt(doc: any, pos: number): number | null {
  let found: number | null = null
  doc.descendants((node: any, p: number) => {
    if (found !== null) return false
    if (node.type.name === 'table' && p <= pos && pos <= p + node.nodeSize) {
      found = p
      return false
    }
    return true
  })
  return found
}

/** 构造表格网格：合并单元格会占据多个 (row,col) 槽位，但只保留一个 cell 位置 */
export function buildTableGrid(doc: any, tablePos: number): TableGrid | null {
  const table = doc.nodeAt(tablePos)
  if (!table || table.type.name !== 'table') return null

  const matrix: (CellInfo | null)[][] = []
  const cells: CellInfo[] = []
  let rowIndex = 0

  table.forEach((row: any, rowOffset: number) => {
    if (row.type.name !== 'tableRow') return
    const rowPos = tablePos + 1 + rowOffset
    if (!matrix[rowIndex]) matrix[rowIndex] = []
    let colIndex = 0

    row.forEach((cell: any, cellOffset: number) => {
      const role = cell.type.spec?.tableRole
      if (role !== 'cell' && role !== 'header' && role !== 'header_cell') return
      const rowspan = Math.max(1, Number(cell.attrs?.rowspan) || 1)
      const colspan = Math.max(1, Number(cell.attrs?.colspan) || 1)
      const info: CellInfo = {
        pos: rowPos + 1 + cellOffset,
        node: cell,
        row: rowIndex,
        col: colIndex,
        rowSpan: rowspan,
        colSpan: colspan,
      }
      cells.push(info)
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (!matrix[rowIndex + dr]) matrix[rowIndex + dr] = []
          matrix[rowIndex + dr][colIndex + dc] = info
        }
      }
      colIndex += colspan
    })
    rowIndex++
  })

  const colCount = matrix.reduce((max, row) => Math.max(max, row.length), 0)
  const cellAt = (row: number, col: number) => matrix[row]?.[col] || null

  return { tablePos, rowCount: rowIndex, colCount, cells, cellAt }
}

export function getCellInfoAtPos(doc: any, pos: number): CellInfo | null {
  const tablePos = findTablePosAt(doc, pos)
  if (tablePos === null) return null
  const grid = buildTableGrid(doc, tablePos)
  if (!grid) return null
  return grid.cells.find((cell) => pos >= cell.pos && pos <= cell.pos + cell.node.nodeSize) || null
}

export function isCellSelection(editor: Editor | null): boolean {
  return !!editor && editor.state.selection instanceof CellSelection
}

/** 当前光标 / 选区对应的表格坐标（CellSelection 时返回矩形范围） */
export function getGridPoint(editor: Editor | null): GridPoint | null {
  if (!editor) return null
  const { state } = editor
  const { doc, selection } = state
  let cell = getCellInfoAtPos(doc, selection.from)
  let anchor = cell ? { row: cell.row, col: cell.col } : null
  let head = anchor

  if (selection instanceof CellSelection) {
    const a = (selection as any).$anchorCell?.pos
    const h = (selection as any).$headCell?.pos
    if (a !== undefined && h !== undefined) {
      const tablePos = findTablePosAt(doc, a)
      if (tablePos === null) return null
      const grid = buildTableGrid(doc, tablePos)
      if (!grid) return null
      const ac = grid.cells.find((c) => c.pos === a)
      const hc = grid.cells.find((c) => c.pos === h)
      if (!ac || !hc) return null
      cell = ac
      anchor = { row: ac.row, col: ac.col }
      head = { row: hc.row, col: hc.col }
      return {
        tablePos,
        row: ac.row,
        col: ac.col,
        cell: ac,
        anchor: anchor!,
        head: head!,
        rows: Math.abs(ac.row - hc.row) + 1,
        cols: Math.abs(ac.col - hc.col) + 1,
      }
    }
  }

  if (!cell || !anchor || !head) return null
  const tablePos = findTablePosAt(doc, cell.pos)
  if (tablePos === null) return null
  return {
    tablePos,
    row: cell.row,
    col: cell.col,
    cell,
    anchor,
    head,
    rows: 1,
    cols: 1,
  }
}

/** 选择表格中一个矩形单元格区域 */
export function setCellRange(editor: Editor | null, r1: number, c1: number, r2: number, c2: number): boolean {
  if (!editor) return false
  const point = getGridPoint(editor)
  if (!point) return false
  const grid = buildTableGrid(editor.state.doc, point.tablePos)
  if (!grid) return false
  const rowA = Math.max(0, Math.min(r1, r2))
  const rowB = Math.min(grid.rowCount - 1, Math.max(r1, r2))
  const colA = Math.max(0, Math.min(c1, c2))
  const colB = Math.min(grid.colCount - 1, Math.max(c1, c2))
  const from = grid.cellAt(rowA, colA)
  const to = grid.cellAt(rowB, colB)
  if (!from || !to) return false
  try {
    const tr = editor.state.tr.setSelection(CellSelection.create(editor.state.doc, from.pos, to.pos))
    editor.view.dispatch(tr)
    return true
  } catch (_) {
    return false
  }
}

/** 把光标所在单元格设为区域选择起点，随后可用 Shift+方向键扩展 */
export function startCellSelection(editor: Editor | null): boolean {
  const point = getGridPoint(editor)
  if (!editor || !point) return false
  return setCellRange(editor, point.row, point.col, point.row, point.col)
}

/** 对当前单元格区域批量设置属性 */
export function updateSelectedCells(editor: Editor | null, attrs: Record<string, any>): number {
  if (!editor) return 0
  const { state, view } = editor
  const tr = state.tr
  const seen = new Set<number>()
  const apply = (pos: number, node: any) => {
    if (seen.has(pos)) return
    seen.add(pos)
    tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })
  }

  if (state.selection instanceof CellSelection) {
    state.selection.forEachCell((node: any, pos: number) => apply(pos, node))
  } else {
    const cell = getCellInfoAtPos(state.doc, state.selection.from)
    if (cell) apply(cell.pos, cell.node)
  }

  if (!seen.size) return 0
  view.dispatch(tr)
  return seen.size
}

/** 当前选区是否跨多个单元格（或含合并单元格），用于启用合并/拆分按钮 */
export function getSelectionShape(editor: Editor | null): { rows: number; cols: number; span: boolean } | null {
  const point = getGridPoint(editor)
  if (!editor || !point) return null
  const grid = buildTableGrid(editor.state.doc, point.tablePos)
  if (!grid) return null
  const r1 = Math.min(point.anchor.row, point.head.row)
  const r2 = Math.max(point.anchor.row, point.head.row)
  const c1 = Math.min(point.anchor.col, point.head.col)
  const c2 = Math.max(point.anchor.col, point.head.col)
  const cells = new Set<number>()
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const info = grid.cellAt(r, c)
      if (info) cells.add(info.pos)
    }
  }
  const span = Array.from(cells).some((pos) => {
    const info = grid.cells.find((x) => x.pos === pos)
    return !!info && (info.colSpan > 1 || info.rowSpan > 1)
  })
  return { rows: r2 - r1 + 1, cols: c2 - c1 + 1, span }
}

export function getTableNodeWidth(editor: Editor | null): number {
  if (!editor) return 0
  const point = getGridPoint(editor)
  if (!point) return 0
  const table = editor.state.doc.nodeAt(point.tablePos)
  const attr = Number(table?.attrs?.width) || 0
  if (attr) return attr
  try {
    const dom = editor.view.domAtPos(point.tablePos + 1)
    const el = (dom.node.nodeType === 1 ? (dom.node as HTMLElement) : dom.node.parentElement)?.closest('table')
    return el ? Math.round(el.getBoundingClientRect().width) : 0
  } catch (_) {
    return 0
  }
}

export function setTableWidth(editor: Editor | null, width: number | null): boolean {
  if (!editor) return false
  const point = getGridPoint(editor)
  if (!point) return false
  const table = editor.state.doc.nodeAt(point.tablePos)
  if (!table) return false
  const next = width === null ? null : Math.max(320, Math.min(3200, Math.round(width)))
  const tr = editor.state.tr.setNodeMarkup(point.tablePos, undefined, { ...table.attrs, width: next })
  editor.view.dispatch(tr)
  return true
}

export function adjustRowHeight(editor: Editor | null, delta: number): number {
  if (!editor) return 0
  const point = getGridPoint(editor)
  if (!point) return 0
  const current = Number(point.cell.node.attrs?.rowHeight) || 0
  const next = Math.max(24, Math.min(400, current + delta))
  return updateSelectedCells(editor, { rowHeight: next })
}

export interface MatrixResult {
  ok: boolean
  reason?: string
  rows?: string[][]
  cols?: number
}

/** 解析外部文本：换行分 row，空格/制表符分 col；折叠多余空格，空行/空值保留为空串 */
export function parseSpaceMatrix(text: string): MatrixResult {
  const raw = String(text || '').replace(/\r\n?/g, '\n')
  const lines = raw.split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  if (!lines.length) return { ok: false, reason: '剪贴板没有内容' }

  const multi = lines.length > 1 || /\t/.test(raw) || / {2,}/.test(raw)
  if (!multi) return { ok: false, reason: '普通单行文本，按默认粘贴处理' }

  const rows = lines.map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return ['']
    return trimmed.split(/[\t ]+/).map((cell) => cell.trim())
  })
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  if (rows.length > 60 || cols > 40) {
    return { ok: false, reason: `粘贴区域过大（上限 60 行 × 40 列，实际 ${rows.length} 行 × ${cols} 列）` }
  }
  return { ok: true, rows, cols }
}

export interface PasteResult {
  ok: boolean
  reason?: string
  rows?: number
  cols?: number
  addedRows?: number
  addedCols?: number
}

/** 把矩阵批量写入当前单元格；目标区域不足时自动扩展行列 */
export function pasteMatrixIntoTable(editor: Editor | null, text: string): PasteResult {
  const parsed = parseSpaceMatrix(text)
  if (!parsed.ok || !parsed.rows || !parsed.cols) {
    return { ok: false, reason: parsed.reason || '无法解析粘贴内容' }
  }
  if (!editor) return { ok: false, reason: '编辑器尚未就绪' }

  const point = getGridPoint(editor)
  if (!point) return { ok: false, reason: '请先把光标放到表格单元格中' }

  const needRows = point.row + parsed.rows.length
  const needCols = point.col + parsed.cols
  if (needRows > 80 || needCols > 60) {
    return { ok: false, reason: '连同目标位置已超出表格上限（80 行 × 60 列）' }
  }

  let grid = buildTableGrid(editor.state.doc, point.tablePos)
  if (!grid) return { ok: false, reason: '未找到目标表格' }

  let addedRows = 0
  let addedCols = 0

  while (grid.rowCount < needRows) {
    const last = grid.cellAt(grid.rowCount - 1, Math.min(point.col, grid.colCount - 1))
    if (!last) break
    editor.commands.setTextSelection(last.pos)
    editor.commands.addRowAfter()
    addedRows++
    const next = buildTableGrid(editor.state.doc, point.tablePos)
    if (!next || next.rowCount === grid.rowCount) break
    grid = next
  }

  while (grid.colCount < needCols) {
    const cur = grid.cellAt(point.row, Math.min(point.col, grid.colCount - 1))
    if (!cur) break
    editor.commands.setTextSelection(cur.pos)
    editor.commands.addColumnAfter()
    addedCols++
    const next = buildTableGrid(editor.state.doc, point.tablePos)
    if (!next || next.colCount === grid.colCount) break
    grid = next
  }

  const schema = editor.state.schema
  const tr = editor.state.tr
  const startInfo = grid.cellAt(point.row, point.col)
  const endInfo = grid.cellAt(point.row + parsed.rows.length - 1, point.col + parsed.cols - 1)

  // 逆序写入，避免前面的替换改变后面单元格的位置
  for (let i = parsed.rows.length - 1; i >= 0; i--) {
    for (let j = parsed.cols - 1; j >= 0; j--) {
      const info = grid.cellAt(point.row + i, point.col + j)
      if (!info) continue
      const cell = tr.doc.nodeAt(info.pos)
      if (!cell) continue
      const from = info.pos + 1
      const to = from + cell.content.size
      const value = parsed.rows![i][j] ?? ''
      const paragraph = value
        ? schema.nodes.paragraph.create(null, schema.text(value))
        : schema.nodes.paragraph.create()
      tr.replaceWith(from, to, paragraph)
    }
  }

  if (startInfo && endInfo) {
    try {
      const from = tr.mapping.map(startInfo.pos)
      const to = tr.mapping.map(endInfo.pos)
      tr.setSelection(CellSelection.create(tr.doc, from, to))
    } catch (_) {
      // 合并单元格场景下选区可能失效，不影响写入结果
    }
  }

  editor.view.dispatch(tr)
  return { ok: true, rows: parsed.rows.length, cols: parsed.cols, addedRows, addedCols }
}
