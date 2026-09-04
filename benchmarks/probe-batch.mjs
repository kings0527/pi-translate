#!/usr/bin/env node
/**
 * batching probe for Hy-MT2 (asymmetric MT batch behavior):
 * total wall-time to translate N lines, as N requests vs 1 batched request.
 * Usage: node benchmarks/probe-batch.mjs [nLines] [repeat]
 */
const SERVER = process.env.PI_TRANSLATE_URL ?? "http://127.0.0.1:9911";
const N = Number(process.argv[2] ?? 20);
const REP = Number(process.argv[3] ?? 1);
const lines = Array.from({ length: N }, (_, i) => `The extension translates line ${i + 1} of the assistant thinking stream into Chinese for the user to read.`);

async function call(payload, timeoutMs = 300_000) {
  const t0 = performance.now();
  const r = await fetch(`${SERVER}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`http ${r.status}`);
  const d = await r.json();
  const out = (d.choices?.[0]?.message?.content ?? "").replace(/<\/?think>/g, "").trim();
  return { ms: performance.now() - t0, out, finish: d.choices?.[0]?.finish_reason, usage: d.usage };
}

const results = { nLines: N, perLine: [], batch: [] };
for (let rep = 0; rep < REP; rep++) {
  let per = 0;
  for (const ln of lines) {
    const { ms } = await call({ model: "qwen3-translate", messages: [{ role: "user", content: "Translate to Simplified Chinese:\n" + ln }], temperature: 0.0, max_tokens: 256, stream: false, chat_template_kwargs: { enable_thinking: false } });
    per += ms;
  }
  const body = lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
  const { ms: bms, out: bout, finish, usage } = await call({ model: "qwen3-translate", messages: [{ role: "user", content: "Translate to Simplified Chinese. Output exactly one translation per numbered line, keep the numbering:\n" + body }], temperature: 0.0, max_tokens: 256 * 20, stream: false, chat_template_kwargs: { enable_thinking: false } });
  results.perLine.push(Math.round(per));
  results.batch.push(Math.round(bms));
  const nOut = bout.split("\n").filter((l) => /^\s*\d+\./.test(l)).length;
  console.log(`rep${rep}: perLine=${Math.round(per)}ms batch=${Math.round(bms)}ms speedup=${(per / bms).toFixed(1)}x batchOutLines=${nOut}/${N} finish=${finish} usage=${JSON.stringify(usage)}`);
}
console.log("SUMMARY " + JSON.stringify(results));
