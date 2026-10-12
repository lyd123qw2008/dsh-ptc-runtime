# dsh-ptc-runtime — 设计、边界与验收

> 一句话：**参照 node-repl-runtime 的结构和字段，重做一个 PTC 版**：目录投影照搬，执行交给 DSH `ctx.ptcRuntime`，不含常驻内核、不管理任何跨调用 JS 状态。
>
> 工具面沿用 `cap_help` / `cap_call`（与 dsh-cap-catalog 同名），通过 profile 二选一挂载，避免同时注册冲突。

## 1. 结构镜像对照

| node-repl-runtime | 本项目 | 说明 |
|---|---|---|
| `packages/runtime/src/types.ts` | `packages/runtime/src/types.ts` | `McpProviderSpec` / `ProjectedOperation` / `ProviderConnection` / `ProviderFailure` 字段对齐；删掉内核专属（`JsCellResult` / `JsOptions` / `kernelEntry` 等） |
| `packages/runtime/src/catalog.ts` | `packages/runtime/src/catalog.ts` | 原样搬：`projectOperation` / `selectTools` / `applyInjection` / `collectProviderImages` / `classifySessionLoss` / `describeProviderError` / 单 flight 重连 / progress 续期 |
| `packages/runtime/src/kernel.ts` + `bridge.ts` | `packages/runtime/src/ptc.ts` | 内核换成 PTC 程序组装：目录→ bindings，`cap_call` 语义→程序内多次 `tools.*` 调用；无常驻进程 |
| `packages/runtime/src/cli.ts` | `packages/runtime/src/cli.ts` | 同形态 demo：接一个 provider，跑一次程序 |
| `packages/adapter-dsh/src/index.ts` + `descriptions.ts` | 同路径 | 工具面 `cap_help` / `cap_call`，`target` 单字符串三级寻址、`title` 显示标签（照搬 dsh-cap-catalog 的成品） |
| `packages/dsh-bootstrap/src/index.ts` | 同路径 | 从配置/环境读 provider 列表，提供 runtime 服务，失败不拖垮整包 |

## 2. 字段对齐清单（相对 node-repl-runtime）

必带（分叉时漏掉、这次补回）：

- `McpProviderSpec.timeoutMs`（单静默调用预算）；
- `ProviderConnection.session?`（可重开的一半；没有它 IDE 重启后只能全量重连）；
- `call` 的 `onprogress` + `resetTimeoutOnProgress` + `MAX_PROVIDER_TOTAL_TIMEOUT_MS`（长构建不被误杀）；
- `classifySessionLoss` / `isSessionLoss`（`never-ran` 可重试，`maybe-ran` 写操作不自动重试）；
- `describeProviderError`（2000 截断，网关 HTML 不灌上下文）；
- stdio `stderr` 尾巴（起不来时有遗言）+ 失败即关 client（不漏子进程）；
- `operations` 用 getter（重连后自动是新目录）；
- **提供者的 `structuredContent` 随调用结果一起回给程序**（`PtcCallResult.data` / `CapCallValue.data`）：内核把它当作 cell 的返回值（`catalog.ts:655` 的 `structuredContent ?? content`），PTC 初版只渲染 `content`，等于把内核给程序的对象换成了一段 JSON 字符串。2026-10-12 补回，见 §3。

不带（内核专属）：`kernel.ts` / `bridge.ts` / `nr-cap` / `_images` 停靠 / `js` / `js_reset` / `JsCellResult` / binding 检查点。

**移植时多写的（已删，2026-10-12）**：`runDirect` 曾经在调用前把 `spec.inject` 合并进 args。但 `inject` 的唯一归属方是 connection（`catalog.ts` 的 `applyInjection`），它按设计**拒绝**调用方自带的 host-owned 键 —— 于是任何配了 `inject` 的 provider 走 `runDirect` 必失败。内核的调用点原样透传 args（`bridge.ts:214`，`inject` 在那个文件里除了注释一次都没出现），所以内核从来没有这个坑。同日 A/B：内核 CLI `--inject` 通（`ok 161ms`），PTC CLI 挂（`projectPath is host-owned and may not be supplied by the caller`）。修法是删掉那半句预合并。注意这个部署**没有任何 profile 配过 `inject`**（web / ptc-cap / alpha.2 均为 0），所以线上从未触发 —— 该特性在 PTC 侧此前一次都没真正跑通过。

## 3. PTC 语义（本项目新增）

- `deliver: 'inline' | 'metadata-only'`（默认 inline）：`metadata-only` 时图片不进自动转发，只回尺寸/哈希给程序做聚合；file 绕路不再需要。
- 程序模板 skill：第一个模板"多站截图聚合"（EXPERIMENT 跑过三次），模型改 URL 即跑，不从零规划。
- 批量取 schema：第三级 `target` 支持逗号分隔，一次取 N 个 op 的 schema（上限 8，通用机制，不认识任何 provider）。
- **模型侧只渲染 `content`，程序侧另给 `data`**（2026-10-12 定，同日修正过一次）：`CallToolResultSchema` 里 `content` 是 `ZodDefault`（保证存在）、`structuredContent` 是 `ZodOptional`。这两个消费方在 PTC 面被强行合到一起（工具结果同时要变成模型可见内容），所以这里**拆开而不是合并**：`blocks` 由 `content` 渲染给模型（服务器自己的紧凑排版、不重复），`data` 原样带 `structuredContent` 给程序。
- **图片元数据提升到顶层 `images`**（2026-10-12 加）：回复里的图片**不一定在 `blocks[0]`** —— playwright 的 `browser_take_screenshot` 是 `[text, image]`（metadata-only 时是 `[text, image-meta]`）。程序按 `blocks[0].bytes` 取会拿到 `undefined`，而自有属性值为 `undefined` 会让整个 `run_code` 以 `invalid-output: program completion must be lossless JSON` 失败。3108 实测复现：`kinds: ["text","image-meta"]`、`blocks[0]` 是正文、真正的 image-meta 块字段齐全。`CapCallValue.images` 按服务器顺序把每张图摊平成 `{kind:'meta', mimeType, bytes, hash}` 或 `{kind:'attachment', attachmentId, mediaType, bytes, width, height}`，**永远存在**（无图时为空数组），程序不再需要索引或 `find`。同时 `deliver` 加了 `enum`：写错值从"静默当 inline（像素照样进对话）"变成明确拒绝。**`bytes` 在两支里不是同一个量**（固有，不是疏忽）：`meta` 支看不到存盘字节，报的是**服务器发出的**（由 base64 长度推得）；`attachment` 支报的是**attachment 存盘归一化后的**。实测同一页面 9912 vs 9911 —— 比大小够用,不是校验和,别当校验和用。
- **初版写错了**：原注释和本文档写成"与 node-repl-runtime `catalog.ts:655` 同一重心"，这是错的。内核交给 cell 的是 `structuredContent ?? content` —— **一份、优先结构化**；而且内核从不渲染给模型，所以它根本没有"重复"要避免。照搬内核，程序拿到的是**对象**（实测：`idea.search_text` → keys `["items"]`，可直接 `r.items`；`cua.list_windows` → 8,295 字符结构化）。只渲染 `content` 会把对象降级成 JSON 字符串，Cua 上还丢掉散文自报省略的字段（`space_ids omitted`）。

## 3.1 实测记录（2026-10-12，四台 provider）

两轮修正过一次结论，留在文档里免得再犯：

| provider | `content` | `structuredContent` |
| --- | --- | --- |
| IDEA | 结果的 JSON | **同一份值**（`search_text` 各 150,565 字符） |
| Playwright | 散文 | 无 |
| Engram | 结果的 JSON | 无 |
| Cua Driver | 散文（自报省略字段） | 更大的完整数据（12,957 字符） |

- 重复不是 SDK 造的：`appendTextFallbackForNonObject`（SDK `textFallback.ts:579`）只给**非对象**的 `structuredContent` 补 text block，IDEA 发的是对象，所以那份副本是服务器自己写的。
- **progress token 是对齐的**（推翻过一次猜测）：SDK 注册 `progressToken = <自己的请求 id>`，IDEA 原样回报。实测 2/2 匹配、0 未知。那条 `unknown token: 6` 日志来自**另一个 DSH 进程**连同一台服务器（各自的 id 计数器）。所以不动 token 机制，只在 `report()` 里丢掉迟到通知（`isLateProgressNotification`），免得它和"session 丢失""服务器不可达"共用一行日志。

## 4. 验收（沿用 M1/M2 表）

M1（不依赖真实 DSH，hermetic）：工具面 token ≤1200；三级寻址 + 批量；失败可见；`inject` 拒绝；图片进 attachment；超时/会话恢复单测（抄 kernel-manager.test.ts 断言思路）。

M2（挂真实 preset，`mode: both`）：重跑 EXPERIMENT 三臂——head 回到 60s 内、输出 token 回到 5k 内、截 3 进 1 正确、9 条 dispatch 记录保留。

## 5. 风险

1. PTC 每程序底座：docs/07 §5 记 ~400ms、细粒度多轮试探 1.7×。**2026-10-12 在 3108 复测为 ~200ms**（n=8，185–214；同批内核单格 ~31ms 端到端），同口径推算降到 **~1.3×**。结构没变（每程序仍是一次新进程、无跨程序状态，实测 pid 19144→6728、`globalThis.X` 下一个程序 ABSENT），所以"把多步并进一个程序"这个缓解手段依然成立，只是优先级低了一档。复测口径见 README。
2. 与 dsh-cap-catalog 同名工具：同时挂载会冲突。缓解：profile 二选一；本项目成熟后冻结旧包（沿用 DESIGN §6.5 的 M3 判据）。
3. DSH 侧呈现（dispatch 清单无行号锚点）：不在本项目手里，并案去 DSH 提；本项目侧先做 `presentationMeta` 行号回传（零模型 token）。
