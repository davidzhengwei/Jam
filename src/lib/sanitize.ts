const ALLOWED = new Set([
  'P','DIV','BR','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE',
  'STRONG','B','EM','I','U','S','DEL','STRIKE','A','TABLE','THEAD','TBODY','TFOOT','TR','TD','TH',
  'HR','INPUT','SPAN','FONT','IMG',
])

/**
 * 清洗从 Word / 网页粘贴进来的 HTML：只保留结构，剥掉全部内联样式与 class，
 * 避免把一堆 mso-* 样式带进笔记。
 */
export function sanitizePastedHtml(html: string): string {
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const body = doc.body
  cleanNode(body)
  return body.innerHTML
}

function cleanNode(parent: Element) {
  for (const child of Array.from(parent.children)) {
    cleanNode(child)
    const tag = child.tagName.toUpperCase()

    // Word 的 div 通常是段落，转成 p 保住段落边界
    if (tag === 'DIV') {
      const p = child.ownerDocument.createElement('p')
      while (child.firstChild) p.appendChild(child.firstChild)
      child.replaceWith(p)
      continue
    }

    if (!ALLOWED.has(tag)) {
      unwrap(child)
      continue
    }

    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase()
      const value = attr.value
      let keep = false
      if (tag === 'A' && name === 'href') keep = /^(https?:|mailto:|#|\/)/i.test(value.trim())
      else if (tag === 'INPUT' && (name === 'type' || name === 'checked')) keep = true
      else if ((tag === 'TD' || tag === 'TH') && (name === 'colspan' || name === 'rowspan')) keep = true
      if (!keep) child.removeAttribute(attr.name)
    }

    if (tag === 'INPUT' && child.getAttribute('type') !== 'checkbox') unwrap(child)
    if (tag === 'IMG') unwrap(child)
  }
}

function unwrap(el: Element) {
  const parent = el.parentNode
  if (!parent) return
  while (el.firstChild) parent.insertBefore(el.firstChild, el)
  parent.removeChild(el)
}
