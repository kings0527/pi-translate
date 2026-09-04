# ADR-0003: 多实例共享 llama-server 的生命周期

- 状态：**Accepted；launcher PID 记账缺陷已修复（2026-09-04 v6）**
- 关联：ADR-0002（spawn 参数）

## 背景

多个 pi 窗口 / agent 同时运行时应共享**一个**本地 llama-server（内存模型 ~1.1GB+，多实例各自加载浪费且互相抢 GPU）。用文件锁做引用计数：

- 锁目录 `~/.pi/agent/pi-translate-locks/`，每个 pi 进程一个 `lock-<pid>.json`（写时刷新）。
- `ensureServer()`：先 `acquireLock()` + `reapStaleLocks()`，再探测 `/health` —— 在线则复用（`serverOwnedByUs=false`），否则由本实例 `spawn`。
- `stopServer()`（`session_shutdown`）：释放自身锁 → `reapStaleLocks()>0` 说明还有活跃实例 → 不杀；否则 SIGTERM 服务。
- 看门狗：transformer 探活失败 → 30s 冷却后 `ensureServer` 重启。

## 决策

1. 服务地址固定 `127.0.0.1:9911`（可 `PI_TRANSLATE_URL` 覆盖为任意已有端点，此时扩展只复用不启停）。
2. spawn 参数（防并发退化的基线）：`--parallel 2 --ctx-size 4096 --threads 4 --cont-batching --no-warmup --log-disable`。
3. `server.pid` 记录"本实例 spawn 的进程 PID"，供最后一个实例退出时定向 SIGTERM；配合锁计数避免误杀他人服务。
4. 死锁回收：`reapStaleLocks()` 每次调用时 `process.kill(pid,0)` 探活，死进程锁直接删除。

## 已知缺陷（已在 v6 修复，保留分析备查）

### launcher PID 记账错误（已修复）

现场实证（v5）：`/Users/kk/llama.cpp/llama-b10796/llama-server` 实际是 dylib launcher —— spawn 后它**立即退出**并拉起真正的 worker 进程（PID 变化）。于是：

- 写进 `server.pid` 的是已死的 launcher PID；
- `proc.on("exit")` 在 spawn 后立刻触发 → `serverProc=null; serverUp=false` 记账失效；
- `stopServer()` 的两条 kill 路径都打不到真 worker → **最后一个实例退出后服务孤儿驻留**（现场：server.pid 记 90036 已死，真服务 90035 ppid=1 驻留）。

**v6 修复**（三层）：

1. **记账改以端口监听者为准**：健康就绪后轮询 `lsof -tiTCP:9911 -sTCP:LISTEN`（launcher 场景 worker 需 1-2s 开始监听），拿到真实 worker PID 才写 `server.pid`；`proc.on("exit")` 仅清引用，不再动 `serverUp`（launcher 误触发防御）。
2. **杀前身份校验**：SIGTERM 前用 `ps -o command= -p <pid>` 确认命令行含 `llama-server`，防 PID 复用误杀无关进程（同时关闭了旧条目的 PID 复用风险）。
3. **服务端队列取代无限并发**：客户端 `inFlight` 上限 8（超出丢弃，终结帧/message_end 兑底重试），配合 `--parallel 2`。

验证（v6 harness，真实 endpoint）：spawn → server.pid 记录端口监听者真 PID；stopServer 仅在身份校验通过时杀。手动清理仍可用：`pkill -f 'llama-server.*9911'`。
