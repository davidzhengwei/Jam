/**
 * 打包：只产出便携 exe 到 release/，不保留 win-unpacked 中间目录。
 *
 * electron-builder 的 portable target 必然先解包出 win-unpacked 再生成单文件 exe。
 * 为让交付目录干净、且避开工作区索引对 app.asar 的文件锁，
 * 这里让 builder 输出到系统临时目录，完成后只把 exe 复制到 release/，再清理临时目录。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const releaseDir = path.join(root, 'release')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jam-dist-'))

function rmrf(p) {
  if (!fs.existsSync(p)) return true
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    return true
  } catch (_) {
    // 兜底：逐文件删（遇到个别被占用文件则跳过，主流程不受影响）
    try {
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const c = path.join(d, e.name)
          if (e.isDirectory()) walk(c)
          else {
            try { fs.unlinkSync(c) } catch (_) {}
          }
        }
      }
      walk(p)
      return !fs.existsSync(p)
    } catch (_) {
      return false
    }
  }
}

function main() {
  console.log('[dist] 临时输出目录:', tmpDir)

  const builder = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
  const args = [
    '--win', 'portable',
    '--config', 'electron-builder.yml',
    '-c.win.signAndEditExecutable=false',
    '-c.directories.output=' + tmpDir,
  ]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const res = spawnSync(builder, args, { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' })
  if (res.status !== 0) {
    console.error('[dist] electron-builder 失败，退出码', res.status)
    process.exitCode = 1
    return
  }

  // 找到生成的便携 exe
  const exeName = 'Jam-2.0.6-portable.exe'
  const src = path.join(tmpDir, exeName)
  const found = fs.existsSync(src)
    ? src
    : (() => {
        const walk = (d) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const c = path.join(d, e.name)
            if (e.isDirectory()) {
              const r = walk(c)
              if (r) return r
            } else if (/portable\.exe$/i.test(e.name)) return c
          }
          return null
        }
        return walk(tmpDir)
      })()

  if (!found) {
    console.error('[dist] 未找到生成的 portable exe')
    process.exitCode = 1
    return
  }

  fs.mkdirSync(releaseDir, { recursive: true })
  const dst = path.join(releaseDir, exeName)
  fs.copyFileSync(found, dst)
  console.log('[dist] exe 已输出:', dst)

  // release/ 只保留 exe：清掉 electron-builder 留下的调试文件与旧中间目录
  for (const stale of ['builder-debug.yml', 'builder-effective-config.yaml']) {
    try { fs.rmSync(path.join(releaseDir, stale), { force: true }) } catch (_) {}
  }

  // 根目录也放一份，便于直接双击启动
  const rootDst = path.join(root, exeName)
  try {
    fs.copyFileSync(found, rootDst)
    console.log('[dist] exe 已复制到项目根目录:', rootDst)
  } catch (_) {}

  // 清理临时目录（含 win-unpacked）
  if (rmrf(tmpDir)) console.log('[dist] 临时目录已清理')
  else console.log('[dist] 临时目录部分文件被占用，位于:', tmpDir)
}

try {
  main()
} catch (e) {
  console.error('[dist] 失败:', e && e.message)
  process.exitCode = 1
}
