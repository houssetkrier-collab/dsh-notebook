# dsh-notebook

一个零依赖的 **DSH 插件**示例兼实用工具：把「笔记」做成模型可直接调用的 5 个工具 + 1 个斜杠命令，落在本地 markdown 目录里，跨会话留存。

```
note_save   写入/覆盖一篇笔记（标题自动派生 id，支持标签）
note_list   按更新时间倒序列出，可按标签过滤
note_read   按 id 读全文
note_search 标题+正文不区分大小写子串搜索，返回命中行号
note_delete 删除一篇笔记
/note       人类侧的同一套能力：list / read / save / search / del / help
```

## 为什么这样写（DSH 插件契约）

| 事实 | 出处 |
| --- | --- |
| 宿主侧插件就是一个 ESM 模块，导出 `name` / `inject` / `apply(ctx, config)` | `@deepseek-ai/dsh-tool-todo`、`@deepseek-ai/dsh-command-goal` 的 `lib/index.js` |
| `inject` 声明需要的服务：`tools`、`commands`（本项目两个都用） | 同上 |
| 工具注册：`ctx.tools.register({ name, description, parameters, output: { schema, render }, execute })` | `@deepseek-ai/dsh-tools` 的 `lib/types/*.d.ts` |
| 注册表只硬性要求 `output.render` 是函数 + `output.schema` 通过 `assertSupportedJsonSchema`，工具名不能是保留的 `run_code` | `@deepseek-ai/dsh-tools/lib/index.js` |
| **入参校验只存在于 `defineTool` 包装里**；手写 definition 不会自动校验参数 | 同上（`validateArgs` 仅在 `defineTool` 内调用） |
| 命令注册：`ctx.commands.register({ name, description, input: { hint, attachments }, handler })`，handler 收到 `{ commandId, agent, rawInput, attachments, signal }`，返回 `{ kind: 'success' \| 'error', text }` | `@deepseek-ai/dsh-commands/lib/types/index.d.ts` |
| profile 层：`~/.dsh/profiles/<profile>/cordis.patch.yml` 是顶层数组，`- insert: [...]` 追加插件条目；`DEFAULT_PROFILE_PATCH_RELOAD = "live"`，长驻宿主会热加载这一层 | `@deepseek-ai/dsh-app-boot/lib/index.js` |

因为不走 `defineTool`，本项目自带一层入参检查（`expectArgs`）：缺字段、类型不对、超长都会抛出模型可读的错误，而不是把脏参数写进磁盘。

**零裸导入（zero bare imports）**：插件源码放在仓库任意目录，通过 junction 进 profile 的 `node_modules`；Node 按 realpath 解析裸模块，那里没有 `@deepseek-ai/*`，所以插件只 `import 'node:fs' / 'node:path' / 'node:os'`。好处是这份代码也能直接被 Node 当普通模块加载和测试。

## 存储格式

`~/.dsh/notebook/<id>.md`，人类可读、任何编辑器都能改：

```markdown
# 重构 Runner 的八个分支
<!-- notebook-meta {"tags":["runner","refactor"],"created":"2026-10-20T12:00:00.000Z","updated":"2026-10-20T12:03:11.000Z"} -->
第一条：拆 run/replay。
第二条：保留 cursor。
```

- `id` 由标题 slug 化（保留中文/字母/数字，其余归并为 `-`，上限 60 字符）；同名再存会分配 `-2`、`-3`；`overwrite: true` 时原地更新并保留 `created` 与已有标签。
- 写入是「临时文件 + rename」，崩在半路也不会留下截断的笔记。
- `id` 拒绝 `/`、`\`、`..`、点开头、以及 Windows 文件名非法字符，越界路径写不进去。

## 配置

`cordis.patch.yml` 里的 `config` 全部可选：

| key | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `~/.dsh/notebook` | 笔记目录，不存在会自建 |
| `maxNotes` | `200` | 笔记上限，超过就报错让你清理 |
| `maxNoteBytes` | `262144` | 单篇正文上限（256 KiB） |

## 安装

```powershell
node scripts/install.mjs                       # 装进 desktop profile，用默认配置
node scripts/install.mjs --profile desktop,web # 多个 profile
node scripts/install.mjs --dir D:\notes --max-notes 500
node scripts/install.mjs --dry-run             # 只看要改什么
node scripts/install.mjs --uninstall           # 卸载
```

安装器只动两处：`<profile>/node_modules/dsh-notebook` 这个 junction，和 `<profile>/cordis.patch.yml` 里的一条 `- insert:` 条目（**先备份为 `.bak-notebook-<时间戳>`**）。它不碰 `package.json`、lockfile 和 app 包体，所以不需要 `pnpm install`；写入前会用 profile 自带的 `yaml` 包把新内容重新解析一遍，解析不过就拒绝落盘。

装完重启 DSH 桌面端/对应 profile 即可；长驻进程会热加载 patch 层（`DEFAULT_PROFILE_PATCH_RELOAD = "live"`），通常不必重启。

手动安装等价于：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-notebook" "%CD%"
# 然后在 cordis.patch.yml 末尾追加：
# - insert:
#     - id: dsh-notebook
#       name: dsh-notebook
```

## 验证

```powershell
node test/verify.mjs         # 21 项功能检查：五个工具 + /note 全部子命令，输出按各自 output.schema 校验
node test/sdk-check.mjs      # 把 parameters / output.schema 喂给真实 dsh-tools 校验器
node test/profile-check.mjs  # 用 dsh-app-boot 的 patch 组合器验证插件真的进了 profile 的加载树
```

`test/verify.mjs` 用假 ctx 收集注册项，直接 `execute`，并对每个返回值跑一遍 schema 校验（`render` 也必须返回 text block）；`test/sdk-check.mjs` 通过绝对路径加载 `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js`，调用宿主注册时用的 `assertObjectJsonSchema` / `assertSupportedJsonSchema` / `jsonSchemaToTs`；`test/profile-check.mjs <profile>` 调 `loadOptionalPatches` + `composeEntries`，确认宿主自己的组合逻辑产出 `{ id: 'dsh-notebook', name: 'dsh-notebook' }` 且没有针对它的跳过告警。

三层都在真实安装上跑过：装进 desktop profile 后**当轮就能调用 `note_list`**（`DEFAULT_PROFILE_PATCH_RELOAD = "live"` 热加载，无需重启），`note_save` / `note_list` / `note_search` / `note_delete` 均在运行中的宿主里实调通过。

## 如果 `git push` 连不上 github.com

有些网络只放通 `api.github.com`，`git push` 会挂在 `Could not connect to server`。此时用：

```powershell
node scripts/push-api.mjs --dry-run   # 先看要上传哪些对象
node scripts/push-api.mjs             # 上传 blobs → tree → commit → 移动 refs/heads/main
```

它按 `git ls-tree -r HEAD` 逐个上传 blob，再组 tree/commit 并移动分支 ref，每一步都把返回的 sha 与本地仓库比对（blob sha、tree sha 必须一致，commit sha 不同只告警）。凭据取 `GITHUB_TOKEN`，否则读 `gh auth token`。

## 目录

```
index.js            插件本体（唯一运行时文件，零依赖）
cordis.patch.yml    profile 补丁模板（含 config 示例）
scripts/install.mjs 安装/卸载器（junction + patch 条目 + YAML 回读校验 + 备份）
scripts/push-api.mjs 走 REST API 推 HEAD（github.com:443 被墙、只剩 api.github.com 时用）
test/verify.mjs     功能验证（21 项）
test/sdk-check.mjs  真实 SDK 的 schema 一致性验证
test/profile-check.mjs 真实 profile 的 patch 组合验证
```
