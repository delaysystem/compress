// Span-pointer emission pilot (10x drive): doc2dial grounded turns,
// two arms (bare v1 vs span-citing) on identical samples. Per-row
// request map enumerates oracle-cited spans ^1..^N (retrieval is out
// of scope; oracle isolates the compression question). Ratio in cl100k
// (cross-arm fair); recall grounded on cited span text; span-use and
// decode diagnostics ride along.
// Run from worker/: node --experimental-strip-types scripts/span-emit.ts [limit] [--force] [--resume] [--provider gemini]
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_encoding } from 'tiktoken';
import {
	GEMINI_API_KEY_NAME,
	GROQ_API_KEY_NAME,
	GROQ_BASE_URL,
} from '../src/config.ts';
import { extractEntities } from '../src/entities.ts';
import {
	classifyLine,
	prepareExpansion,
	stripThinkBlocks,
} from '../src/expander.ts';
import { GeminiClient } from '../src/gemini.ts';
import {
	percentile,
	recallByClass,
	scoreGroundedSample,
} from '../src/ireval.ts';
import { OpenAIChatClient } from '../src/openai.ts';
import { Pacer } from '../src/pace.ts';
import {
	BACKPRESSURE_BUDGET,
	BackpressureTrip,
	backoffMs,
	CALL_TIME_TRIP_MS,
	DEFAULT_BUDGET,
	isBackpressure,
	isRetryable,
} from '../src/retry.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';
import type { SpanStore } from '../src/spanref.ts';

const GROQ_MODEL = 'qwen/qwen3.8-27b';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0;
const MAX_IR_TOKENS = 256;
const GROQ_EXTRA_BODY = { reasoning_effort: 'none' };
const MIN_INTERVAL_MS = 5000;
const CONCURRENCY = 4;
const MAX_ERROR_RATE = 0.1;
const PUNT_TEXT = 'insufficient grounding';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Arm = 'bare' | 'span';

interface Sample {
	key: string;
	reference: string;
	spans: string[];
}

interface SpanRow {
	key: string;
	arm: Arm;
	provider: string;
	ir: string;
	decoded: string | null;
	decodeError: string | null;
	spanUses: number;
	fullTokens: number;
	liteTokens: number;
	ratio: number;
	recall: number | null;
	missing: string[];
	classTotals: Record<string, number>;
	punt: boolean;
	wallMs: number;
	error: string | null;
}

interface GenClient {
	generate(
		model: string,
		prompt: string,
		params?: {
			temperature?: number;
			maxOutputTokens?: number;
			extraBody?: Record<string, unknown>;
		},
	): Promise<{
		text: string;
		finishReason: string | null;
		usage?: { candidatesTokens?: number; reasoningTokens?: number };
	}>;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

async function withRetry(
	label: string,
	pacer: Pacer,
	trip: BackpressureTrip,
	client: GenClient,
	model: string,
	prompt: string,
	extra: Record<string, unknown> | undefined,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	if (trip.tripped) {
		throw new Error(`${label}: quota wall — aborting campaign`);
	}
	const callStart = Date.now();
	let attempt = 0;
	for (;;) {
		await pacer.wait();
		try {
			const r = await client.generate(model, prompt, {
				temperature: TEMPERATURE,
				maxOutputTokens: MAX_IR_TOKENS,
				...(extra === undefined ? {} : { extraBody: extra }),
			});
			trip.recordSuccess();
			return { ok: true, text: r.text };
		} catch (e) {
			if (!isRetryable(e)) {
				return { ok: false, error: `${label}: ${messageOf(e)}`.slice(0, 200) };
			}
			if (isBackpressure(e) && trip.recordBackpressure()) {
				throw new Error(`${label}: quota wall — aborting campaign`);
			}
			if (Date.now() - callStart > CALL_TIME_TRIP_MS) {
				throw new Error(`${label}: call burning past trip — aborting campaign`);
			}
			const budget = isBackpressure(e) ? BACKPRESSURE_BUDGET : DEFAULT_BUDGET;
			if (attempt >= budget.maxAttempts) {
				return {
					ok: false,
					error: `${label}: ${messageOf(e)} (retries exhausted)`.slice(0, 200),
				};
			}
			await sleep(backoffMs(attempt, budget.baseMs));
			attempt += 1;
		}
	}
}

function countRefs(ir: string): number {
	return ir.split('\n').reduce((n, ln) => {
		const t = ln.trim();
		if (classifyLine(t) === 'span') return n + 1;
		const m = t.match(/\^(\d{1,3})/g);
		return n + (m ? m.length : 0);
	}, 0);
}

async function runSample(
	client: GenClient,
	pacer: Pacer,
	trip: BackpressureTrip,
	model: string,
	provider: string,
	extra: Record<string, unknown> | undefined,
	arm: Arm,
	prompt: string,
	sample: Sample,
	store: SpanStore,
	count: (s: string) => number,
): Promise<SpanRow> {
	const started = performance.now();
	const fail = (error: string): SpanRow => ({
		key: sample.key,
		arm,
		provider,
		ir: '',
		decoded: null,
		decodeError: null,
		spanUses: 0,
		fullTokens: count(sample.reference),
		liteTokens: 0,
		ratio: 0,
		recall: null,
		missing: [],
		classTotals: {},
		punt: false,
		wallMs: Math.round(performance.now() - started),
		error,
	});
	const gen = await withRetry(
		`${arm}-emit`,
		pacer,
		trip,
		client,
		model,
		prompt,
		extra,
	);
	if (!gen.ok) {
		return fail(gen.error);
	}
	const ir = stripThinkBlocks(gen.text);
	const punt = ir.trim().toLowerCase() === PUNT_TEXT;
	const prep = punt
		? null
		: prepareExpansion(ir, {
				dict: { version: 'span-empty', entries: [] },
				dictVersion: 'span-empty',
				store,
				kbVersion: store.version,
			});
	const decoded = prep?.ok ? prep.value.expandedIr : null;
	const groundText = sample.spans.join('\n');
	const fullTokens = count(sample.reference);
	const liteTokens = count(ir);
	const s = punt
		? null
		: scoreGroundedSample(
				sample.reference,
				decoded ?? ir,
				groundText,
				fullTokens,
				liteTokens,
			);
	const classTotals: Record<string, number> = {};
	if (s !== null) {
		for (const c of recallByClass(
			extractEntities(sample.reference),
			s.missing,
			extractEntities(groundText),
		)) {
			classTotals[c.class] = c.total;
		}
	}
	return {
		key: sample.key,
		arm,
		provider,
		ir,
		decoded,
		decodeError:
			prep !== null && !prep.ok ? prep.error.message.slice(0, 160) : null,
		spanUses: countRefs(ir),
		fullTokens,
		liteTokens,
		ratio: s?.ratio ?? 0,
		recall: s?.recall ?? null,
		missing: s?.missing ?? [],
		classTotals,
		punt,
		wallMs: Math.round(performance.now() - started),
		error: null,
	};
}

function flagValue(flag: string, def: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const enc = get_encoding('cl100k_base');
	const count = (s: string): number => enc.encode(s).length;
	const bareBase = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-v1.md'),
		'utf8',
	);
	const spanBase = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-span-v1.md'),
		'utf8',
	);
	if (!spanBase.includes('[[SPANS]]')) {
		throw new Error('span prompt lacks [[SPANS]] slot');
	}
	const samples = readFileSync(
		join(root, 'data', 'derived', 'span-sample.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as Sample);
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	const picked = samples.slice(0, limit ?? samples.length);
	const provider = flagValue('--provider', 'groq');
	if (provider !== 'groq' && provider !== 'gemini') {
		throw new Error(`--provider must be groq or gemini, got ${provider}`);
	}
	const model = provider === 'gemini' ? GEMINI_MODEL : GROQ_MODEL;
	const extra = provider === 'gemini' ? undefined : GROQ_EXTRA_BODY;
	const resume = process.argv.includes('--resume');
	const jsonlPath = join(root, 'data', 'derived', 'span-emit.jsonl');
	if (!resume && !process.argv.includes('--force')) {
		let existing = 0;
		try {
			existing = statSync(jsonlPath).size;
		} catch {
			existing = 0;
		}
		if (existing > 0) {
			throw new Error(`refusing to overwrite ${jsonlPath} without --force`);
		}
	}
	if (!resume) {
		writeFileSync(jsonlPath, '');
	}
	const resolved = resolveSecret({
		name: provider === 'gemini' ? GEMINI_API_KEY_NAME : GROQ_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolved.resolution)} present=true`);
	console.log(`provider: ${provider} model: ${model}`);
	const client: GenClient =
		provider === 'gemini'
			? new GeminiClient({ apiKey: resolved.value })
			: new OpenAIChatClient({
					apiKey: resolved.value,
					baseUrl: GROQ_BASE_URL,
					timeoutMs: 120_000,
				});
	const pacer = new Pacer(MIN_INTERVAL_MS);
	const trip = new BackpressureTrip();
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	const done = new Set(
		resume
			? readFileSync(jsonlPath, 'utf8')
					.trim()
					.split('\n')
					.filter((l) => l.length > 0)
					.map((l) => {
						const r = JSON.parse(l) as SpanRow;
						return `${r.key}::${r.arm}`;
					})
			: [],
	);
	const jobs = picked.flatMap((s) => [
		{ sample: s, arm: 'bare' as const },
		{ sample: s, arm: 'span' as const },
	]);
	console.log(`jobs: ${jobs.length} (${picked.length} turns x bare+span)`);
	const pending = jobs.filter((j) => !done.has(`${j.sample.key}::${j.arm}`));
	const scored: SpanRow[] = [];
	let cursor = 0;
	let errors = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= pending.length) {
				return;
			}
			const job = pending[my];
			if (job === undefined) {
				return;
			}
			const catalog = job.sample.spans
				.map((t, i) => `^${i + 1}: ${t}`)
				.join('\n');
			const prompt =
				job.arm === 'bare'
					? `${bareBase}\n---\n\nREPLY TO COMPRESS:\n${job.sample.reference}\n\nIR:`
					: `${spanBase.replace('[[SPANS]]', catalog)}\n---\n\nREPLY TO COMPRESS:\n${job.sample.reference}\n\nIR:`;
			const store: SpanStore = {
				version: 'spanreq',
				documents: new Map([
					['q', new Map(job.sample.spans.map((t, i) => [String(i + 1), t]))],
				]),
			};
			const row = await runSample(
				client,
				pacer,
				trip,
				model,
				provider,
				extra,
				job.arm,
				prompt,
				job.sample,
				store,
				count,
			);
			scored.push(row);
			appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`);
			if (row.error !== null) {
				errors += 1;
				if (errors <= 3) {
					console.error(`sample error ${errors}: ${row.error}`);
				}
			}
			if (errors > pending.length * MAX_ERROR_RATE) {
				throw new Error(`error budget exceeded (${errors} failures)`);
			}
		}
	});
	await Promise.all(workers);
	const prior: SpanRow[] = resume
		? readFileSync(jsonlPath, 'utf8')
				.trim()
				.split('\n')
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as SpanRow)
				.filter((r) => done.has(`${r.key}::${r.arm}`))
		: [];
	const all = [...prior, ...scored].filter((r) => r.error === null && !r.punt);
	const arms = ['bare', 'span'] as const;
	const summary: Record<string, unknown> = {
		generatedAt: new Date().toISOString(),
		model,
		providers: [...new Set([...prior, ...scored].map((r) => r.provider))],
		n: all.length,
		errors,
	};
	for (const arm of arms) {
		const rs = all.filter((r) => r.arm === arm);
		const ratios = rs
			.map((r) => r.ratio)
			.filter((x) => Number.isFinite(x))
			.sort((a, b) => a - b);
		const recalls = rs.map((r) => r.recall).filter((x) => x !== null);
		summary[arm] = {
			n: rs.length,
			ratioP50: ratios.length > 0 ? percentile(ratios, 0.5) : 0,
			ratioMean:
				ratios.length > 0
					? ratios.reduce((a, b) => a + b, 0) / ratios.length
					: 0,
			recallMean:
				recalls.length > 0
					? recalls.reduce((a, b) => a + b, 0) / recalls.length
					: 0,
			recallN: recalls.length,
			decodeFails: rs.filter((r) => r.decodeError !== null).length,
			spanUses: rs.reduce((a, r) => a + r.spanUses, 0),
		};
	}
	writeFileSync(
		join(root, 'data', 'derived', 'span-emit-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	for (const arm of arms) {
		const s = summary[arm] as {
			n: number;
			ratioP50: number;
			ratioMean: number;
			recallMean: number;
			recallN: number;
			decodeFails: number;
			spanUses: number;
		};
		console.log(
			`${arm}: n=${s.n} ratioP50=${s.ratioP50.toFixed(2)} ratioMean=${s.ratioMean.toFixed(2)} recall=${s.recallMean.toFixed(3)}(N=${s.recallN}) decodeFails=${s.decodeFails} spanUses=${s.spanUses}`,
		);
	}
	enc.free();
}

await main();
