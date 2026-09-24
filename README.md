# dsh-github-sync-with-attachments

**在 [`dsh-github-sync`](https://github.com/minghuo/dsh-github-sync) 0.4.3 基础上，把 dsh 的附件存储（`$DSH_HOME/attachments`）也纳入 GitHub 私有仓库备份。**

原插件只镜像 `sessions/`、`profiles/`、`settings.yaml`。而会话日志里的图片是按
`sha256:<hex>` 引用 `$DSH_HOME/attachments/v1/objects/**` 的：会话备份恢复到了新机器上，
附件却没有跟着过去，于是**那个会话的每一次请求都会在本地就失败**——`dsh-llm-deepseek`
在发请求前读取图片，缺对象直接抛 `ATTACHMENT_NOT_FOUND`，再被统一包成
`LlmError("DeepSeek API stream from https://api.deepseek.com failed", "TRANSPORT")`。
界面上看起来像"DeepSeek 挂了"，实际是本机缺图。这个 fork 就是为了不再踩这个坑。

```
instances/
  laptop-a-7f3c/
    manifest.json                     这台机器的清单（主机名/分组/统计/工作区）
    sessions/<工作区目录名>/<会话ID>/session[.vN].jsonl.zstd
    attachments/v1/objects/<xx>/<sha256>           ← 本 fork 新增，图片对象
    attachments/v1/file-objects/<xx>/<sha256>      ← 非图片附件对象
    attachments/v1/files/<xx>/<sha256>/<原文件名>   ← 硬链接别名（git 内容寻址不额外占空间）
    plugins/<profile>/{package.json,cordis.patch.yml,pnpm-lock.yaml,pnpm-workspace.yaml}
    settings/settings.yaml            可选，默认关闭
  desktop-2a91/
    …
```

**不镜像的两棵树**（都是本机派生数据，不是持久状态）：

| 路径 | 为什么不备份 |
|---|---|
| `attachments/v1/tmp/` | 发布中的暂存文件——对象要等它被硬链接到位才存在，传上去只能拿到半成品 |
| `attachments/v1/request-images/` | 请求期归一化缓存。文件名是"变体身份"（源 ref + 该模型的图片策略）的摘要而非内容摘要；缺条目不算错误——`readImageRequest()` → `readCached()` 遇 ENOENT 返回 undefined，`createRequestImage()` 会从持久对象重新生成。镜像它等于把会随模型策略变化的派生物永久写进 git 历史 |

## 与原插件的差异

改动集中在一处语义：`attachments` 成为一个独立开关的镜像分组。

| 文件 | 改了什么 |
|---|---|
| `src/sync.js` | `GROUPS` 增加 `attachments`（放在 `sessions` 之后）；`buildPlan()` 扫描整棵 `$DSH_HOME/attachments`；`mapRepoPathToLive()` / `mapLivePathToRepo()` 增加 `attachments/…` 双向映射；新增 `invalidAttachmentReason()`，恢复时按路径承诺的 sha256 校验内容，坏块直接跳过；恢复后的对象按存储约定置为 `0400` 只读 |
| `src/paths.js` | 新增 `isExcludedAttachmentPath()`（排除 `tmp/`、`request-images/`、`*.tmp`、`.dsh-*`）与 `attachmentDigestOf()`（识别 `objects/`、`file-objects/`、`files/<xx>/<digest>/<name>` 三种内容寻址路径；`request-images/` 的变体名不是内容摘要，因此不会被误判） |
| `src/legacy.js` | **新增**：从原插件的两个存储层（`settings.yaml` 的 `dsh-github-sync:` 段、`dsh-github-sync/config.json`）一次性读取仓库地址与令牌，免去重新填写 |
| `src/index.js` | 自己的 settings 命名空间 / 路由前缀 / 状态目录；`syncAttachments` 默认开启；首次运行沿用原插件的 `instanceId` 并落盘；`/status` 增加本机附件计数；整机拉取与工作区恢复默认带上附件 |
| `client/index.js` | 附件开关与文案、本机附件数量、"上次结果 / 差异"里每个分组各自一行；`scripts/build-client.mjs` 为重建 `client/bundle.js` 的脚本（已逐字节验证与 0.4.3 的构建产物一致） |
| `cordis.patch.yml` | 行 id 用本包名，可与原插件并存而不撞 id（但**不要同时指向同一个仓库**，见下） |

交互、路由语义、推拉流程、快照、PR 模式等其余行为与原插件一致。

## 安装（替代原插件）

新插件是**替代品**，不是补充：两者同时指向同一个仓库时，原插件不认识
`attachments/` 分组，会把本插件推上去的附件当成"本地已删除"而删掉。

```bash
# 1. 移除原插件（保留它的 settings 段与 state.json，本插件会读取）
dsh plugin --profile web remove dsh-github-sync

# 2. 安装本插件（三选一）
dsh plugin --profile web add github:BerryPod/dsh-github-sync-with-attachments
dsh plugin --profile web add file:/path/to/dsh-github-sync-with-attachments   # 本地克隆
# 发布到 npm 之后：dsh plugin --profile web add dsh-github-sync-with-attachments

# 3. 重启 dsh web
```

装完打开 **设置 → GitHub 同步**：

- 仓库地址 / 分支 / 令牌应当已经自动带过来（来自原插件的配置）；
- "备份内容"里多了一项 **附件 attachments**，默认开启；
- 概览里能看到本机附件数量与体积，第一次推送会明显变大（图片多的话几十 MB）。

## 兼容与迁移

- **实例 ID 沿用**：首次运行时若本插件没有 `state.json`，会读取
  `$DSH_HOME/dsh-github-sync/state.json` 的 `instanceId` 并写入自己的状态目录，
  因此仓库里仍然只有 `instances/<原ID>/` 一棵树，历史备份照常可恢复。
- **凭据沿用**：`baseSettings()` 会从原插件的 settings 段 / `config.json` 取值，
  优先级为 组合层 config < 原插件配置 < 用户层设置。
- **状态目录**：`$DSH_HOME/dsh-github-sync-with-attachments/`（快照也在其中，
  原插件的 `snapshots/` 不会自动搬过来）。
- **API 版本**：`API_VERSION = 5`，客户端 `REQUIRED_API = 5`；页面比宿主新时会提示重启。

## 已知取舍

- **仓库体积**：附件只增不减（内容寻址，与 git 的去重天然契合），
  长期使用要留意仓库大小；`maxFileMb` 默认 45，超过的单个附件会被跳过并在结果里列出。
- **工作区级恢复会带上全部附件**：附件存储是机器级共享的，没有"只属于某个工作区"的
  子集，所以按工作区恢复默认把整个附件 store 一起拉下来。不想要可以传
  `{"attachments": false}` 给 `/restore`。
- **删除同步**：关掉"附件"开关时不会删除云端已有附件（沿用原插件的分组保护逻辑）；
  开着开关而本地附件被删掉时，云端对应文件会被删除——这正是"本地状态即真相"的原语义。
- **只读恢复**：附件对象恢复后是 `0444`。若之后要手工改动这类文件，先 `chmod`。

## 验证

```bash
npm run build:client      # 由 client/index.js 重建 bundle
npm test                  # 16 个测试：分组/映射/删除保护/摘要校验/端到端恢复/迁移/装载
```

测试全部跑在临时 `$DSH_HOME` 与本地"伪远端"目录上，不碰网络、不碰真实仓库。
其中端到端用例覆盖「盘点 → 仓库路径 → 恢复 → 落盘字节与权限」，以及坏块被跳过。

### 发布：`github.com:443` 被封锁时

有些网络（典型是部分国内线路）会把 `github.com` 的 443 端口整条掐断——`git push`
直接报 `GnuTLS recv error (-54)`——但 `api.github.com` 仍然可达。这种环境下可以用
Git Data API 把本地提交原样发布出去：

```bash
node scripts/publish-via-api.mjs --dry-run     # 先看会做什么
node scripts/publish-via-api.mjs               # 真正发布
```

它读取 `$DSH_HOME/settings.yaml` 里 `dsh-github-sync.token`（也可用 `GITHUB_TOKEN`
环境变量覆盖），逐 blob 比对摘要后创建 tree/commit，并**强制要求远端提交的 SHA 与
本地 `HEAD` 一致**，最后再读回来逐个文件核对。令牌不打印、不进 argv、不落盘。

长期方案仍是修好通道：`/etc/hosts` 把 `github.com` 指到一个可达的 GitHub 边缘 IP，
或者注册 SSH key 后走 `ssh.github.com:443`（该端口在实测中可用）。

想先看会推什么，可以在不改动任何东西的前提下盘点一次：

```bash
DSH_HOME=~/.dsh node --input-type=module -e "
import { buildPlan } from './src/sync.js'
const p = await buildPlan({ home: process.env.DSH_HOME, instanceId: 'dry-run', groups: { sessions: true, attachments: true, plugins: true } })
console.log(p.totals, p.skipped)
"
```

## 许可证与来源

MIT，见 `LICENSE`。

本仓库是 [`minghuo/dsh-github-sync`](https://github.com/minghuo/dsh-github-sync)
`0.4.3`（`main` @ `905b02c4cc`）的 fork，上游同样以 MIT 发布，版权行
`Copyright (c) 2026 dsh-github-sync contributors` 已在 `LICENSE` 中**原样保留**；
未改动的部分版权归上游，本 fork 的修改部分（attachments 分组、迁移、测试）
版权归 [BerryPod](https://github.com/BerryPod)。

本仓库：<https://github.com/BerryPod/dsh-github-sync-with-attachments>。
上游若合并同类功能，欢迎以上游实现为准——分叉的动机只是"先把附件一起备上"，
并不打算在别处偏离上游行为。
