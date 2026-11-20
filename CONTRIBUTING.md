# Jam 协作开发规范

为保障 `master` 主干稳定，多人协作时统一遵循「**先签分支、测试通过、再提 PR 合并**」的流程。

## 分支模型

- `master`：唯一主干分支，只接收合并，**禁止直接 push**。
- 其他分支：全部为临时工作分支，从最新的 `master` 签出，完成后通过 Pull Request 合并回 `master`。

## 标准流程

1. **同步主干**
   ```bash
   git checkout master
   git pull origin master
   ```

2. **签新分支**（命名见下表）
   ```bash
   git checkout -b feature/棋盘格代码高亮
   ```

3. **开发与本地测试**（提交前必须通过）
   ```bash
   npx tsc --noEmit          # 类型检查
   node scripts/verify.cjs   # 语言识别 + zip 回环校验
   npm run build             # 前端构建
   # 涉及编辑器/界面改动时，追加 Electron 冒烟：
   env -u ELECTRON_RUN_AS_NODE JAM_SMOKE=1 ./node_modules/.bin/electron .
   ```
   冒烟前建议备份 `data/data.json`，测试后恢复并清理 `data/backups/*-smoke.zip`。

4. **提交并推送分支**
   ```bash
   git add -A
   git commit -m "feat: 简短说明本次改动"
   git push -u origin feature/棋盘格代码高亮
   ```

5. **创建 Pull Request**
   - 目标分支选择 `master`。
   - 说明改动内容、验证方式与影响范围。
   - 等待 CI 全部通过（`build` 检查）。CI 未通过不得合并。

6. **合并**
   - 由审查者在 GitHub 上合并 PR；合并后删除已合并的临时分支。

## 分支命名约定

| 前缀 | 用途 | 示例 |
|---|---|---|
| `feature/` | 新功能 | `feature/markdown-outline` |
| `fix/` | 缺陷修复 | `fix/trash-close` |
| `refactor/` | 重构（不改行为） | `refactor/store-reconcile` |
| `docs/` | 文档 | `docs/contributing-guide` |
| `chore/` | 构建/依赖/脚本 | `chore/bump-vite` |

## 提交信息约定

采用 `<type>: <简短描述>`，type 常用 `feat` / `fix` / `refactor` / `docs` / `chore` / `test`。

## 版本同步提醒

涉及功能更新时，除代码外需同步四处版本信息（当前版本见 `src/lib/changelog.ts` 的 `APP_VERSION`）：
`src/lib/changelog.ts`、`package.json`、`scripts/dist.cjs`、`CHANGELOG.md`。

## 环境说明

- 本机如曾配置公司内网 CA（`http.sslCAInfo`），会导致访问 GitHub 时报证书链错误；请勿将内网证书设为全局 CA。
- 便携版 exe 通过 `npm run dist` 打包，产物在 `release/`（该目录与 `data/` 已加入 `.gitignore`，不入库）。
