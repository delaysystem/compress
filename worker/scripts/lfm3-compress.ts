// LFM3-as-compressor eval (run 018): pure reference->IR compression with the
// 1-shot + </think>-prefill convergence fix. Bitext selection mirrors v2
// (FNV spread order, first N; v2 file itself stays frozen). Scoring: plain
// recall vs reference + ratio in LFM3 tokens + tier-1 screen (IR vs
// reference). The model sometimes echoes the prompt framing before the IR;
// the harness scores only the block after the last IR: marker (documented).
// New outputs: data/derived/lfm3-compress.jsonl + lfm3-compress-summary.json.
// Run from worker/: node --experimental-strip-types scripts/lfm3-compress.ts [limit] [--force]
// Default N=25 (flagship-subset scale). Requires llama serve :9931.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { extractEntities } from '../src/entities.ts';
import { checkEntityGrounding } from '../src/grounding.ts';
import {
	recallByClass,
	type SampleScore,
	scoreSample,
	summarize,
} from '../src/ireval.ts';

const LFM3_BASE = 'http://127.0.0.1:9931';
const CONCURRENCY = 4;
const TEMPERATURE = 0;
const MAX_IR_TOKENS = 256;
const MAX_ERROR_RATE = 0.1;
const FETCH_RETRIES = 2;
const DEFAULT_N = 25;
const THINK_PREFILL = '</think>\n';

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

/** FNV-1a 32-bit (mirrors frozen scripts/ir-pilot-v2.ts selection order). */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

function stripPrefill(ir: string): string {
	return ir.startsWith(THINK_PREFILL) ? ir.slice(THINK_PREFILL.length) : ir;
}

/** Score only the IR block. Echo-leading outputs start by regurgitating the
 * prompt framing; drop through its closing marker. Echo-only output (cut
 * before any IR) yields '' — an honest fail, never a mid-echo fragment (run
 * 019 lesson: slicing after the LAST marker grabbed garbage when the model
 * echoed prompts containing their own IR: markers). Trailing
 * meta-commentary stays (visible in rows; dilution noted, not hidden). */
function extractIrBlock(content: string): string {
	if (content.startsWith('REPLY TO COMPRESS:')) {
		const end = content.indexOf('\n\nIR:\n');
		if (end < 0) {
			return '';
		}
		return content.slice(end + '\n\nIR:\n'.length).trim();
	}
	return content.trim();
}

async function postJson(path: string, body: unknown): Promise<unknown> {
	let last = '';
	for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
		try {
			const res = await fetch(`${LFM3_BASE}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			return (await res.json()) as unknown;
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
			await sleep(1000);
		}
	}
	throw new Error(`lfm3 ${path} failed: ${last}`);
}

async function tokenize(text: string): Promise<number> {
	const out = (await postJson('/tokenize', { content: text })) as {
		tokens?: unknown;
	};
	if (!Array.isArray(out.tokens)) {
		throw new Error('lfm3 /tokenize shape changed');
	}
	return out.tokens.length;
}

interface CompressRow {
	key: string;
	ir: string;
	echoed: boolean;
	fullTokens: number;
	irTokens: number;
	ratio: number;
	recall: number | null;
	missing: string[];
	tier1pass: boolean;
	tier1ungrounded: string[];
	wallMs: number;
	error: string | null;
}

async function runSample(
	promptTemplate: string,
	demo: string,
	key: string,
	reference: string,
): Promise<CompressRow> {
	const started = performance.now();
	const fail = (error: string): CompressRow => ({
		key,
		ir: '',
		echoed: false,
		fullTokens: 0,
		irTokens: 0,
		ratio: 0,
		recall: null,
		missing: [],
		tier1pass: true,
		tier1ungrounded: [],
		wallMs: Math.round(performance.now() - started),
		error,
	});
	try {
		const prompt = `${promptTemplate}\n---\n${demo}REPLY TO COMPRESS:\n${reference}\n\nIR:\n`;
		const [gen, fullTokens] = await Promise.all([
			postJson('/v1/chat/completions', {
				messages: [
					{ role: 'user', content: prompt },
					{ role: 'assistant', content: THINK_PREFILL },
				],
				temperature: TEMPERATURE,
				max_tokens: MAX_IR_TOKENS,
			}),
			tokenize(reference),
		]);
		const g = gen as {
			choices?: Array<{ message?: { content?: unknown } }>;
		};
		const raw =
			typeof g.choices?.[0]?.message?.content === 'string'
				? (g.choices[0].message.content as string)
				: '';
		const echoed = raw.includes('\nIR:\n');
		const ir = extractIrBlock(stripPrefill(raw));
		const irTokens = await tokenize(ir);
		const s = scoreSample(reference, ir, fullTokens, irTokens);
		const t1 = checkEntityGrounding(
			extractEntities(ir),
			extractEntities(reference),
		);
		return {
			key,
			ir,
			echoed,
			fullTokens,
			irTokens,
			ratio: s.ratio,
			recall: s.recall,
			missing: s.missing,
			tier1pass: t1.pass,
			tier1ungrounded: t1.ungrounded,
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
	const rows = parse(
		readFileSync(join(root, 'data', 'bitext', 'bitext-27k.csv'), 'utf8'),
		{ columns: true, skip_empty_lines: true },
	) as Array<Record<string, string>>;
	const samples = [...rows.keys()]
		.sort((a, b) => fnv1a(`bitext-${a}`) - fnv1a(`bitext-${b}`))
		.slice(0, n)
		.map((idx) => ({
			key: `bitext-${idx}`,
			reference: rows[idx]?.response ?? '',
		}));
	const jsonlPath = join(root, 'data', 'derived', 'lfm3-compress.jsonl');
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
	const promptTemplate = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-v1.md'),
		'utf8',
	);
	const demo = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-1shot-v1.md'),
		'utf8',
	);
	console.log(`samples: ${samples.length} (Bitext spread, LFM3 compressing)`);
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	writeFileSync(jsonlPath, '');
	const scored: CompressRow[] = new Array(samples.length);
	let errors = 0;
	let cursor = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= samples.length) {
				return;
			}
			const sample = samples[my];
			if (sample === undefined) {
				return;
			}
			scored[my] = await runSample(
				promptTemplate,
				demo,
				sample.key,
				sample.reference,
			);
			appendFileSync(jsonlPath, `${JSON.stringify(scored[my])}\n`);
			if (scored[my]?.error !== null && scored[my]?.error !== undefined) {
				errors += 1;
				if (errors <= 3) {
					console.error(
						`sample error ${errors}: ${scored[my]?.error ?? 'unknown'}`,
					);
				}
			}
			if (errors > samples.length * MAX_ERROR_RATE) {
				throw new Error(`error budget exceeded (${errors} failures)`);
			}
		}
	});
	await Promise.all(workers);
	const ok = scored.filter((s) => s.error === null);
	const scores: SampleScore[] = ok.map((s) => ({
		fullTokens: s.fullTokens,
		irTokens: s.irTokens,
		ratio: s.ratio,
		recall: s.recall,
		missing: s.missing,
		emptyIr: s.ir.trim().length === 0,
	}));
	const lite = summarize(scores);
	const summary = {
		generatedAt: new Date().toISOString(),
		prompt: 'prompts/ir-emit-v1.md + prompts/ir-emit-1shot-v1.md',
		technique: '1-shot demo + </think> assistant prefill (run 018)',
		tokenizerNote: 'ratios in LFM3 tokens via /tokenize, not Gemini tokens',
		n: scored.length,
		errors,
		echoRate:
			ok.length === 0 ? null : ok.filter((s) => s.echoed).length / ok.length,
		tier1fails: ok.filter((s) => !s.tier1pass).length,
		lite,
		recallByClass: recallByClass(
			ok.flatMap((s) => {
				const ref = samples.find((x) => x.key === s.key)?.reference ?? '';
				return extractEntities(ref);
			}),
			ok.flatMap((s) => s.missing),
		),
	};
	writeFileSync(
		join(root, 'data', 'derived', 'lfm3-compress-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} echoRate=${summary.echoRate === null ? 'n/a' : summary.echoRate.toFixed(2)} tier1fails=${summary.tier1fails}`,
	);
	console.log(
		`recall=${lite.meanRecall === null ? 'n/a' : lite.meanRecall.toFixed(3)} recallN=${lite.recallN} p50ratio=${lite.p50Ratio.toFixed(2)}`,
	);
}

await main();
