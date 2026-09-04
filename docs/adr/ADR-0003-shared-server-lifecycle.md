# ADR-0003: 多实例共享 llama-server 的生命周期（含 launcher PID 记账缺陷）

- 状态：**Accepted**（2026-09-04），附已知缺陷跟踪
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

## 已知缺陷（跟踪中）

- **launcher PID 记账错误**（现场实证）：`/Users/kk/llama.cpp/llama-b10796/llama-server` 实际是 dylib launcher —— spawn 后它**立即退出**并拉起真正的 worker 进程（PID 变化）。于是：
  - 写进 `server.pid` 的是已死的 launcher PID；
  - `proc.on("exit")` 在 spawn 后立刻触发 → `serverProc=null; serverUp=false` 记账失效（靠后续健康探测纠正）；
  - `stopServer()` 的两条 kill 路径（`serverProc.kill` / pid 文件）都打不到真 worker → **最后一个实例退出后服务孤儿驻留**（现场：server.pid 记 90036 已死，真服务 90035 ppid=1 驻留）。
- 缓解（当前）：探活优先于记账 —— `ensureServer` 先 `/health`，在线即复用；孤儿服务下次任意实例启动会被探测到并复用，不重复拉起。手动清理：`pkill -f 'llama-server.*9911'`。
- 修法方向（未实施）：spawn 后不依赖 launcher PID，改为"启动后扫描端口 9911 的实际监听者 PID 写入 server.pid"（`lsof -tiTCP:9911 -sTCP:LISTEN`），或改用 `--port` 独占检测 + 退出时按端口清理。
- **`isProcessAlive(pid)` PID 复用**：极端情况下可能误判/误杀同 PID 的其他进程 —— kill 前应校验进程命令行含 `llama-server`。
