# pi-translate

> **Pi coding-agent extension** — live-translates assistant *thinking* (grey fold) from English to Simplified Chinese in the TUI, using a local llama.cpp server (Hy-MT2-1.8B / Qwen3-1.7B class models).
> 为 [pi](https://github.com/earendil-works) 智能体把灰色 thinking 思维链实时翻译成简体中文，全本地推理。

```
assistant thinking (EN) ──► line-level  llama.cpp (127.0.0.1:9911)  ──► 中文逐行上屏
```

## Features / 特性

- **逐行实时翻译**：thinking 流式生成时按行预翻译，已完结的行尽快替换成中文；正文 / toolCall 原样不动。
- **全本地**：模型在你自己机器上跑，thinking 内容不出本机。
- **GPU 加速**：llama-server 以 `--flash-attn on` 启动，自动走 Apple Metal；典型 RSS ~1.5–2.3GB（纯 CPU 模式会到 ~4.2GB 并占满 CPU）。
- **多实例共享**：多个 pi 窗口 / agent 共享一个 llama-server（文件锁引用计数），不重复拉起、最后一个退出才停止。
- **命令控制**：`/translate on|off|status`。
- **轻量安全**：`max_tokens ≤ 256`、`enable_thinking=false` 硬开关、行级去重、30s 重启冷却。

## Requirements / 依赖

- macOS (Apple Silicon, 建议 ≥16GB 内存) — llama.cpp server (llama.cpp b10796+ / OpenCL / Metal)
- 一个翻译模型 GGUF：
  - 推荐 [`Hy-MT2-1.8B-Q4_K_M`](https://huggingface.co/Hy-MT2)（约 1.1 GB，专用翻译模型，实测 0.1–0.7s/行）
  - 兼容 Qwen3-1.7B 类（代码自动带 `chat_template_kwargs.enable_thinking=false` 硬开关）
- Node ≥ 18（pi 扩展运行时）

## Quick start / 快速开始

1. 安装 llama.cpp server 并下载模型：

```bash
mkdir -p ~/llama.cpp && cd ~/llama.cpp
# 按官方指引编译或下载 llama-b10796+ 的 llama-server
curl -L -o ~/hy-mt2-1.8b-q4km.gguf <模型URL>
```

2. 把扩展放进 pi 的用户扩展目录：

```bash
cp pi-translate.ts ~/.pi/agent/extensions/
```

3. 在 pi 里 `/reload`（或重启 pi），然后：

```
/translate status     # 首次会自动拉起本地 llama-server（约数秒~数十秒加载模型）
```

4. 完成：下一次 assistant 的灰色 thinking 会以中文显示。可用 `/translate off` 关闭。

> 提示：服务由扩展自动管理（`session_start` 拉起、最后一个实例退出时停止）。默认端口 `9911`，可用环境变量 `PI_TRANSLATE_URL` 覆盖。模型路径与 llama-server 路径在文件顶部 `MODEL` / `LLAMA_SERVER` 常量中修改。

## Usage / 命令

| 命令 | 作用 |
|---|---|
| `/translate on` | 开启 thinking 翻译（默认开） |
| `/translate off` | 关闭 |
| `/translate status` | 显示服务状态：开/关、服务在线与否（本实例拉起 or 共享）、活跃实例数、缓存行数 |

## Architecture / 架构简介

- `registerMarkdownTransformer`（display-only 同步钩子）在每次渲染 thinking 时执行：
  - 流式帧：对**已完结的行**发起翻译请求（fire-and-forget，`inFlight` 去重防重复请求）；
  - 终结帧：对全部行发起并主动刷一帧；
  - 缓存命中（`lineCache`，200 条 FIFO）直接原地替换为中文。
- 翻译完成回调调用 `triggerRefresh()`（`setWidget` nudge → `requestRender`），让新译文尽快进入下一渲染帧。
- 服务生命周期：文件锁 `~/.pi/agent/pi-translate-locks/` + `server.pid`，`reapStaleLocks()` 清理死锁。
- **设计取舍**：扩展只改显示（display-only），session 持久化与模型上下文里 thinking 保持英文原文，上下文零污染；代价是**已定稿消息的尾行译文依赖下一次自然重渲染**（宽度变化 / 下一条消息 / 恢复会话 / hide-thinking 切换）才回填。详见 [ADR-0001](docs/adr/ADR-0001-display-only-transformer.md)。

## Benchmark / 基准

本机实测（Apple M4 Pro / 48GB，Hy-MT2-1.8B-Q4_K_M，llama.cpp b10796，单并发）：

| 指标 | 值 |
|---|---|
| 单行延迟（短句，p50） | ~110–150 ms |
| 长句（~100 词） | ~660 ms |
| 成功 / 失败 | 11 / 0 |
| 代码/路径/URL 保留 | 100%（`src/server.ts`、`npm test`、URL 原样） |
| 截断边界 | 单行 > ~330 词（≈400 prompt tokens）时 `finish_reason=length`（256 completion tokens 上限），译文会被截断 —— 已知限制 |

复现：`node benchmarks/bench.mjs`（零依赖，使用与扩展完全一致的请求体）。

## Known limitations / 已知限制

1. **超长行截断**：单行超过模型 256-token 输出预算会被截断（见上表）。
2. **已定稿消息不回填**：终结帧后异步完成的译文，需下一次自然重渲染才显示（见 ADR-0001）。
3. **`server.pid` 进程记账缺陷**：llama.cpp launcher 会先以父 PID 退出、再拉起真正的 worker；当前实现对 launcher 场景可能把已死的 PID 写入 `server.pid`，最后一个 pi 退出后服务可能孤儿驻留（见 [ADR-0003](docs/adr/ADR-0003-shared-server-lifecycle.md)）。
4. **跨实例缓存不共享**：每进程 LRU，多实例可能重复翻译同一行（浪费极小，不改正确性）。

## Documents / 文档

- [部署方案 docs/deployment.md](docs/deployment.md)
- [ADR-0001 译文上屏策略（display-only transformer vs message_end 替换）](docs/adr/ADR-0001-display-only-transformer.md)
- [ADR-0002 流式 CPU 风暴根因与防复发规则](docs/adr/ADR-0002-streaming-cpu-storm-rules.md)
- [ADR-0003 多实例共享 llama-server 生命周期](docs/adr/ADR-0003-shared-server-lifecycle.md)
- [基准测试 benchmarks/](benchmarks/)

## License

MIT © 2026 kings0527
