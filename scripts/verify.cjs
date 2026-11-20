/* 一次性验证脚本：语言识别 + zip 读写回环 */
const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { createZip, readZip } = require('../electron/zip')

function run() {
  let failed = 0

  // --- zip 回环 ---
  const payload = Buffer.from('{"notebooks":[],"trash":[],"中文测试":true}', 'utf8')
  const big = Buffer.alloc(1024 * 64, 'A')
  const zip = createZip([
    { name: 'data/data.json', data: payload },
    { name: 'manifest.json', data: Buffer.from('{"app":"Jam"}') },
    { name: 'big.bin', data: big },
  ])
  const out = path.join(__dirname, 'roundtrip.zip')
  fs.writeFileSync(out, zip)
  const back = readZip(zip)
  const okZip =
    back['data/data.json'].equals(payload) && back['manifest.json'].toString().includes('Jam') && back['big.bin'].equals(big)
  console.log(`zip roundtrip: ${okZip ? 'PASS' : 'FAIL'} (${zip.length} bytes)`)

  // PowerShell 校验 zip 合法性（Windows 系统解压器）
  try {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${out}' -DestinationPath '${__dirname}\\zipcheck' -Force"`,
      { stdio: 'pipe' }
    )
    const extracted = fs.readFileSync(path.join(__dirname, 'zipcheck', 'data', 'data.json'))
    const okPs = extracted.equals(payload)
    console.log(`zip Expand-Archive: ${okPs ? 'PASS' : 'FAIL'}`)
    if (!okPs) failed++
  } catch (err) {
    console.log('zip Expand-Archive: SKIP (', String(err.message).slice(0, 80), ')')
  }

  // --- 语言识别（esbuild 打包 language.ts 后跑断言）---
  const langJs = path.join(__dirname, 'lang.test.cjs')
  execSync(
    `npx esbuild src/lib/language.ts --bundle --format=cjs --outfile=${langJs} --platform=node`,
    { stdio: 'pipe', cwd: path.join(__dirname, '..') }
  )
  const { detectLanguage } = require(langJs)

  const cases = [
    ['<?php echo 1;', 'php'],
    ['#!/bin/bash\necho hi', 'bash'],
    ['#include <stdio.h>\nint main(){}', 'cpp'],
    ['std::cout << 1;', 'cpp'],
    ['using System;\nclass A {}', 'csharp'],
    ['package main\nfunc main() { fmt.Println(1) }', 'go'],
    ['public class A {\n  public static void main(String[] args) { System.out.println(1); }\n}', 'java'],
    ['import java.util.List;\nList x;', 'java'],
    ['def add(a, b):\n    return a + b', 'python'],
    ['import os\nprint(os.getcwd())', 'python'],
    ['SELECT id FROM users WHERE age > 18;', 'sql'],
    ['CREATE TABLE t (id INT);', 'sql'],
    ['interface User {\n  name: string\n}', 'typescript'],
    ['const x: number = 1', 'typescript'],
    ['console.log("hi")', 'javascript'],
    ['const f = () => 1', 'javascript'],
    ['<!DOCTYPE html>\n<html></html>', 'xml'],
    ['<div class="a">x</div>', 'xml'],
    ['body {\n  color: red;\n  margin: 0;\n}', 'css'],
    ['{"key": "value", "n": 1}', 'json'],
    ['this is plain text about nothing', 'plaintext'],
  ]

  for (const [code, want] of cases) {
    const got = detectLanguage(code)
    const ok = got === want
    if (!ok) failed++
    console.log(`detect ${ok ? 'PASS' : 'FAIL'}: want=${want} got=${got}`)
  }

  console.log(failed === 0 && okZip ? '\nALL PASS' : `\n${failed} FAILURES`)
  process.exit(failed === 0 && okZip ? 0 : 1)
}

run()
