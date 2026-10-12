# 多站截图聚合（PTC 程序模板）

当任务是"打开 N 个页面、每个截图、汇总信息、只展示一张"时，直接用这个模板，
不要从零规划 `cap_help` → `cap_call` 流程。

## 模板

```js
// 1. 批量拿 schema（一轮，不是 N 轮）：
//    cap_help({ target: "playwright.browser_navigate,playwright.browser_snapshot,playwright.browser_take_screenshot" })

// 2. 逐站：导航 → 快照（取标题）→ 截图（metadata-only 聚合，像素不进对话）
const shots = [];
for (const url of URLS) {
  await tools.cap_call({ target: "playwright.browser_navigate", args: { url }, title: `导航 ${url}` });

  // 快照回复是 text 块（没有 structuredContent），标题在文本里的 `- Page Title: X` 行
  const snap = await tools.cap_call({ target: "playwright.browser_snapshot", title: `快照 ${url}` });
  const text = (snap.blocks || []).filter(b => b.kind === "text").map(b => b.text).join("\n");
  const title = (text.match(/^- Page Title: (.*)$/m) || [])[1] || "";

  const shot = await tools.cap_call({
    target: "playwright.browser_take_screenshot",
    args: { scale: "css" },
    deliver: "metadata-only",          // ← 这一行才是"像素不进对话"的把关者
    title: `截图 ${url}`,
  });
  // 图片元数据在顶层 `images` 里（永远存在，无图时为空数组），不要去索引 blocks
  const meta = shot.images[0] || null;
  shots.push({ url, title, bytes: meta ? meta.bytes : null, hash: meta ? meta.hash : null });
}

// 3. 只展示需要的那一张：同一操作，去掉 deliver 就是 inline
await tools.cap_call({ target: "playwright.browser_navigate", args: { url: SHOW_URL } });
await tools.cap_call({ target: "playwright.browser_take_screenshot", args: { scale: "css" }, title: "展示" });

return shots;
```

## 规则（违反这些就是在绕路）

- **只有 `tools.cap_help` / `tools.cap_call` 两个 binding。** PTC 的 SDK 投影的是**已注册的工具**，
  不是一个 provider 操作一个 binding —— `tools["playwright.browser_navigate"](…)` 不存在，写了直接报错。
  每次调用都是 `tools.cap_call({ target, args, deliver, title })`，`deliver` 放在**同一个对象里**，不是第二个参数。
- **读 `shot.images`，不要索引 `blocks`。** 截图回复是 `[text, image-meta]` —— 图片在 index **1**，`blocks[0]`
  是 playwright 的说明文字，所以 `shot.blocks[0].bytes` 是 `undefined`。`images` 是按服务器顺序摊平的数组
  （`{kind:"meta", mimeType, bytes, hash}` 或 `{kind:"attachment", attachmentId, mediaType, bytes, width, height}`），
  **永远存在**，无图时是空数组。真要给缺省值就用 **`null`**，不要用 `undefined` —— 自有属性值为 `undefined`
  会让整个 `run_code` 以 `code run failed (invalid-output): program completion must be lossless JSON` 失败
  （缺键合法，`undefined` 非法）。
- **`deliver: "metadata-only"` 才是"像素不进对话"的把关者，不是"程序没把它 return"。**
  DSH 会把**任何内容里带 image block 的成功子调用**主动塞进对话（`core/tools/src/ptc.ts` 的
  `deferContext(createUserMessage({ …, source: { kind: 'ptc-mode' } }))`）。实测（2026-10-12）：
  两个 `run_code` 都只返回块类型、都不返回图片，`metadata-only` 那次对话里没有图，
  默认 inline 那次对话里多了一条带图的 `user/message`。所以漏掉一个 `deliver` 就会漏一张图。
- **不要给截图操作传 `file`/`path`/`output` 参数**：文件落在 provider 进程 cwd（部署 profile），
  不在会话工作区，图片到不了对话，聚合步骤还会丢掉字节数。
- **结果形状是 `{ provider, operation, blocks, images, data }`**：图片元数据读 `images`（见上一条），
  不要读 `blocks` 里的块位置；`data` 只在服务器发布 `outputSchema` 时存在（playwright 不发）。
- **每个 `cap_call` 都写 `title`**：transcript 行显示意图（"截图 iana.org"），而不是只有
  `playwright.browser_take_screenshot`。
