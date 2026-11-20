'use strict'
/**
 * Jam 启动器：源码没变时跳过 vite build，直接启动 Electron。
 *
 * 用法：
 *   npm start                 按需构建后启动（默认）
 *   node scripts/start.cjs --dry-run   只判断是否需要构建，不启动
 *   node scripts/start.cjs --force     强制重新构建后启动
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const distDir = path.join(root, 'dist')
const distHtml = path.join(distDir, 'index.html')
const force = process.argv.includes('--force')
const dryRun = process.argv.includes('--dry-run')

const SCAN_DIRS = ['src', 'electron', 'public', 'build', 'scripts']
const SCAN_ROOT_FILES = ['index.html', 'vite.config.ts', 'package.json', 'tsconfig.json', 'electron-builder.yml']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'data', 'release', '.git', '.workbuddy', 'backups'])
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.scss', '.html', '.json', '.yml', '.yaml', '.png', '.ico', '.svg'])

function collectSources() {
  const out = []

  const visit = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (SOURCE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(full)
    }
  }

  for (const name of SCAN_ROOT_FILES) {
    const full = path.join(root, name)
    if (fs.existsSync(full)) out.push(full)
  }
  for (const name of SCAN_DIRS) visit(path.join(root, name))
  return out
}

function distLooksComplete() {
  if (!fs.existsSync(distHtml)) return false
  const assets = path.join(distDir, 'assets')
  if (!fs.existsSync(assets)) return false
  const names = fs.readdirSync(assets)
  return names.some((n) => n.endsWith('.js')) && names.some((n) => n.endsWith('.css'))
}

function needsBuild() {
  if (force || !distLooksComplete()) return true
  const builtAt = fs.statSync(distHtml).mtimeMs
  return collectSources().some((file) => fs.statSync(file).mtimeMs > builtAt)
}

function cleanEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function runBuild() {
  const viteCli = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!fs.existsSync(viteCli)) {
    console.error('[start] 缺少依赖，请先执行 npm install')
    process.exit(1)
  }
  console.log('[start] 源码已变化（或缺少产物），正在构建前端...')
  const started = Date.now()
  const res = spawnSync(process.execPath, [viteCli, 'build'], {
    cwd: root,
    env: cleanEnv(),
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.error('[start] 构建失败，已中止启动')
    process.exit(res.status || 1)
  }
  console.log(`[start] 构建完成，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
}

function runElectron() {
  let electronPath
  try {
    electronPath = require('electron')
  } catch (_) {
    console.error('[start] 无法定位 Electron，请执行 npm install')
    process.exit(1)
  }
  console.log('[start] 启动 Jam...')
  const res = spawnSync(electronPath, ['.'], {
    cwd: root,
    env: cleanEnv(),
    stdio: 'inherit',
  })
  if (res.error) {
    console.error('[start] Electron 启动失败:', res.error.message)
    process.exit(1)
  }
  process.exit(res.status || 0)
}

const build = needsBuild()

if (dryRun) {
  console.log(build ? '[start] DRY-RUN: 需要重新构建' : '[start] DRY-RUN: 可直接启动（跳过构建）')
  process.exit(0)
}

if (build) runBuild()
else console.log('[start] 源码未变化，跳过构建，直接启动')

runElectron()
