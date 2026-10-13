# dsh-ptc-runtime

PTC 形态的能力运行时：**无常驻 JS 内核**，任意 MCP 服务器作为能力目录注入，执行交给 DSH 的 `ctx.ptcRuntime`（每次一个受管子进程，用完即弃）。

```text
DSH 模型
 │  cap_help / cap_call              ← adapter 恒为两个工具
 ▼
dsh-ptc-runtime-face                 ← 注册 DSH 工具
 │  ptcCapabilityRuntime
 ▼
CapabilityRuntime (PTC)              ← catalog + PTC 程序组装
 │  run_code(program, bindings)      ← 每次一个受管子进程
 ▼
DSH ctx.ptcRuntime                   ← 隔离、超时、输出上限、文件策略
 │
 ▼
外部 MCP provider（IDEA、Chrome、Cua ……）
```

与 [`node-repl-runtime`](../node-repl-runtime) 的关系：目录投影（连接、`tools/list` 投影、`include` 收窄、`inject` 宿主参数、图片 admission 的形状）照搬它的 `catalog.ts` / `types.ts`；**内核那一半（常驻进程、跨 cell 绑定、`js`/`js_reset` 面、`_images` 停靠）一律不带**。结构和字段命名刻意对齐，方便两边对账和将来合流。

## 包

```text
packages/runtime/          宿主侧：目录 + MCP 连接 + 会话恢复 + PTC 程序组装与执行
packages/adapter-dsh/      DSH 工具面：cap_help + cap_call（与 dsh-cap-catalog 同名，profile 二选一挂载）
packages/dsh-bootstrap/    把 runtime 以 Cordis 插件形式挂进 DSH profile
skills/                    任务级程序模板（多站截图聚合等），把发现税预付掉
docs/                      设计与实测记录
```

## 与 node-repl-runtime 的取舍对照

2026-10-12 在 3108（`web` profile、`mode: both`）用会话记录复测了延迟那两行：每个工具的耗时取
`tool/result.time − tool/call.time`。原始口径见
[`node-repl-runtime/docs/07`](../node-repl-runtime/docs/07-codemode-ptc-and-kernel-lifetime.zh-CN.md) §5。

| node-repl-runtime（常驻内核） | 本项目（PTC） |
|---|---|
| 绑定跨 cell 存活，多轮试探 ~585ms/次 | 每次新进程（实测 `pid` 19144→6728），推得 ~770ms/次，无跨程序状态（`globalThis.X` 在下一个程序里 ABSENT） |
| 单格开销 **~31ms 端到端**（n=6，28–73；内核自报 3–8ms。docs/07 的 ~13ms 是内核内部数，不是同一层） | 每程序 **~200ms 底座**（n=8，185–214；docs/07 记的 ~400ms 未复现） |
| 本地发现 6ms | 三级 `cap_help` 按需取（见 skills 预付） |
| 图片显式 `emitImage` | 图片走原生 image block + attachment（`deliver` 语义见 DESIGN） |
| 程序优先呈现 | dispatch 记录可审计，呈现待 DSH 侧修（见 DESIGN §呈现） |

**一句话**：每程序底座从 docs/07 记的 ~400ms 降到 ~200ms，所以"不能用每次一个程序替代每格一个 cell"
这条结论仍然成立，但代价从 **1.7×** 变成 **~1.3×**（同一 570ms provider 推算：601 vs 770）。结构没变 ——
程序仍是一次一个新进程、仍无跨程序状态，只是每次更便宜了。

## 开发

```bash
pnpm install
pnpm run verify   # check + test
pnpm run build
```

## 性能

先 `pnpm run build`（脚本读 `dist/`），再：

```bash
node scripts/bench-payload.mjs        # 本包对 provider 回复做的加工（映射块 + 归一 data）
node scripts/bench-program.mjs        # 一次真实形态的程序运行（runDirect 端到端）
node scripts/bench-scaling.mjs        # 复杂度检查：确认是线性而非 O(n²)
node scripts/bench-equivalence.mjs    # 等价性：证明优化只改速度、不改输出
node scripts/bench-memory.mjs         # 分配量：copy-on-write 省掉的重复对象图
node scripts/bench-tokens.mjs         # 模型上下文成本（每次请求都付）
```

测的是**本仓库的进程内开销**，不含 provider 本身、进程启动与 MCP 传输。比例上它只占一次程序运行的
~0.6%（每程序子进程底座 ~200ms，见 DESIGN §5），结论与数据见 [DESIGN §4.1](DESIGN.md)。
