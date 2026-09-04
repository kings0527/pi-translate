#!/usr/bin/env node
/**
 * pi-translate / Hy-MT2-1.8B machine-translation benchmark.
 *
 * Zero-dependency (Node >= 18, global fetch). Talks to the local llama.cpp
 * OpenAI-compatible endpoint that pi-translate manages (default 127.0.0.1:9911)
 * using the EXACT request shape the extension sends:
 *   model=qwen3-translate(alias), temperature=0.0, max_tokens=256,
 *   stream=false, chat_template_kwargs={enable_thinking:false},
 *   single user message "Translate to Simplified Chinese:\n" + line.
 *
 * Usage: node benchmarks/bench.mjs [url]
 */

const SERVER = process.argv[2] ?? process.env.PI_TRANSLATE_URL ?? "http://127.0.0.1:9911";
const N_REPEAT = process.argv[3] ? Number(process.argv[3]) : 1;

/** Typical assistant-thinking lines (EN -> zh). Each carries tokens that MUST survive translation. */
const CASES = [
  { id: "short", must: [], text: "The user is asking whether the current fixes are correct." },
  { id: "medium", must: [], text: "Let me check the handler dispatch order between the interactive mode and the session event emitter." },
  { id: "code-tokens", must: ["src/server.ts", "npm test"], text: "I need to inspect `src/server.ts` and run `npm test` before restarting the service." },
  { id: "url", must: ["https://github.com/earendil-works"], text: "See https://github.com/earendil-works for the extension API documentation." },
  { id: "question", must: [], text: "What happens if the translation server crashes in the middle of a stream?" },
  { id: "sequence", must: [], text: "First, read the file. Second, probe the health endpoint. Third, restart the service." },
  { id: "long", must: ["renderLayoutFrame"], text: "The key insight from the debugging session is that the markdown transformer does not automatically re-render when asynchronous work completes, because the renderer caches rendered lines by source text and terminal width; a translation that finishes after the final frame therefore stays invisible until the next natural render trigger such as a width change or a message finalization event. This is why renderLayoutFrame rebuilds a fresh render cache on every frame." },
  { id: "very-long-truncate-probe", must: [], text: "This sentence is intentionally very long to probe the max_tokens=256 truncation boundary. ".repeat(12).trim() },
  { id: "mixed-metrics", must: [], text: "The server shows CPU at 68.8 percent and the health endpoint answers in 29 milliseconds." },
  { id: "markdown", must: [], text: "**Important:** the service is healthy — /health returned ok after the restart." },
  { id: "bullet-reasoning", must: [], text: "Root cause: the old design relied on an async cache. Consequence: translations never reached the screen." },
];

const stats = { n: 0, ok: 0, fail: 0, empty: 0, truncated: 0, tokensKept: 0, tokenChecks: 0, latencies: [], chars: { in: 0, out: 0 } };
const rows = [];

function cjkRatio(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
  return letters + cjk === 0 ? 0 : cjk / (letters + cjk);
}

async function one(c) {
  const t0 = performance.now();
  const res = await fetch(`${SERVER}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-translate",
      messages: [{ role: "user", content: "Translate to Simplified Chinese:\n" + c.text }],
      temperature: 0.0, max_tokens: 256, stream: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`http ${res.status}`);
  const d = await res.json();
  let out = (d.choices?.[0]?.message?.content ?? "").trim();
  if (!out) out = (d.choices?.[0]?.message?.reasoning_content ?? "").replace(/<\/?think>/g, "").trim();
  out = out.replace(/<\/?think>/g, "").trim();
  return { ms, out };
}

for (const c of CASES) {
  for (let r = 0; r < N_REPEAT; r++) {
    const row = { id: c.id, ...c, out: "", ms: 0, err: null, kept: [], missing: [] };
    try {
      const { ms, out } = await one(c);
      row.ms = Math.round(ms); row.out = out;
      if (!out) { row.err = "empty"; stats.empty++; }
      else {
        stats.ok++;
        row.ratio = +cjkRatio(out).toFixed(2);
        row.lenOut = out.length;
        row.trunc = out.endsWith("…") || out.endsWith("...") || /[。；！？，、]$/.test(out) === false && out.length > 200 ? "?" : "";
        for (const m of c.must) {
          stats.tokenChecks++;
          if (out.includes(m)) { stats.tokensKept++; row.kept.push(m); }
          else row.missing.push(m);
        }
        if (row.trunc) stats.truncated++;
      }
    } catch (e) {
      row.err = e.message; stats.fail++;
    }
    stats.n++;
    if (row.ms) stats.latencies.push(row.ms);
    rows.push(row);
    process.stdout.write(`  ${row.id}${N_REPEAT > 1 ? "#" + r : ""}  ${row.ms ?? "-"}ms  ${row.err ?? row.out.slice(0, 60) + (row.out.length > 60 ? "…" : "")}\n`);
  }
}

// aggregate
const lat = stats.latencies.sort((a, b) => a - b);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0;
const summary = {
  url: SERVER,
  machine: `${process.platform}/${process.arch}`,
  ranAt: new Date().toISOString(),
  cases: stats.n,
  ok: stats.ok, fail: stats.fail, empty: stats.empty,
  truncatedProbe: stats.truncated,
  tokenChecks: stats.tokenChecks,
  tokensKept: stats.tokensKept,
  tokenRetention: stats.tokenChecks ? +(100 * stats.tokensKept / stats.tokenChecks).toFixed(1) : null,
  latencyMs: { min: lat[0] ?? null, p50: Math.round(pct(0.5)), p95: Math.round(pct(0.95)), max: lat[lat.length - 1] ?? null, n: lat.length },
};
console.log("\nSUMMARY " + JSON.stringify(summary, null, 2));
for (const r of rows) if (r.missing.length) console.log(`MISSING TOKENS ${r.id}: ${r.missing.join(", ")}`);
