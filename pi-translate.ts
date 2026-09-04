/**
 * pi-translate: translate assistant thinking (gray fold) into Simplified Chinese,
 * line-by-line during streaming — each line is translated independently as soon
 * as it arrives, and the Markdown transformer replaces English with Chinese
 * line-by-line on every render frame. No message_end wait, no setWidget trick.
 *
 * Backend: llama.cpp server (Hy-MT2-1.8B), shared via file locks.
 * Commands: /translate on|off|status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SERVER = process.env.PI_TRANSLATE_URL ?? "http://127.0.0.1:9911";
const MODEL = join(homedir(), "hy-mt2-1.8b-q4km.gguf");
const LLAMA_SERVER = join(homedir(), "llama.cpp/llama-b10796/llama-server");
const MAX_CACHE_ENTRIES = 200;
const FETCH_TIMEOUT_MS = 60_000;

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
function trimCache(): void { while (lineCache.size > MAX_CACHE_ENTRIES) { const f = lineCache.keys().next().value; if (f) lineCache.delete(f); else break; } }

/** Whether a line of text contains enough English prose to be worth translating. */
function isTranslatable(s: string): boolean {
  const letters = s.replace(/[^a-zA-Z]/g, ""); if (letters.length < 8) return false;
  const cjk = s.match(/[\u4e00-\u9fff]/g)?.length ?? 0; if (cjk > letters.length * 0.3) return false;
  return true;
}

/** Fire a single-line translation request. No global mutex — let the server queue them. */
function translateLine(text: string): void {
  const s = text.trim(); if (!s || !isTranslatable(s)) return;
  const k = segKey(s); if (lineCache.has(k) || inFlight.has(k)) return;
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
async function ensureServer(ctx: UICtx): Promise<void> {
  acquireLock(); reapStaleLocks();
  if (await probeHealth()) { serverUp = true; serverOwnedByUs = false; return; }
  if (!existsSync(MODEL) || !existsSync(LLAMA_SERVER)) { serverUp = false; ctx.ui.notify(`pi-translate: 缺少模型或 llama-server（${MODEL}）`, "error"); return; }
  ctx.ui.notify("pi-translate: 启动翻译服务…", "info");
  const proc = spawn(LLAMA_SERVER, ["--model", MODEL, "--alias", "qwen3-translate", "--port", "9911", "--host", "127.0.0.1", "--ctx-size", "4096", "--threads", "4", "--parallel", "2", "--cont-batching", "--no-warmup", "--log-disable", "--flash-attn", "on"], { stdio: "ignore", detached: false });
  serverProc = proc; serverOwnedByUs = true; writeFileSync(SERVER_PID_FILE, JSON.stringify({ pid: proc.pid }));
  proc.on("exit", () => { if (serverProc === proc) { serverProc = null; serverUp = false; } }); proc.on("error", () => { if (serverProc === proc) serverUp = false; });
  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 500)); if (await probeHealth(1000)) { serverUp = true; ctx.ui.notify("pi-translate: 翻译服务已就绪", "info"); return; } }
  serverUp = false; ctx.ui.notify("pi-translate: 翻译服务启动超时", "error");
}
function stopServer(): void {
  releaseLock(); if (reapStaleLocks() > 0) { serverProc = null; serverOwnedByUs = false; return; }
  if (serverOwnedByUs && serverProc && serverProc.exitCode === null) serverProc.kill("SIGTERM");
  else { try { if (existsSync(SERVER_PID_FILE)) { const { pid } = JSON.parse(readFileSync(SERVER_PID_FILE, "utf8")); if (isProcessAlive(pid)) process.kill(pid, "SIGTERM"); } } catch { /* ignore */ } }
  try { if (existsSync(SERVER_PID_FILE)) unlinkSync(SERVER_PID_FILE); } catch { /* ignore */ } serverProc = null; serverOwnedByUs = false;
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

    const lines = markdown.split("\n");

    // 流式中: 对完结行发起预翻译（fire-and-forget, 无锁）
    if (meta.isStreaming) {
      for (let i = 0; i < lines.length - 1; i++) {
        translateLine(lines[i]);
      }
    }
    // 终结帧: 对全部行发起（最后一行现在也完结了）
    if (!meta.isStreaming) {
      for (const line of lines) {
        translateLine(line);
      }
      // 同时触发重绘消息，让未命中的行也进入渲染管线（缓存可能很快填充）
      triggerRefresh();
    }

    // 逐行替换：缓存命中的直接变中文
    let changed = false;
    const parts = lines.map(line => {
      if (!line.trim()) return line;
      const k = segKey(line.trim());
      const zh = lineCache.get(k);
      if (zh !== undefined && zh !== line.trim()) { changed = true; return zh; }
      return line;
    });
    if (!changed) return markdown;

    const result = parts.join("\n");
    // 全替换完就缓存整段
    if (lines.every(l => !l.trim() || lineCache.has(segKey(l.trim())))) {
      lineCache.set(segKey(markdown), result);
    }
    return result;
  });
}