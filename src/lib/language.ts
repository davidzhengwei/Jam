import { createLowlight, common } from 'lowlight'

export const lowlight = createLowlight(common)

export interface LangOption {
  id: string
  label: string
}

const ALL_LANGS: LangOption[] = [
  { id: 'plaintext', label: 'Plain Text' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'cpp', label: 'C++' },
  { id: 'csharp', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'php', label: 'PHP' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'swift', label: 'Swift' },
  { id: 'kotlin', label: 'Kotlin' },
  { id: 'objectivec', label: 'Objective-C' },
  { id: 'vbnet', label: 'VB.NET' },
  { id: 'sql', label: 'SQL' },
  { id: 'bash', label: 'Bash / Shell' },
  { id: 'xml', label: 'HTML / XML' },
  { id: 'css', label: 'CSS' },
  { id: 'scss', label: 'SCSS' },
  { id: 'less', label: 'Less' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'ini', label: 'INI / TOML' },
  { id: 'diff', label: 'Diff' },
  { id: 'lua', label: 'Lua' },
  { id: 'perl', label: 'Perl' },
  { id: 'r', label: 'R' },
  { id: 'graphql', label: 'GraphQL' },
  { id: 'makefile', label: 'Makefile' },
  { id: 'apache', label: 'Apache' },
  { id: 'wasm', label: 'WebAssembly' },
  { id: 'python-repl', label: 'Python REPL' },
  { id: 'php-template', label: 'PHP Template' },
]

const ALIAS: Record<string, string> = {
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  'c++': 'cpp',
  cs: 'csharp',
  yml: 'yaml',
  text: 'plaintext',
  txt: 'plaintext',
  toml: 'ini',
  mysql: 'sql',
  postgres: 'sql',
}

export function normalizeLang(lang?: string | null): string {
  const raw = String(lang || '').trim().toLowerCase()
  if (!raw) return 'plaintext'
  if (ALIAS[raw]) return ALIAS[raw]
  return raw
}

export function isRegistered(lang: string): boolean {
  const id = normalizeLang(lang)
  if (id === 'plaintext') return false
  try {
    return lowlight.registered(id)
  } catch (_) {
    return false
  }
}

/** 内置语言列表（按 lowlight 实际注册情况过滤，避免选项无效） */
export const LANGUAGES: LangOption[] = ALL_LANGS.filter((l) => l.id === 'plaintext' || isRegistered(l.id))

export function langLabel(id: string): string {
  const target = normalizeLang(id)
  const hit = LANGUAGES.find((l) => l.id === target || normalizeLang(l.id) === target)
  if (hit) return hit.label
  return target
}

const PHP = /<\?php/
const BASHSHEBANG = /^#!\/(usr\/)?bin\/(env\s+)?(bash|sh)/m
const CPP = /#include\s*<[a-z_]+\.h?>|std::/
const CSHARP = /using\s+System(\.[A-Za-z.]+)?\s*;|^\s*namespace\s+[\w.]+\s*[;{]/m
const GO = /^\s*package\s+main\b|\bfunc\s+\w+\s*\(|\bfmt\.[A-Z]\w*\(|:=/m
const JAVA = /\bpublic\s+(final\s+)?(abstract\s+)?class\s+\w+|import\s+java\.|System\.out\.print|\bpublic\s+static\s+void\s+main\s*\(/
const PYTHON = /^\s*def\s+\w+\s*\([^)]*\)\s*(->\s*[\w\[\], .]+)?:\s*$|^\s*(from\s+[\w.]+\s+)?import\s+[\w.,\s*]+$|^\s*print\(/m
const SQL =
  /\bSELECT\b[\s\S]{0,400}?\bFROM\b|\bCREATE\s+(TABLE|INDEX|VIEW|DATABASE)\b|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bALTER\s+TABLE\b/i
const TYPESCRIPT =
  /^\s*(export\s+)?interface\s+\w+|:\s*(string|number|boolean|any|void|unknown)\b\s*[;,)\]}=]|import\s+[\s\S]{0,80}?from\s+['"]@\/|<\w+>\(|\bas\s+(const|string|number)\b/m
const JAVASCRIPT =
  /\bconsole\.(log|error|warn|info)\s*\(|\bfunction\s+\w*\s*\(|(const|let|var)\s+\w+\s*=\s*\(?[\w\s,{}]*\)?\s*=>|\brequire\s*\(\s*['"]|document\.(getElementById|querySelector)\(|===\s*|!==\s*/
const HTML = /<!DOCTYPE\s+html|<html[\s>]|<div[\s>]|<span[\s>]|<template[\s>]|<body[\s>]/i
const CSS =
  /^\s*[.#@]?[\w\-\[\]="':() >,.#]+\s*\{[^}]*\b(color|margin|padding|display|background|font-size|border|flex|grid)\s*:/m
const JSX = /<\/[A-Z][\w.]*>|<\/[a-z]+>/
const JSON_LIKE = /^\s*[[{][\s\S]*[\]}]\s*$/

/**
 * 按文档规则从高到低判定语言；全部未命中返回 plaintext。
 * 仅在「粘贴进空代码块」时调用，不覆盖用户已选语言。
 */
export function detectLanguage(text: string): string {
  const src = String(text || '')
  if (!src.trim()) return 'plaintext'
  if (PHP.test(src)) return 'php'
  if (BASHSHEBANG.test(src)) return 'bash'
  if (CPP.test(src)) return 'cpp'
  if (CSHARP.test(src)) return 'csharp'
  if (GO.test(src)) return 'go'
  if (JAVA.test(src)) return 'java'
  if (PYTHON.test(src)) return 'python'
  if (SQL.test(src)) return 'sql'

  if (JSON_LIKE.test(src)) {
    try {
      const parsed = JSON.parse(src)
      if (parsed && typeof parsed === 'object') return 'json'
    } catch (_) {}
  }

  if (TYPESCRIPT.test(src)) return 'typescript'
  if (HTML.test(src)) return 'xml'
  if (JAVASCRIPT.test(src)) {
    if (JSX.test(src)) return 'javascript'
    return 'javascript'
  }
  if (CSS.test(src)) return 'css'
  return 'plaintext'
}
