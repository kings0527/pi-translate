# ADR-0001: 译文上屏策略 —— display-only transformer（当前）vs message_end 替换

- 状态：**Accepted**（2026-09-04，重构后选型）
- 关联：ADR-0002（CPU 风暴防复发）、ADR-0003（共享服务生命周期）

## 背景

pi 扩展对"实时翻译 thinking"有三个平台约束（源码实证，pi v0.84.x）：

1. `registerMarkdownTransformer` 是 **display-only 同步钩子**：只在渲染 markdown 时执行，返回值不写回 session、不进模型上下文。
2. Pi-TUI `Markdown` 组件按 `(source text, width)` **实例级缓存**渲染结果；`transform` 只在缓存 miss 时执行。
3. 扩展 API **没有**主动触发"已渲染消息重跑 transformer"的方法：`setStatus` 只更新 footer；`setWidget` 只重建 widget 容器并请求一帧，不会 invalidate 消息组件。

曾实现的替代方案（v4，2026-09-04 17:55 前）：在 `message_end` **同步等待**整段翻译完成，返回 `{ message }` 替换最终消息 —— 在持久化与 TUI 最终渲染**之前**生效，译文必然上屏且持久化即中文。代价：每个 assistant 消息的持久化思考变成中文（`/resume` 后模型上下文读到的 thinking 是译文，可能被误当成模型原生输出）；端到端等待整段翻译拖慢消息落盘；模型/服务故障会阻塞消息完成。

## 决策

采用 **display-only 逐行 transformer + 主动刷帧**：

- 流式过程中对"已完结行"发起翻译（fire-and-forget），缓存命中即替换；
- 翻译完成回调 `triggerRefresh()`（`setWidget` nudge → `requestRender`），尽快进入下一帧；
- 不修改消息本体 → session 持久化 / 模型上下文保持英文原文（上下文零污染）；
- `max_tokens ≤ 256` + 行级去重 + 单飞请求，控制延迟与负载。

## 后果（trade-off，接受）

- ✅ session 与模型上下文里的 thinking 恒为英文 —— 上下文干净，无译文污染。
- ✅ 翻译过程全异步，不阻塞 assistant 消息落盘 / TUI。
- ⚠️ 已定稿消息在终结帧之后才完成的尾行译文：因 Markdown 组件缓存命中，`triggerRefresh()` 的普通帧**不会**令其重跑 transform —— 译文要等下一次**自然重渲染**（新消息、终端宽度变化、hide-thinking 切换、会话恢复）才回填。典型残余 1–3 行，流式中途的行不受影响（每帧新建组件）。
- ⚠️ 超长单行译文可能截断（256-token 上限），见 README。

## 何时重新考虑 message_end 方案

- 若"尾行永久英文直到自然重渲染"成为高频投诉 → 切回 message_end 同步替换，接受持久化中文与落盘延迟；
- 或若 pi 提供消息级 invalidate / 重渲染 API（如 `chatContainer.invalidate()` 暴露给扩展）。

## 相关证据

- pi-tui `dist/components/markdown.js` `render()`：缓存键 `cachedText === this.text && cachedWidth === width`。
- pi `modes/interactive/components/assistant-message.js` `updateContent()`：每次 `clear()` + 新建 `Markdown`（流式每帧新组件 → transform 每帧跑；定稿后组件留存 → 缓存命中）。
- pi `modes/interactive/interactive-mode.js` `setExtensionWidget()/renderWidgets()`：只重绘 widget 容器 + `ui.requestRender()`。
