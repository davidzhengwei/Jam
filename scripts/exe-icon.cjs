/**
 * 读写 Windows exe 的图标资源（纯 JS，不依赖 rcedit/签名工具）
 * 用法：
 *   node scripts/exe-icon.cjs inspect <exe> [out.ico]   列出/导出图标资源
 *   node scripts/exe-icon.cjs set <exe> <icon.ico>      替换全部图标组 + 写版本信息
 */
const fs = require('fs')
const { NtExecutable, NtExecutableResource, Data, Resource } = require('resedit')

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

function main() {
  const [mode, exePath, extra] = process.argv.slice(2)
  if (!mode || !exePath) {
    console.error('usage: node scripts/exe-icon.cjs inspect|set <exe> [ico|outIco]')
    process.exit(1)
  }
  const exeBuf = fs.readFileSync(exePath)
  const exe = NtExecutable.from(toAB(exeBuf), { ignoreCert: true })
  const res = NtExecutableResource.from(exe)
  const groups = Resource.IconGroupEntry.fromEntries(res.entries)

  if (mode === 'inspect') {
    console.log(`exe size: ${(exeBuf.length / 1048576).toFixed(1)} MB`)
    console.log('icon groups:', JSON.stringify(groups.map((g) => ({ id: g.id, lang: g.lang, sizes: g.icons.map((i) => `${i.width}x${i.height}`) }))))
    const vi = Resource.VersionInfo.fromEntries(res.entries)
    if (vi.length) {
      for (const lang of vi[0].getAllLanguagesForStringValues()) {
        const s = vi[0].getStringValues(lang)
        console.log(`version[${lang.lang}/${lang.codepage}]:`, JSON.stringify({
          ProductName: s.ProductName, FileDescription: s.FileDescription, OriginalFilename: s.OriginalFilename, FileVersion: s.FileVersion,
        }))
      }
    }
    if (extra && groups.length) {
      // 导出第一个图标组为 .ico 便于肉眼核对
      const items = groups[0].getIconItemsFromEntries(res.entries)
      const out = new Data.IconFile()
      out.icons = items.map((it) => ({ data: it }))
      fs.writeFileSync(extra, Buffer.from(out.generate()))
      console.log('exported ->', extra)
    }
    return
  }

  if (mode === 'set') {
    const icoPath = extra
    if (!icoPath) throw new Error('缺少 ico 路径')
    const ico = Data.IconFile.from(toAB(fs.readFileSync(icoPath)))
    console.log('source ico images:', ico.icons.length)
    const targets = groups.length ? groups.map((g) => [g.id, g.lang]) : [[1, 0]]
    for (const [id, lang] of targets) {
      Resource.IconGroupEntry.replaceIconsForResource(res.entries, id, lang, ico.icons)
    }

    const keep = res.entries.filter((e) => e.type !== 16 /* RT_VERSION */)
    res.entries.length = 0
    for (const e of keep) res.entries.push(e)

    const vi = Resource.VersionInfo.createEmpty()
    vi.setStringValues(
      { lang: 0x409, codepage: 1200 },
      {
        ProductName: 'Jam',
        FileDescription: 'Jam',
        InternalName: 'Jam',
        OriginalFilename: 'Jam.exe',
        CompanyName: 'local',
        LegalCopyright: '',
        ProductVersion: '1.0.0',
      }
    )
    vi.setFileVersion(1, 0, 0, 0)
    vi.setProductVersion(1, 0, 0, 0)
    vi.outputToResourceEntries(res.entries)

    res.outputResource(exe)
    const out = Buffer.from(exe.generate())
    fs.writeFileSync(exePath, out)
    console.log(`patched -> ${exePath} (${(out.length / 1048576).toFixed(1)} MB, before ${(exeBuf.length / 1048576).toFixed(1)} MB)`)
    return
  }

  console.error('unknown mode:', mode)
  process.exit(1)
}

try {
  main()
} catch (e) {
  console.error('ERROR:', e && e.message ? e.message : e)
  process.exit(1)
}
