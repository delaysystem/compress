// Controlled latency benchmark for the local llama.cpp expander.
// Uses a FIXED prompt set so different server configs compare fairly.
// Run from worker/:
//   node --experimental-strip-types scripts/latency-bench.ts \
//     --label baseline --out /tmp/opencode/latency-results.jsonl [--n 25] [--concurrency 1]
// Requires an OpenAI-compatible server on 127.0.0.1:9931.
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExpansionPrompt } from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';

const BASE = 'http://127.0.0.1:9931';
const MAX_TOKENS = 512;

function flag(name: string, def: string): string {
	const i = process.argv.indexOf(name);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const label = flag('--label', 'run');
const out = flag('--out', '/tmp/opencode/latency-results.jsonl');
const n = Number(flag('--n', '25'));
const concurrency = Number(flag('--concurrency', '1'));
const promptMode = flag('--prompt-mode', 'full');

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
// v13b-trained prompts, coherent with the v13b expander we benchmark.
const rows = readFileSync(
	join(root, 'data', 'derived', 'lfm3ftv13b-v3gem100.jsonl'),
	'utf8',
)
	.trim()
	.split('\n')
	.slice(0, n)
	.map((l) => JSON.parse(l) as { key: string; prepared: string });
const prompts = rows.map((r) => {
	if (promptMode === 'minimal') return `${r.prepared}\nREPLY:`;
	if (promptMode === 'short') return `DRAFT:\n${r.prepared}\nREPLY:`;
	if (promptMode === 'compact')
		return buildExpansionPrompt(r.prepared, undefined, true);
	if (promptMode === 'full')
		return buildExpansionPrompt(r.prepared, undefined, false);
	return buildExpansionPrompt(r.prepared); // config default (compact)
});

interface Result {
	key: string;
	wallMs: number;
	promptTokens: number;
	completionTokens: number;
	error: string | null;
	text: string;
}

const results: Result[] = [];
let cursor = 0;
async function worker(): Promise<void> {
	while (cursor < prompts.length) {
		const i = cursor++;
		const t0 = performance.now();
		try {
			const res = await fetch(`${BASE}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: prompts[i] }],
					temperature: 0,
					max_tokens: MAX_TOKENS,
					stream: false,
				}),
			});
			if (!res.ok) throw new Error(`http ${res.status}`);
			const d = (await res.json()) as {
				choices?: Array<{ message?: { content?: unknown } }>;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
				};
			};
			results.push({
				key: rows[i]?.key ?? '',
				wallMs: Math.round(performance.now() - t0),
				promptTokens: d.usage?.prompt_tokens ?? 0,
				completionTokens: d.usage?.completion_tokens ?? 0,
				error: null,
				text: String(d.choices?.[0]?.message?.content ?? ''),
			});
		} catch (e) {
			results.push({
				key: rows[i]?.key ?? '',
				wallMs: Math.round(performance.now() - t0),
				promptTokens: 0,
				completionTokens: 0,
				error: e instanceof Error ? e.message : String(e),
				text: '',
			});
		}
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));

const ok = results.filter((r) => r.error === null);
const p = (xs: number[], q: number): number =>
	xs.length === 0
		? NaN
		: percentile(
				[...xs].sort((a, b) => a - b),
				q,
			);
const walls = ok.map((r) => r.wallMs);
const summary = {
	label,
	at: new Date().toISOString(),
	n: results.length,
	errors: results.length - ok.length,
	concurrency,
	meanCompletionTokens:
		ok.reduce((a, r) => a + r.completionTokens, 0) / Math.max(1, ok.length),
	p50ms: p(walls, 0.5),
	p95ms: p(walls, 0.95),
	meanMs: walls.reduce((a, b) => a + b, 0) / Math.max(1, walls.length),
};
appendFileSync(out, `${JSON.stringify(summary)}\n`);
appendFileSync(
	`${out}.raw`,
	`${JSON.stringify({ label, results: results.map((r) => ({ key: r.key, wallMs: r.wallMs, completionTokens: r.completionTokens, error: r.error, text: r.text })) })}\n`,
);
console.log(JSON.stringify(summary));
