/**
 * The model-visible documentation for the two-tool face.
 *
 * Mirrors `node-repl-runtime/packages/adapter-dsh/src/descriptions.ts` in role:
 * with only `cap_help` and `cap_call`, this text *is* the API documentation.
 * Differences from the kernel face: no persistent bindings to describe, no
 * `js_reset` recovery; instead the PTC semantics — one program, stateless runs,
 * `deliver` for image capture-vs-delivery, and batch schema lookup.
 */

export const CAP_HELP_TOOL_DESCRIPTION = [
  'Read the capability catalog: which MCP providers are attached, what each one offers, and the exact schema of one or more operations.',
  'Three levels, cheapest first, all addressed by `target`: omitted lists providers (including any that failed to attach and why); `"provider"` returns that provider\'s operations as JSON (`{"operations":[{"name","safety","summary"}]}`), so a program can iterate them instead of parsing prose; `"provider.operation"` returns that one operation\'s input and output schema.',
  'Batch schema lookup: `target` accepts comma-separated qualified targets (up to 8), e.g. `"playwright.browser_navigate,playwright.browser_snapshot"`, and returns each operation\'s schema in one call — one round trip instead of N.',
  'Nothing here calls a provider. When the catalog has changed on the server side (a server just started, or a tool was added), pass `refresh: true` to re-read it.',
  'Sizes: this tool never returns the whole catalog at once — ask for one level at a time so the schema you need is the schema you pay for.',
].join(' ')

export const CAP_CALL_TOOL_DESCRIPTION = [
  'Call one operation on one attached MCP provider: `target` is the qualified `provider.operation`, and `args` is a JSON object matching the schema `cap_help` reported for that target. For several operations, either call this tool repeatedly or write one batched program (see `deliver` and batch `cap_help`).',
  'Results come back as the provider sent them: text, structured content, and images (a screenshot arrives as an image you can see). A provider-reported tool failure becomes a tool error, so it is visible instead of looking like an empty success.',
  'In a program the value also carries `data`: the provider\'s own `structuredContent`, verbatim, present only when that server sends one. Read `data` directly (`data.items`) instead of parsing `blocks[0].text` — a server that publishes an `outputSchema` puts its machine-readable result there, and its prose may omit fields the structured form keeps.',
  'Images are lifted out of the blocks too: `images` is an array (empty when the reply has none) of `{ kind: "meta", mimeType, bytes, hash }` or `{ kind: "attachment", attachmentId, mediaType, bytes, width, height }`. Read it instead of indexing `blocks`: a screenshot reply is `[text, image]`, so the prose is at `blocks[0]` and `blocks[0].bytes` is `undefined` — which fails the entire run as non-lossless JSON.',
  'Image capture vs delivery: `deliver: "inline"` (default) lets an image enter the conversation; `deliver: "metadata-only"` returns sizes/hashes for aggregation without delivering pixels. Never use a file/path/output argument to dodge delivery: a file lands in the provider process working directory (the deployment profile), not the session workspace, and the aggregation step then loses the byte sizes.',
  'If a provider is missing or an operation name is wrong, the error lists what is actually available; host-owned arguments are refused rather than overwritten.',
].join(' ')
