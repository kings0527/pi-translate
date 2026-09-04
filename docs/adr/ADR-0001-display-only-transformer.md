# ADR-0001: 译文上屏策略 —— display-only transformer + message_end 有界等待替换（v6）

- 状态：**Accepted（2026-09-04 v6 修订）** —— 触发了本文当初写下的重新考虑条款
- 关联：ADR-0002（CPU 风暴防复发）、ADR-0003（共享服务生命周期）

## 背景

pi 扩展对"实时翻译 thinking"有三个平台约束（源码实证，pi v0.84.x）：

1. `registerMarkdownTransformer` 是 **display-only 同步钩子**：只在渲染 markdown 时执行，返回值不写回 session、不进模型上下文。
2. Pi-TUI `Markdown` 组件按 `(source text, width)` **实例级缓存**渲染结果；`transform` 只在缓存 miss 时执行。
3. 扩展 API **没有**主动触发"已渲染消息重跑 transformer"的方法：`setStatus` 只更新 footer；`setWidget` 只重建 widget 容器并请求一帧，不会 invalidate 消息组件。

曾实现的替代方案（v4，2026-09-04 17:55 前）：在 `message_end` **同步等待**整段翻译完成，返回 `{ message }` 替换最终消息 —— 在持久化与 TUI 最终渲染**之前**生效，译文必然上屏且持久化即中文。代价：每个 assistant 消息的持久化思考变成中文（`/resume` 后模型上下文读到的 thinking 是译文，可能被误当成模型原生输出）；端到端等待整段翻译拖慢消息落盘；模型/服务故障会阻塞消息完成。

## 决策

v5 采用 **display-only 逐行 transformer + 主动刷帧**：

- 流式过程中对"已完结行"发起翻译（fire-and-forget），缓存命中即替换；
- 翻译完成回调 `triggerRefresh()`（`setWidget` nudge → `requestRender`），尽快进入下一帧；
- 不修改消息本体 → session 持久化 / 模型上下文保持英文原文（上下文零污染）；
- `max_tokens ≤ 256` + 行级去重 + 单飞请求，控制延迟与负载。

### v6 修订（尾行残留的修复）

独立复审确认（topic-review-pi-translate-v5）：终结帧的 `translateLine` 是 fire-and-forget，`message_end` 后定稿组件的 Markdown 缓存键 `(text,width)` 已命中，`triggerRefresh` 的普通帧不能使其重跑 transform —— 尾行译文要等下一次自然重渲染才回填，且这正是用户高频反馈的问题（触发了下文的重考虑条款）。

v6 叠加 **message_end 有界等待替换**（不是回到 v4 的全量同步等待）：

- 流式预翻译照旧先行 —— 定稿时绝大多数行已缓存；
- `message_end` 扫描 thinking 中仍无译文的行：无则**零开销返回 undefined**（不替换）；
- 有则触发翻译并**有界等待**（≤3s，轮询 100ms），拿到译文即返回同 role 替换消息 —— 首次正式渲染与 session 持久化即为中文；
- 超时未完成的行原样保留（自然重渲染自愈路径仍在）；
- `ctx.hasUI === false`（subagent / json 模式）直接跳过，不给 headless 消息加延迟。

### 翻译单元粒度（rationale）

翻译单元 = **行**，而非句子或词：实测 p50 ~152ms/行，与流式逐行预翻译、缓存去重、`inFlight` 限流全部咬合。标点/短句（如 "oh!"）不改变单元大小 —— 它们由 `isTranslatable` 门槛（≥4 个英文字母且非中文主导）决定翻不翻，短行若不够门槛就原样保留，这与句子切分的效果一致但成本更低。

### 围栏代码保护（v6）

thinking 中 ``` / ~~~ fenced code blocks 整块锁定：不发起翻译、不替换。流式期围栏可能未闭合 —— 开启后至本帧末的行都视为围栏内（下一帧重算）。

## 后果（trade-off，v6 更新）

- ✅ 流式/终结帧的渲染全程 display-only，session 与模型上下文在正常路径下保持英文。
- ✅ 翻译过程全异步，不阻塞 assistant 消息落盘 / TUI。
- ⚠️ **v6 起有界例外**：仅当定稿后仍有未译尾行时，message_end 最多等 3s 并替换消息 —— 这会让**该消息**的 thinking 以中文持久化（模型上下文可见译文）。典型情况只有 1–3 行尾行受影响；若想完全零持久化污染，可把 `FINAL_WAIT_MS` 设为 0（等效 v5）。
- ⚠️ 超长单行译文可能截断（256-token 上限），见 README。

## 何时重新考虑 message_end 方案

> **2026-09-04 已触发并按上述 v6 修订落地**（有界等待 + 仅替换有变化的消息，而非 v4 的全量同步等待）。保留原文备查：

- 若"尾行永久英文直到自然重渲染"成为高频投诉 → 切回 message_end 同步替换，接受持久化中文与落盘延迟；
- 或若 pi 提供消息级 invalidate / 重渲染 API（如 `chatContainer.invalidate()` 暴露给扩展）。

## 相关证据

- pi-tui `dist/components/markdown.js` `render()`：缓存键 `cachedText === this.text && cachedWidth === width`。
- pi `modes/interactive/components/assistant-message.js` `updateContent()`：每次 `clear()` + 新建 `Markdown`（流式每帧新组件 → transform 每帧跑；定稿后组件留存 → 缓存命中）。
- pi `modes/interactive/interactive-mode.js` `setExtensionWidget()/renderWidgets()`：只重绘 widget 容器 + `ui.requestRender()`。
