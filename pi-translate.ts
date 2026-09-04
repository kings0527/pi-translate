/**
 * pi-translate: translate assistant thinking (gray fold) into Simplified Chinese,
 * line-by-line during streaming — each line is translated independently as soon
 * as it arrives, and the Markdown transformer replaces English with Chinese
 * line-by-line on every render frame. No message_end wait, no setWidget trick.
 *
 * Backend: llama.cpp server (Hy-MT2-1.8B), shared via file locks.
 * Commands: /translate on|off|status
 */

import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER = process.env.PI_TRANSLATE_URL ?? "http://127.0.0.1:9911";
const MODEL = join(homedir(), "hy-mt2-1.8b-q4km.gguf");
const LLAMA_SERVER = join(homedir(), "llama.cpp/llama-b10796/llama-server");
const MAX_CACHE_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 60_000;
// message_end 有界等待（ADR-0001 修订）：终结后仍无译文的尾行最多再等这么久；
// 超时未完成的行原样保留（自然重渲染仍会回填）。
const FINAL_WAIT_MS = 3_000;
const FINAL_WAIT_POLL_MS = 100;
// 流式预翻译的并发上限（llama --parallel 2；超出的行进入服务端队列，仍受限流保护）
const MAX_STREAM_INFLIGHT = 8;

let enabled = true;
let serverUp: boolean | null = null;
let serverProc: ChildProcess | null = null;
let serverOwnedByUs = false;
let lastHealthCheck = 0;

const lineCache = new Map<string, string>();   // segKey(line) -> zh
const inFlight = new Set<string>();            // segKey(line) 已在请求中，防重复请求
type UICtx = { ui: { notify: (m: string, l: "info" | "warning" | "error") => void; setStatus: (k: string, t: string | undefined) => void; setWidget: (k: string, c: string[] | undefined) => void } };
let statusCtx: UICtx | null = null;

function segKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${(h >>> 0).toString(36)}:${text.length}`;
}
function trimCache(): void { while (lineCache.size > MAX_CACHE_ENTRIES) { const f = lineCache.keys().next().value; if (f) lineCache.delete(f); else break; } }  // Map 保序，先进先出（FIFO）非 LRU

/** Whether a text unit contains enough English prose to be worth translating. */
function isTranslatable(s: string): boolean {
  const letters = s.replace(/[^a-zA-Z]/g, ""); if (letters.length < 4) return false;
  const cjk = s.match(/[\u4e00-\u9fff]/g)?.length ?? 0; if (cjk > letters.length * 0.3) return false;
  return true;
}

/**
 * 分行并保护 fenced code blocks（``` ... ```）。
 * locked=true 的行（围栏内/围栏标记本身）永远原样保留，不翻译不替换。
 * 流式期围栏可能未闭合：``` 开启后直到本帧结束都视为围栏内（下一帧重算）。
 */
function splitThinkingLines(markdown: string): Array<{ raw: string; locked: boolean }> {
  const lines = markdown.split("\n");
  let inFence = false;
  return lines.map(line => {
    if (/^\s*(```|~~~)/.test(line)) { const wasIn = inFence; inFence = !inFence; return { raw: line, locked: true }; }
    return inFence ? { raw: line, locked: true } : { raw: line, locked: false };
  });
}

/** Fire a single-line translation request. Server-side queue + inFlight cap bound the load. */
function translateLine(text: string): void {
  const s = text.trim(); if (!s || !isTranslatable(s)) return;
  const k = segKey(s); if (lineCache.has(k) || inFlight.has(k)) return;
  if (inFlight.size >= MAX_STREAM_INFLIGHT) return; // 客户端限流：满载时丢弃，终结帧/message_end 会兜底重试
  inFlight.add(k);
  void (async () => {
    try {
      const res = await fetch(`${SERVER}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", "connection": "close" },
        body: JSON.stringify({
          model: "qwen3-translate",
          messages: [{ role: "user", content: "Translate to Simplified Chinese:\n" + s }],
          temperature: 0.0, max_tokens: 256, stream: false,
          // Hy-MT2 是专用翻译模型；若是思考型模型，硬关 thinking 防超时
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const d = (await res.json()) as { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> };
      const msg = d.choices?.[0]?.message; let out = (msg?.content ?? "").trim();
      if (!out && msg?.reasoning_content) out = msg.reasoning_content;
      out = out.replace(/<\/?think>/g, "").trim();
      if (!out) return;
      lineCache.set(k, out); trimCache();
      // 已替换行要等下一次渲染才上屏（Markdown 按原文缓存），
      // 翻译完成主动刷一帧；render 节流（30ms 间隔）+ 请求串行排队限制频率
      triggerRefresh();
    } catch { /* single-line failure is survivable */ } finally {
      inFlight.delete(k);
    }
  })();
}

async function probeHealth(timeoutMs = 1500): Promise<boolean> {
  try { const r = await fetch(`${SERVER}/health`, { signal: AbortSignal.timeout(timeoutMs), headers: { "connection": "close" } }); return r.ok; } catch { return false; }
}

// ---------- Shared llama.cpp lifecycle ----------
const LOCK_DIR = join(homedir(), ".pi/agent/pi-translate-locks"); const SERVER_PID_FILE = join(LOCK_DIR, "server.pid");
let myLockFile: string | null = null;
function ensureLockDir(): void { if (!existsSync(LOCK_DIR)) mkdirSync(LOCK_DIR, { recursive: true }); }
function isProcessAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function reapStaleLocks(): number {
  ensureLockDir(); let alive = 0;
  for (const f of readdirSync(LOCK_DIR)) {
    if (!f.startsWith("lock-") || !f.endsWith(".json")) continue;
    try { const { pid } = JSON.parse(readFileSync(join(LOCK_DIR, f), "utf8")); if (isProcessAlive(pid)) alive++; else unlinkSync(join(LOCK_DIR, f)); } catch { try { unlinkSync(join(LOCK_DIR, f)); } catch { /* ignore */ } }
  }
  return alive;
}
function acquireLock(): void { ensureLockDir(); myLockFile ??= join(LOCK_DIR, `lock-${process.pid}.json`); writeFileSync(myLockFile, JSON.stringify({ pid: process.pid, ts: Date.now() })); }
function releaseLock(): void { if (myLockFile && existsSync(myLockFile)) { try { unlinkSync(myLockFile); } catch { /* ignore */ } } myLockFile = null; }

/**
 * 查询端口上的真实 llama-server 监听者 PID（ADR-0003 修复）。
 * llama-b10796 的 llama-server 是 dylib launcher：spawn 后立即退出并 exec 真正的
 * worker（PID 变化），proc.pid 记的是已死的 launcher。launcher 场景下 worker 需
 * ~1-2s 才开始监听端口，所以 spawn 后要轮询等待。
 */
function findServerPid(port: number): number | null {
  try {
    const out = execFileSync("lsof", ["-ti", `TCP:${port}`, "-sTCP:LISTEN"], { timeout: 3000 }).toString().trim();
    const pid = Number.parseInt(out.split("\n")[0] ?? "", 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

/** 杀进程前校验它确实是 llama-server（防 PID 复用误杀无关进程，ADR-0003）。 */
function isLlamaServerPid(pid: number): boolean {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { timeout: 3000 }).toString().includes("llama-server"); }
  catch { return false; }
}

async function ensureServer(ctx: UICtx): Promise<void> {
  acquireLock(); reapStaleLocks();
  if (await probeHealth()) { serverUp = true; serverOwnedByUs = false; return; }
  if (!existsSync(MODEL) || !existsSync(LLAMA_SERVER)) { serverUp = false; ctx.ui.notify(`pi-translate: 缺少模型或 llama-server（${MODEL}）`, "error"); return; }
  ctx.ui.notify("pi-translate: 启动翻译服务…", "info");
  const proc = spawn(LLAMA_SERVER, ["--model", MODEL, "--alias", "qwen3-translate", "--port", "9911", "--host", "127.0.0.1", "--ctx-size", "4096", "--threads", "4", "--parallel", "2", "--cont-batching", "--no-warmup", "--log-disable", "--flash-attn", "on"], { stdio: "ignore", detached: false });
  serverProc = proc; serverOwnedByUs = true;
  // 注意：不信任 proc.pid（launcher 会立即退出）；记账以端口监听者为准（下方轮询）。
  proc.on("exit", () => { if (serverProc === proc) serverProc = null; });  // 仅清引用，不动 serverUp（launcher 误触发防御）
  proc.on("error", () => { /* 记账交给下方健康探测轮询 */ });
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await probeHealth(1000)) {
      serverUp = true;
      // 等 worker 完成监听（launcher 场景 worker PID 才是真服务），拿到才写 server.pid
      let realPid: number | null = null;
      for (let j = 0; j < 10; j++) { realPid = findServerPid(9911); if (realPid !== null) break; await new Promise(r => setTimeout(r, 300)); }
      if (realPid !== null) { try { writeFileSync(SERVER_PID_FILE, JSON.stringify({ pid: realPid })); } catch { /* ignore */ } }
      ctx.ui.notify("pi-translate: 翻译服务已就绪", "info");
      return;
    }
  }
  serverUp = false; ctx.ui.notify("pi-translate: 翻译服务启动超时", "error");
}
function stopServer(): void {
  releaseLock(); if (reapStaleLocks() > 0) { serverProc = null; serverOwnedByUs = false; return; }
  // 优先按 server.pid（端口监听者真 PID）杀；杀前校验进程身份防 PID 复用误杀。
  let killed = false;
  try {
    if (existsSync(SERVER_PID_FILE)) {
      const { pid } = JSON.parse(readFileSync(SERVER_PID_FILE, "utf8"));
      if (Number.isFinite(pid) && isProcessAlive(pid) && isLlamaServerPid(pid)) { process.kill(pid, "SIGTERM"); killed = true; }
    }
  } catch { /* ignore */ }
  if (!killed && serverOwnedByUs && serverProc && serverProc.exitCode === null && isLlamaServerPid(serverProc.pid)) {
    try { serverProc.kill("SIGTERM"); killed = true; } catch { /* ignore */ }  // 直启（非 launcher）场景的兜底
  }
  if (killed) { try { if (existsSync(SERVER_PID_FILE)) unlinkSync(SERVER_PID_FILE); } catch { /* ignore */ } }
  serverProc = null; serverOwnedByUs = false;
}

// ---------- 主入口 ----------
let pendingRefresh: ReturnType<typeof setTimeout> | null = null;
function triggerRefresh(): void {
  if (!statusCtx) return;
  if (pendingRefresh) clearTimeout(pendingRefresh);
  statusCtx.ui.setWidget("pi-translate-refresh", [" "]);
  pendingRefresh = setTimeout(() => { pendingRefresh = null; statusCtx?.ui.setWidget("pi-translate-refresh", undefined); }, 50);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => { statusCtx = ctx as unknown as UICtx; await ensureServer(statusCtx); });
  pi.on("session_shutdown", () => { statusCtx = null; stopServer(); });

  pi.registerCommand("translate", {
    description: "翻译开关与状态：/translate on|off|status",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim().toLowerCase(); const u = ctx as unknown as UICtx; statusCtx = u;
      if (a === "on") { enabled = true; ctx.ui.notify("thinking 翻译已开启", "info"); return; }
      if (a === "off") { enabled = false; ctx.ui.notify("thinking 翻译已关闭", "info"); return; }
      serverUp = await probeHealth(); const instances = reapStaleLocks();
      const owner = serverOwnedByUs ? "本实例拉起" : (serverUp ? "共享/外部实例" : "未运行");
      ctx.ui.notify(`thinking 翻译: ${enabled ? "开" : "关"} | 服务: ${serverUp ? "在线" : "离线"} (${owner}) | 活跃实例: ${instances} | 缓存: ${lineCache.size} 行`, serverUp ? "info" : "warning");
    },
  });

  // ── Transformer：逐行替换 + 逐行预翻译 ──
  // 看门狗：服务挂了自动重启（带冷却，避免风暴）
  let lastRestartAttempt = 0;
  const WATCHDOG_MIN_INTERVAL = 30_000;  // 两次重启尝试至少间隔 30s

  async function ensureServerSafe(u: UICtx): Promise<void> {
    const now = Date.now();
    if (now - lastRestartAttempt < WATCHDOG_MIN_INTERVAL) return;  // 冷却
    lastRestartAttempt = now;
    await ensureServer(u);
  }

  pi.registerMarkdownTransformer((markdown, meta) => {
    if (!enabled || meta.messageType !== "assistant-thinking") return markdown;

    // 探活：服务标记为挂时，每 5s 检查一次，失败则自动重启
    if (serverUp !== true && Date.now() - lastHealthCheck > 5000) {
      lastHealthCheck = Date.now();
      void (async () => {
        if (await probeHealth(1500)) {
          serverUp = true;
          // 服务恢复后已有缓存的行要等下一次渲染才上屏，主动刷一帧
          triggerRefresh();
        } else if (statusCtx) {
          // 服务真的挂了 → 看门狗自动拉起（带 30s 冷却）
          statusCtx.ui.notify("pi-translate: 🔄 翻译服务掉线，自动重启…", "warning");
          await ensureServerSafe(statusCtx);
          if (serverUp === true) statusCtx.ui.notify("pi-translate: ✅ 翻译服务已恢复", "info");
        }
      })();
      return markdown;
    }
    if (serverUp !== true) return markdown;

    const lines = splitThinkingLines(markdown);

    // 流式中: 对完结的非围栏行发起预翻译（fire-and-forget）
    if (meta.isStreaming) {
      for (let i = 0; i < lines.length - 1; i++) {
        if (!lines[i].locked) translateLine(lines[i].raw);
      }
    }
    // 终结帧: 对全部行发起（最后一行现在也完结了）
    if (!meta.isStreaming) {
      for (const l of lines) { if (!l.locked) translateLine(l.raw); }
      // 同时触发重绘消息，让未命中的行也进入渲染管线（缓存可能很快填充）
      triggerRefresh();
    }

    // 逐行替换：缓存命中的直接变中文（locked 行原样保留）
    let changed = false;
    const parts = lines.map(({ raw, locked }) => {
      if (locked || !raw.trim()) return raw;
      const k = segKey(raw.trim());
      const zh = lineCache.get(k);
      if (zh !== undefined && zh !== raw.trim()) { changed = true; return zh; }
      return raw;
    });
    if (!changed) return markdown;

    return parts.join("\n");
  });

  // ── message_end 有界等待替换（ADR-0001 修订）──
  // 定稿后仍无译文的尾行最多再等 FINAL_WAIT_MS；拿到译文就整体替换消息（同 role），
  // 首次正式渲染/持久化即为中文；超时未完成的行原样保留（自然重渲染自愈路径仍在）。
  // 语义提醒：替换会写回 session 持久化（ADR-0001 已知取舍）。
  pi.on("message_end", async (event: MessageEndEvent, ctx) => {
    if (!enabled || serverUp !== true) return undefined;
    // subagent / json 模式（无 TUI）不参与翻译：不等待、不替换，不给 headless 消息加延迟
    if ((ctx as unknown as { hasUI?: boolean })?.hasUI === false) return undefined;
    const msg = event.message as (MessageEndEvent["message"] & { content?: Array<{ type?: string; thinking?: string }> }) | undefined;
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return undefined;

    // 收集仍无译文的行；围栏代码行（locked）与空白行不参与
    const pendingUnits: string[] = [];
    for (const block of msg.content) {
      if (block?.type !== "thinking" || typeof block.thinking !== "string") continue;
      for (const { raw, locked } of splitThinkingLines(block.thinking)) {
        if (locked) continue;
        const s = raw.trim();
        if (!s || !isTranslatable(s)) continue;
        const k = segKey(s);
        if (!lineCache.has(k)) { pendingUnits.push(s); translateLine(s); }
      }
    }
    if (pendingUnits.length === 0) return undefined;   // 全部已译：不替换，零等待

    // 有界等待：轮询直到 pending 全部落缓存或超时
    const deadline = Date.now() + FINAL_WAIT_MS;
    while (Date.now() < deadline) {
      const remaining = pendingUnits.filter(s => !lineCache.has(segKey(s)));
      if (remaining.length === 0) break;
      await new Promise(r => setTimeout(r, FINAL_WAIT_POLL_MS));
    }

    // 替换 thinking 内容：命中译文替换（保留行首尾空白），未命中/locked 原样
    let changed = false;
    const content = msg.content.map(block => {
      if (block?.type !== "thinking" || typeof block.thinking !== "string") return block;
      let blockChanged = false;
      const parts = splitThinkingLines(block.thinking).map(({ raw, locked }) => {
        if (locked || !raw.trim()) return raw;
        const s = raw.trim();
        const zh = lineCache.get(segKey(s));
        if (zh !== undefined && zh !== s) { blockChanged = true; return raw.replace(s, zh); }
        return raw;
      });
      if (!blockChanged) return block;
      changed = true;
      return { ...block, thinking: parts.join("\n") };
    });
    if (!changed) return undefined;   // 关键：没有变化绝不返回 message（避免无效替换/全链失效）
    return { message: { ...msg, content } };
  });
}