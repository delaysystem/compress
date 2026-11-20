// LFM3-as-expander diagnosis (run 015): 30 recorded v2 compress IRs through
// the real pipeline path (prepareExpansion + v0 expansion prompt + LFM3 +
// validateExpansion). Measures validator pass rate + fail classes + latency.
// slotValues is [] (no tool values in this eval; entity-parity carries it).
// New outputs: data/derived/lfm3-expand.jsonl + lfm3-expand-summary.json.
// Run from worker/: node --experimental-strip-types scripts/lfm3-expand.ts [limit] [--force]
// Requires: llama serve on 127.0.0.1:9931. Default N=30.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntities } from '../src/entities.ts';
import { buildExpansionPrompt, prepareExpansion } from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';
import { validateExpansion } from '../src/validator.ts';

const LFM3_BASE = 'http://127.0.0.1:9931';
const CONCURRENCY = 4;
const TEMPERATURE = 0;
const MAX_REPLY_TOKENS = 512;
const MAX_ERROR_RATE = 0.1;
const FETCH_RETRIES = 2;
const DEFAULT_N = 30;

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

interface ExpandRow {
	key: string;
	ir: string;
	reply: string;
	finish: string;
	pass: boolean;
	checks: Array<{ name: string; pass: boolean }>;
	wallMs: number;
	error: string | null;
}

async function postChat(prompt: string): Promise<{
	text: string;
	finish: string;
}> {
	let last = '';
	for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
		try {
			const res = await fetch(`${LFM3_BASE}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: prompt }],
					temperature: TEMPERATURE,
					max_tokens: MAX_REPLY_TOKENS,
				}),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			const d = (await res.json()) as {
				choices?: Array<{
					finish_reason?: unknown;
					message?: { content?: unknown };
				}>;
			};
			const c = d.choices?.[0];
			return {
				text: typeof c?.message?.content === 'string' ? c.message.content : '',
				finish: typeof c?.finish_reason === 'string' ? c.finish_reason : '',
			};
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
			await sleep(1000);
		}
	}
	throw new Error(`lfm3 chat failed: ${last}`);
}

// Retired variant, kept as an alias: the product prompt adopted the strict
// rule 3 in run 016, so both builders produce byte-identical output (verified
// run 023). Runners keep calling this name; v0-vs-strict arms now measure
// determinism, not prompt contrast.
export function buildStrictPrompt(expandedIr: string): string {
	return buildExpansionPrompt(expandedIr);
}

async function runSample(
	key: string,
	ir: string,
	strict: boolean,
): Promise<ExpandRow> {
	const started = performance.now();
	const fail = (error: string): ExpandRow => ({
		key,
		ir,
		reply: '',
		finish: '',
		pass: false,
		checks: [],
		wallMs: Math.round(performance.now() - started),
		error,
	});
	try {
		const prepared = prepareExpansion(ir, {
			dict: { version: 'eval-empty', entries: [] },
			dictVersion: 'eval-empty',
			store: { version: 'eval-empty', documents: new Map() },
			kbVersion: 'eval-empty',
		});
		if (!prepared.ok) {
			return fail(`prepare: ${prepared.error.message}`);
		}
		const prompt = strict
			? buildStrictPrompt(prepared.value.expandedIr)
			: buildExpansionPrompt(prepared.value.expandedIr);
		const gen = await postChat(prompt);
		const v = validateExpansion({
			splicedIr: prepared.value.expandedIr,
			slotValues: [],
			output: gen.text,
			finishReason: gen.finish === 'stop' ? 'STOP' : 'MAX_TOKENS',
		});
		return {
			key,
			ir,
			reply: gen.text,
			finish: gen.finish,
			pass: v.pass,
			checks: v.checks.map((c) => ({ name: c.name, pass: c.pass })),
			wallMs: Math.round(performance.now() - started),
			error: null,
		};
	} catch (e) {
		return fail(e instanceof Error ? e.message.slice(0, 200) : String(e));
	}
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const limitArg = Number(process.argv[2]);
	const n = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : DEFAULT_N;
	const fromV3 = process.argv.includes('--v3');
	const strict = process.argv.includes('--strict');
	const sourceFile = fromV3 ? 'ir-pilot-v3.jsonl' : 'ir-pilot-v2.jsonl';
	const rows = readFileSync(join(root, 'data', 'derived', sourceFile), 'utf8')
		.trim()
		.split('\n')
		.map(
			(l) =>
				JSON.parse(l) as {
					arm: string;
					key: string;
					irLite: string;
					puntLite?: boolean;
					error?: string | null;
				},
		)
		.filter((r) =>
			fromV3
				? r.error === null &&
					r.puntLite !== true &&
					extractEntities(r.irLite).some((e) => e.class !== 'placeholder')
				: r.arm === 'compress',
		)
		.slice(0, n);
	const tag = `${fromV3 ? '-v3' : ''}${strict ? '-strict' : ''}`;
	const jsonlPath = join(root, 'data', 'derived', `lfm3-expand${tag}.jsonl`);
	if (!process.argv.includes('--force')) {
		let existing = 0;
		try {
			existing = statSync(jsonlPath).size;
		} catch {
			existing = 0;
		}
		if (existing > 0) {
			throw new Error(
				`refusing to overwrite ${jsonlPath} (${existing} bytes) without --force`,
			);
		}
	}
	console.log(`samples: ${rows.length} (v2 compress IRs, LFM3 expanding)`);
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	writeFileSync(jsonlPath, '');
	const scored: ExpandRow[] = new Array(rows.length);
	let errors = 0;
	let cursor = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= rows.length) {
				return;
			}
			const row = rows[my];
			if (row === undefined) {
				return;
			}
			scored[my] = await runSample(row.key, row.irLite, strict);
			appendFileSync(jsonlPath, `${JSON.stringify(scored[my])}\n`);
			if (scored[my]?.error !== null && scored[my]?.error !== undefined) {
				errors += 1;
				if (errors <= 3) {
					console.error(
						`sample error ${errors}: ${scored[my]?.error ?? 'unknown'}`,
					);
				}
			}
			if (errors > rows.length * MAX_ERROR_RATE) {
				throw new Error(`error budget exceeded (${errors} failures)`);
			}
		}
	});
	await Promise.all(workers);
	const ok = scored.filter((s) => s.error === null);
	const passed = ok.filter((s) => s.pass).length;
	const failByCheck: Record<string, number> = {};
	for (const s of ok.filter((s) => !s.pass)) {
		for (const c of s.checks.filter((c) => !c.pass)) {
			failByCheck[c.name] = (failByCheck[c.name] ?? 0) + 1;
		}
	}
	const walls = ok.map((s) => s.wallMs).sort((a, b) => a - b);
	const summary = {
		generatedAt: new Date().toISOString(),
		model: 'kaitchup/LFM3-1.7B-GSQ-GGUF:Q6_K_RCO (local)',
		source: sourceFile,
		prompt: strict ? 'strict-rule3-variant (diagnosis-only)' : 'v0',
		n: scored.length,
		errors,
		passRate: ok.length === 0 ? null : passed / ok.length,
		passed,
		scored: ok.length,
		failByCheck,
		latencyMs: {
			p50: walls.length === 0 ? 0 : percentile(walls, 0.5),
			mean:
				walls.length === 0
					? 0
					: walls.reduce((a, b) => a + b, 0) / walls.length,
		},
	};
	writeFileSync(
		join(root, 'data', 'derived', `lfm3-expand${tag}-summary.json`),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} passRate=${summary.passRate === null ? 'n/a' : summary.passRate.toFixed(3)} (${passed}/${ok.length}) p50=${summary.latencyMs.p50}ms`,
	);
	console.log(`failByCheck: ${JSON.stringify(failByCheck)}`);
}

if (import.meta.main) {
	await main();
}
