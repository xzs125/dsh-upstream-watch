# dsh-upstream-watch

DSH 插件：启动后自动检查上游 `deepseek-ai/deepseek-harness` 仓库的更新情况，有更新时通过**日志 + 侧栏角标**提醒。

## 功能

- **启动时自动检查**（`apply(ctx)` 时执行一次，fire-and-forget，不阻塞启动）
- **双通道检测**：
  - 优先本地 git clone（`git fetch` + HEAD/远程 tag 对比，最准确，需要 DSH 源码是官方仓库的 clone）
  - git 不可用时降级 GitHub API（未认证限流 60 次/小时，已做非数组响应防御）
- **分级提醒**：
  - 出现新 tag（如 `dsh-v0.1.0-rc.8`）→ **强提醒**：日志 WARN + 红色角标
  - 仅上游 master 有新提交 → **信息级**：日志 INFO + 黄色角标
  - 检查失败 → 日志 ERROR + 紫色角标
  - 已是最新 → 日志静默（debug）+ 蓝色角标（hover 显示"已是最新"）
- **去重**：状态持久化到状态文件，只有检测到**新的**变化才打日志提醒；本地已最新则完全静默
- **详情**：hover 角标显示版本对比、领先提交数、最近 5 条提交标题、检查时间；点击打开 GitHub compare 页

## 提醒方式

| 状态 | 日志 | 侧栏角标（`sidebar.footer.action`） |
|------|------|------------------------------------|
| 有新版本 | `WARN` | 🔴 红 `#EE0000` |
| 仅 master 有新提交 | `INFO` | 🟡 黄 `#FFD700` |
| 检查失败 | `ERROR` | 🟣 紫 `#A855F7` |
| 已是最新 | 静默（debug） | 🔵 蓝 `#66CCFF` |
| 检查中（启动瞬间） | - | 淡灰 |

## 安装

1. 构建（需要 DSH 源码 checkout，产物为 `lib/`）：

   ```bash
   cd dsh-upstream-watch
   DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build.sh       # host 端
   DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/build-client.sh # client 端
   ```

2. 装配到 DSH profile（`<DSH_HOME>/profiles/web/`）：
   - `package.json` 的 `dependencies` 加 `"dsh-upstream-watch": "link:<插件绝对路径>"`
   - `dsh.profile.bundles` 数组加 `"dsh-upstream-watch"`
   - `node_modules` 建 symlink/junction 指向插件目录（link 依赖）
   - 重启 DSH（或使用超级模组注入器热装配）

## 配置

`cordis.patch.yml`（bundle 层）可覆盖：

```yaml
- insert:
    - id: upstream-watch
      name: dsh-upstream-watch
      config:
        # 显式指定 DSH 源码 checkout 目录（须含 .git），缺省自动探测
        # sourceDir: 'E:\Deepseek Harness'
        # 显式指定状态文件路径，缺省 $DSH_HOME/upstream-watch.json
        # stateFile: 'E:\Deepseek Harness Data\3081\upstream-watch.json'
        # 上游仓库（git remote + API fallback）
        # repoUrl: 'https://github.com/deepseek-ai/deepseek-harness'
        # 每次 git/API 操作超时（ms）
        # timeoutMs: 20000
```

`sourceDir` 自动探测顺序：配置 → `DSH_CHECKOUT` 环境变量 → 平台候选路径（Linux `/root/.local/share/dsh-source-3082/current`；Windows `E:\Deepseek Harness`）。

## API

- `GET /api/upstream-watch/status` → 当前检测状态 JSON（`status`: `pending|ok|info|strong|error`，含 `localVersion`/`upstreamLatestTag`/`aheadCount`/`recentCommits`/`compareUrl`/`error`）

## 状态文件

默认 `$DSH_HOME/upstream-watch.json`，记录上次检测结果与 `lastNotified*` 去重书签。

## 维护

- 源码在 WSL `/root/harness/dsh-upstream-watch`，Windows 侧副本 `E:\Agent\dsh-upstream-watch`（两份独立）：改代码需在 WSL 改 + `build` 后同步 `lib/` 产物到副本。
- `lib/` 与 `node_modules/` 不入库（`.gitignore`），clone 后需自行构建。
