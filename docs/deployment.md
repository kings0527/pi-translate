# 部署方案 Deployment

pi-translate 是一个 [pi coding-agent](https://github.com/earendil-works) 的**用户级扩展**（TypeScript 单文件），部署 = 拷贝到用户扩展目录 + 重载。llama.cpp 翻译服务由扩展**自动拉起 / 共享 / 停止**，无需 systemd / launchd / 手动常驻。

## 0. 拓扑

```
┌─ pi window A ──┐
│  pi-translate  │──┐
└────────────────┘  │  health probe + /v1/chat/completions
┌─ pi window B ──┐  │        │
│  pi-translate  │──┼───────►│  llama-server 127.0.0.1:9911
└────────────────┘  │        │  (Hy-MT2-1.8B-Q4_K_M)
┌─ subagent ─────┐  │        │
│  (json mode,   │  │        │
│   no TUI →     │──┘        │
│   no translate)│           │
└────────────────┘           └────────────────────────────
  所有客户端共享一个服务；文件锁引用计数决定谁拉起、谁最后停。
```

## 1. 前置（一次性）

```bash
# llama.cpp server（macOS Apple Silicon；其他平台参照 llama.cpp 官方）
# 方式 A：下载 release / 编译
# 方式 B：已有 llama.cpp 构建
llama-server --version   # b10796+ 支持 --parallel --cont-batching --log-disable

# 翻译模型（放 ~/，扩展默认路径 ~/hy-mt2-1.8b-q4km.gguf）
curl -L -o ~/hy-mt2-1.8b-q4km.gguf \
  https://huggingface.co/Hy-MT2/Hy-MT2-1.8B-Q4_K_M/resolve/main/hy-mt2-1.8b-q4km.gguf
```

> 换模型 / 换 llama-server 路径：编辑 `pi-translate.ts` 顶部 `MODEL`、`LLAMA_SERVER` 常量（文件无配置文件，刻意保持单文件简单）。也可设 `PI_TRANSLATE_URL` 指向任意已有 OpenAI 兼容端点（此时扩展不负责启停，只探测复用）。

## 2. 安装扩展

```bash
cp pi-translate.ts ~/.pi/agent/extensions/pi-translate.ts
```

> 目录位置：`~/.pi/agent/extensions/` 是 pi 的用户扩展目录（等价于全局扩展）。**扩展不是文件监听**：改动后必须在每个想生效的 pi 窗口执行 `/reload`（或重启 pi），否则运行中的进程继续跑旧代码。

## 3. 首次启动 & 验证

```bash
# 在 pi 内
/translate status
# 期望: 翻译: 开 | 服务: 在线 (本实例拉起/共享) | 活跃实例: N | 缓存: N 行
# 首次会通知 “启动翻译服务… / 已就绪”（模型加载约数秒~数十秒）

# 服务直查
curl -s http://127.0.0.1:9911/health          # {"status":"ok"}
node benchmarks/bench.mjs                      # 端到端基准（可选）
```

发一条消息让 assistant 产生英文 thinking：灰色折叠内应出现中文。

## 4. 多实例行为

| 场景 | 行为 |
|---|---|
| 第二个 pi 窗口启动 | `session_start` → 探测到 9911 已在线 → 只加锁复用，不起新服务 |
| 子代理（`--mode json -p`） | 加载扩展但无 TUI → 不触发 transformer → 不翻译、不空转 |
| 某窗口退出 | 释放自身锁；仍有活跃实例 → 不杀服务 |
| 最后一个窗口退出 | `reapStaleLocks()==0` → SIGTERM 服务 |
| 服务崩溃 | 看门狗（30s 冷却）自动重启；重启失败在 footer 提示，不静默 |

锁目录：`~/.pi/agent/pi-translate-locks/`（`lock-<pid>.json` + `server.pid`）。异常退出留下死锁会被 `reapStaleLocks()` 下次清理。

## 5. 升级 / 回滚

```bash
# 升级
cp 新版本 ~/.pi/agent/extensions/pi-translate.ts && 各窗口 /reload

# 回滚：保留任意历史为备份即可
cp ~/.pi/agent/extensions/pi-translate.ts ~/.pi/agent/extensions/pi-translate.ts.bak-$(date +%Y%m%d-%H%M)
cp ~/.pi/agent/extensions/pi-translate.ts.bak-<版本> ~/.pi/agent/extensions/pi-translate.ts && 各窗口 /reload
```

> 建议把 `~/.pi/agent/extensions/` 纳入 git（当前常见事故：无版本管理导致修复被覆盖后无法找回）。

## 6. 故障排查速查

| 症状 | 检查 |
|---|---|
| 不翻译 | `/translate status`；`curl :9911/health`；是否已 `/reload`（扩展非热加载） |
| 服务 CPU 高 | `ps aux | grep llama-server`；单实例 + `--parallel 2` 通常 <10%（M4 Pro）；长期高 → 看是否有旧 pi 实例残留（旧代码风暴） |
| 卡在英文 / 只翻前几行 | 已定稿消息尾行译文需自然重渲染才回填（宽度变化/下条消息）——见 ADR-0001 |
| 退出后服务仍驻留 | 已知缺陷（launcher PID 记账）：手动 `kill $(cat ~/.pi/agent/pi-translate-locks/server.pid)`，或直接 pkill llama-server —— 见 ADR-0003 |
| 长行译文被截断 | 已知限制（256 token 上限）——见 README Known limitations |
