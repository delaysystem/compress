// Qwen3.8-27B expander eval via Groq free tier: the same 45 IRs as the
// LFM3/Gemini/NIM evals (keys+IRs read from the LFM3 row files so samples
// are identical), expanded through the real pipeline path
// (prepareExpansion + validator with counted parity). Two arms: v0 + strict
// (product v1) prompts. ~90 Groq calls. Free-tier budget (Nov 2026 docs):
// 30 RPM, 1k req/day, 8k tok/min, 200k tok/day per model — one full eval
// costs ~90 requests and ~35k tokens. New outputs:
// data/derived/groq-expand.jsonl + groq-expand-summary.json. Prior runners
// and their outputs untouched.
// Run from worker/: node --experimental-strip-types scripts/groq-expand.ts [limit] [--force] [--resume]
// --resume continues an aborted run: clean rows kept, error rows retried,
// summary covers the whole file. Skips the --force guard by design.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROQ_API_KEY_NAME, GROQ_BASE_URL } from '../src/config.ts';
import { buildExpansionPrompt, prepareExpansion } from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';
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
import { validateExpansion } from '../src/validator.ts';
import { buildStrictPrompt } from './lfm3-expand.ts';

/** Probed live 2026-11-12 (Groq models API lists qwen/qwen3.8-27b); re-probe on 404. */
const MODEL = 'qwen/qwen3.8-27b';
/** reasoning_effort none requested (mirrors the NIM non-reasoning posture);
 * Groq may 400 on unsupported values — the smoke run decides; reasoning
 * tokens are captured per call either way.
 */
const GROQ_EXTRA_BODY = { reasoning_effort: 'none' };
const CONCURRENCY = 4;
/** Tokens/min is the binding free-tier constraint (8k TPM vs ~550/call),
 * not RPM: 5s spacing holds ~12 RPM ≈ 6.6k TPM with headroom on both. */
const GROQ_MIN_INTERVAL_MS = 5000;
const TEMPERATURE = 0;
const MAX_REPLY_TOKENS = 512;
const MAX_ERROR_RATE = 0.1;

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

type Arm = 'v0' | 'strict';

interface ExpandRow {
	key: string;
	arm: Arm;
	reply: string;
	finish: string;
	pass: boolean;
	checks: Array<{ name: string; pass: boolean }>;
	reasoningTokens: number | null;
	wallMs: number;
	error: string | null;
}

async function withRetry(
	label: string,
	pacer: Pacer,
	trip: BackpressureTrip,
	client: OpenAIChatClient,
	model: string,
	prompt: string,
): Promise<
	| { ok: true; text: string; finish: string; rtokens: number | null }
	| { ok: false; error: string }
> {
	if (trip.tripped) {
		throw new Error(
			`${label}: quota wall (sustained 429s, zero success) — aborting campaign`,
		);
	}
	const callStart = Date.now();
	let attempt = 0;
	for (;;) {
		await pacer.wait();
		try {
			const params = {
				temperature: TEMPERATURE,
				maxOutputTokens: MAX_REPLY_TOKENS,
				...{ extraBody: GROQ_EXTRA_BODY },
			};
			const r = await client.generate(model, prompt, params);
			trip.recordSuccess();
			return {
				ok: true,
				text: r.text,
				finish: r.finishReason ?? '',
				rtokens: r.usage?.reasoningTokens ?? null,
			};
		} catch (e) {
			if (!isRetryable(e)) {
				return {
					ok: false,
					error: `${label}: ${messageOf(e)}`.slice(0, 200),
				};
			}
			if (isBackpressure(e) && trip.recordBackpressure()) {
				throw new Error(
					`${label}: quota wall (sustained 429s, zero success) — aborting campaign`,
				);
			}
			if (Date.now() - callStart > CALL_TIME_TRIP_MS) {
				throw new Error(
					`${label}: quota wall (single call burning past ${CALL_TIME_TRIP_MS / 60000} min) — aborting campaign`,
				);
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

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function isGreeted(reply: string): boolean {
	return /^(hi|hello|hey|thank you for reaching out)\b/i.test(reply.trim());
}

function isSignedOff(reply: string): boolean {
	return /(best regards|your support team|thank you for your patience)\.?$/i.test(
		reply.trim(),
	);
}

async function runSample(
	client: OpenAIChatClient,
	pacer: Pacer,
	trip: BackpressureTrip,
	model: string,
	key: string,
	ir: string,
	arm: Arm,
): Promise<ExpandRow> {
	const started = performance.now();
	const fail = (error: string): ExpandRow => ({
		key,
		arm,
		reply: '',
		finish: '',
		pass: false,
		checks: [],
		reasoningTokens: null,
		wallMs: Math.round(performance.now() - started),
		error,
	});
	const prepared = prepareExpansion(ir, {
		dict: { version: 'eval-empty', entries: [] },
		dictVersion: 'eval-empty',
		store: { version: 'eval-empty', documents: new Map() },
		kbVersion: 'eval-empty',
	});
	if (!prepared.ok) {
		return fail(`prepare: ${prepared.error.message}`);
	}
	const prompt =
		arm === 'strict'
			? buildStrictPrompt(prepared.value.expandedIr)
			: buildExpansionPrompt(prepared.value.expandedIr);
	const gen = await withRetry(
		`${arm}-expand`,
		pacer,
		trip,
		client,
		model,
		prompt,
	);
	if (!gen.ok) {
		return fail(gen.error);
	}
	const v = validateExpansion({
		splicedIr: prepared.value.expandedIr,
		slotValues: [],
		output: gen.text,
		finishReason: gen.finish === 'STOP' ? 'STOP' : 'MAX_TOKENS',
	});
	return {
		key,
		arm,
		reply: gen.text,
		finish: gen.finish,
		pass: v.pass,
		checks: v.checks.map((c) => ({ name: c.name, pass: c.pass })),
		reasoningTokens: gen.rtokens,
		wallMs: Math.round(performance.now() - started),
		error: null,
	};
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	// Identical samples to the LFM3/Gemini evals.
	const base = readFileSync(
		join(root, 'data', 'derived', 'lfm3-expand.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { key: string; ir: string });
	const v3 = readFileSync(
		join(root, 'data', 'derived', 'lfm3-expand-v3.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { key: string; ir: string });
	const samples = [...base, ...v3].slice(0, limit ?? 45);
	let jobs: Array<{ key: string; ir: string; arm: Arm }> = samples.flatMap(
		(s) => [
			{ key: s.key, ir: s.ir, arm: 'v0' as const },
			{ key: s.key, ir: s.ir, arm: 'strict' as const },
		],
	);
	const model = MODEL;
	const tag = 'groq';
	const resume = process.argv.includes('--resume');
	const jsonlPath = join(root, 'data', 'derived', `${tag}-expand.jsonl`);
	if (!resume && !process.argv.includes('--force')) {
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
	// Resume: keep clean rows, drop error rows (they retry), skip done jobs.
	let prior: ExpandRow[] = [];
	if (resume) {
		try {
			prior = readFileSync(jsonlPath, 'utf8')
				.trim()
				.split('\n')
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as ExpandRow)
				.filter((r) => r.error === null);
		} catch {
			prior = [];
		}
		const done = new Set(prior.map((r) => `${r.key}\n${r.arm}`));
		jobs = jobs.filter((j) => !done.has(`${j.key}\n${j.arm}`));
		mkdirSync(join(root, 'data', 'derived'), { recursive: true });
		writeFileSync(
			jsonlPath,
			prior.map((r) => JSON.stringify(r)).join('\n') +
				(prior.length > 0 ? '\n' : ''),
		);
		console.log(`resume: ${prior.length} kept, ${jobs.length} remaining`);
	}
	const resolved = resolveSecret({
		name: GROQ_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	const apiKey = resolved.value;
	console.log(`key: ${describeResolution(resolved.resolution)} present=true`);
	console.log(`jobs: ${jobs.length} (${samples.length} IRs x v0+strict)`);
	// 120s: Groq LPUs answer in seconds; anything beyond 2 min is a hang,
	// not a slow success (contrast NIM's 250s+ degraded mode).
	const client = new OpenAIChatClient({
		apiKey,
		baseUrl: GROQ_BASE_URL,
		timeoutMs: 120_000,
	});
	const pacer = new Pacer(GROQ_MIN_INTERVAL_MS);
	const trip = new BackpressureTrip();
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	if (!resume) {
		writeFileSync(jsonlPath, '');
	}
	const scored: ExpandRow[] = new Array(jobs.length);
	let errors = 0;
	let cursor = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= jobs.length) {
				return;
			}
			const job = jobs[my];
			if (job === undefined) {
				return;
			}
			scored[my] = await runSample(
				client,
				pacer,
				trip,
				model,
				job.key,
				job.ir,
				job.arm,
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
			// max(1, …): tiny runs tolerate a single transient (no statistical
			// meaning); the 10% gate still binds at campaign scale.
			if (errors > Math.max(1, jobs.length * MAX_ERROR_RATE)) {
				throw new Error(`error budget exceeded (${errors} failures)`);
			}
		}
	});
	await Promise.all(workers);
	const all = [...prior, ...scored];
	const arms = {} as Record<
		Arm,
		{
			n: number;
			passed: number;
			passRate: number | null;
			failByCheck: Record<string, number>;
			greetings: number;
			signoffs: number;
			maxReasoningTokens: number;
			p50ms: number;
		}
	>;
	for (const arm of ['v0', 'strict'] as const) {
		const ok = all.filter((s) => s.arm === arm && s.error === null);
		const passed = ok.filter((s) => s.pass).length;
		const failByCheck: Record<string, number> = {};
		for (const s of ok.filter((s) => !s.pass)) {
			for (const c of s.checks.filter((c) => !c.pass)) {
				failByCheck[c.name] = (failByCheck[c.name] ?? 0) + 1;
			}
		}
		const walls = ok.map((s) => s.wallMs).sort((a, b) => a - b);
		arms[arm] = {
			n: ok.length,
			passed,
			passRate: ok.length === 0 ? null : passed / ok.length,
			failByCheck,
			greetings: ok.filter((s) => isGreeted(s.reply)).length,
			signoffs: ok.filter((s) => isSignedOff(s.reply)).length,
			maxReasoningTokens: Math.max(0, ...ok.map((s) => s.reasoningTokens ?? 0)),
			p50ms: walls.length === 0 ? 0 : percentile(walls, 0.5),
		};
	}
	const summary = {
		generatedAt: new Date().toISOString(),
		model,
		reasoning:
			'requested via reasoning_effort none (per-call token capture tells)',
		n: all.length,
		errors: all.filter((s) => s.error !== null).length,
		arms,
	};
	writeFileSync(
		join(root, 'data', 'derived', `${tag}-expand-summary.json`),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(`n=${summary.n} errors=${summary.errors}`);
	for (const [name, a] of Object.entries(arms)) {
		console.log(
			`${name}: pass=${a.passRate === null ? 'n/a' : a.passRate.toFixed(3)} (${a.passed}/${a.n}) greet=${a.greetings} signoff=${a.signoffs} maxRtok=${a.maxReasoningTokens} p50=${a.p50ms}ms fails=${JSON.stringify(a.failByCheck)}`,
		);
	}
}

await main();
