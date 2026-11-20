/**
 * 生成 Jam 应用图标：
 * 1. 读取 AI 生成的猫图标原图（白色边框 + 圆角瓦片）
 * 2. 检测瓦片包围盒与圆角半径，裁切并做透明圆角
 * 3. 输出 build/icon.png(512) / build/icon.ico(16-256) / src/assets/jam.png(64)
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')
const png2icons = require('png2icons')

const SRC = path.join(__dirname, '..', 'build', 'cat-raw.png')
const OUT_DIR = path.join(__dirname, '..', 'build')

async function main() {
  const img = sharp(SRC).ensureAlpha()
  const { width, height } = await img.metadata()
  const raw = await img.raw().toBuffer()
  const CH = 4

  const isWhite = (x, y) => {
    const i = (y * width + x) * CH
    return raw[i] > 246 && raw[i + 1] > 246 && raw[i + 2] > 246
  }

  let top = -1, bottom = -1, left = width, right = -1
  for (let y = 0; y < height; y++) {
    let hit = false
    for (let x = 0; x < width; x++) {
      if (!isWhite(x, y)) { hit = true; if (x < left) left = x; if (x > right) right = x }
    }
    if (hit && top < 0) top = y
    if (hit) bottom = y
  }
  if (top < 0) throw new Error('找不到非白色内容')

  // 顶行非白跨度 -> 圆角半径
  let span0 = 0
  for (let x = 0; x < width; x++) if (!isWhite(x, top)) span0++
  const w = right - left + 1
  const h = bottom - top + 1
  let radius = Math.round((w - span0) / 2)
  radius = Math.max(8, Math.min(radius, Math.round(Math.min(w, h) * 0.3)))
  console.log(`tile: ${w}x${h} @(${left},${top}) radius~${radius}`)

  const cropped = sharp(SRC).extract({ left, top, width: w, height: h }).ensureAlpha()
  const maskSvg = Buffer.from(
    `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
  )
  const mask = await sharp(maskSvg, { density: 96 }).resize(w, h, { fit: 'fill' }).png().toBuffer()
  const tile512 = await sharp(
    await sharp(await cropped.toBuffer()).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()
  )
    .resize(512, 512, { fit: 'fill' })
    .png()
    .toBuffer()

  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), tile512)

  const ico = png2icons.createICO(tile512, png2icons.BILINEAR, 0, true)
  if (!ico) throw new Error('ico 生成失败')
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)

  const logo64 = await sharp(tile512).resize(64, 64, { fit: 'fill' }).png().toBuffer()
  const assetsDir = path.join(__dirname, '..', 'src', 'assets')
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true })
  fs.writeFileSync(path.join(assetsDir, 'jam.png'), logo64)

  console.log('written: build/icon.png, build/icon.ico, src/assets/jam.png')
}

main().catch((e) => { console.error(e); process.exit(1) })
