// Model-emitted IR pilot (PLAN.md Step 5 precondition, highest-risk validation).
// N Bitext instructions -> minimal IR via the pinned prompt; measures ratio
// (countTokens) + entity recall vs the reference response. Overlap subset reruns
// on the flagship for model-dependence calibration.
// Run from worker/: node --experimental-strip-types scripts/ir-pilot.ts [limit] [--skip-flagship]
// Optional limit runs a leading slice (smoke tests, diagnosis). --skip-flagship
// parks the calibration arm (use when flagship quota is exhausted; rerun later).
// Writes data/derived/ir-pilot.jsonl + ir-pilot-summary.json.
// Approximation (honest): the model answers AND compresses in one step from the
// question; production emits IR post-reasoning. Ratio is robust to this;
// recall needs the manual spot-check below. Values never logged.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { GEMINI_API_KEY_NAME, IR_PILOT_TURNS_MIN } from '../src/config.ts';
import { extractEntities } from '../src/entities.ts';
import { GeminiClient } from '../src/gemini.ts';
import { recallByClass, scoreSample, summarize } from '../src/ireval.ts';
import { Pacer } from '../src/pace.ts';
import {
	BACKPRESSURE_BUDGET,
	backoffMs,
	DEFAULT_BUDGET,
	isBackpressure,
	isRetryable,
} from '../src/retry.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';

/** Probed live 2026-11-11 (API redirect targets); re-probe on 404. */
const LITE_MODEL = 'gemini-3.5-flash-lite';
/** Probed live 2026-11-11; see above. */
const FLAGSHIP_MODEL = 'gemini-3.8-flash';
/** Calibration subset (25% of pilot N). Chosen; small by design (flagship costs more). */
const OVERLAP_N = 50;
/** Chosen: polite parallelism against free-tier rate limits. */
const CONCURRENCY = 4;
/** Global floor between lite-model calls. Starting point from observed 429s; tuned by pilot runs. */
const LITE_MIN_INTERVAL_MS = 2000;
/** Global floor between flagship calls (tighter quota observed). Starting point; tuned by pilot runs. */
const FLAGSHIP_MIN_INTERVAL_MS = 8000;
/** Deterministic measurement; production may differ (recorded). */
const TEMPERATURE = 0;
/** Caps runaway cost; IRs run ~100 tokens (headroom, recorded). */
const MAX_IR_TOKENS = 256;
/** Abort threshold for systematic outages. Chosen. */
const MAX_ERROR_RATE = 0.1;

/** FNV-1a 32-bit (spec constants) for deterministic spread sampling. */
function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

interface Sample {
	idx: number;
	instruction: string;
	reference: string;
}

interface ScoredSample {
	idx: number;
	instruction: string;
	reference: string;
	irLite: string;
	liteTokens: number;
	fullTokens: number;
	ratioLite: number;
	recallLite: number | null;
	missingLite: string[];
	irFlash: string | null;
	flashTokens: number | null;
	flagshipError: string | null;
	error: string | null;
}

async function withRetry<T>(
	label: string,
	pacer: Pacer,
	fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
	let attempt = 0;
	for (;;) {
		await pacer.wait();
		try {
			return { ok: true, value: await fn() };
		} catch (e) {
			if (!isRetryable(e)) {
				return { ok: false, error: `${label}: ${messageOf(e)}`.slice(0, 200) };
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

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const { value: apiKey, resolution } = resolveSecret({
		name: GEMINI_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolution)} present=true`);
	const promptTemplate = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-v0.md'),
		'utf8',
	);
	const rows = parse(
		readFileSync(join(root, 'data', 'bitext', 'bitext-27k.csv'), 'utf8'),
		{
			columns: true,
			skip_empty_lines: true,
		},
	) as Array<Record<string, string>>;
	const order = [...rows.keys()]
		.sort((a, b) => fnv1a(`bitext-${a}`) - fnv1a(`bitext-${b}`))
		.slice(0, IR_PILOT_TURNS_MIN);
	const samples: Sample[] = order.map((idx) => {
		const row = rows[idx] ?? {};
		return {
			idx,
			instruction: row.instruction ?? '',
			reference: row.response ?? '',
		};
	});
	const client = new GeminiClient({ apiKey });
	const pacers = {
		lite: new Pacer(LITE_MIN_INTERVAL_MS),
		flagship: new Pacer(FLAGSHIP_MIN_INTERVAL_MS),
	};
	const limitArg = Number(process.argv[2]);
	const target =
		Number.isInteger(limitArg) && limitArg > 0
			? Math.min(limitArg, samples.length)
			: samples.length;
	samples.length = target;
	const jsonlPath = join(root, 'data', 'derived', 'ir-pilot.jsonl');
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	writeFileSync(jsonlPath, '');
	const skipFlagship = process.argv.includes('--skip-flagship');
	console.log(
		`flagship arm: ${skipFlagship ? 'skipped' : `first ${OVERLAP_N} samples`}`,
	);
	const scored: ScoredSample[] = new Array(samples.length);
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
				client,
				promptTemplate,
				sample,
				my < OVERLAP_N && !skipFlagship,
				pacers,
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
	const liteScores = scored.map((s) =>
		scoreSample(s.reference, s.irLite, s.fullTokens, s.liteTokens),
	);
	const lite = summarize(liteScores);
	const flashScores = scored
		.filter((s) => s.irFlash !== null && s.flashTokens !== null)
		.map((s) =>
			scoreSample(
				s.reference,
				s.irFlash as string,
				s.fullTokens,
				s.flashTokens as number,
			),
		);
	const flash = summarize(flashScores);
	const classAgg = new Map<string, { total: number; missing: number }>();
	for (const s of scored) {
		if (s.error !== null) {
			continue;
		}
		for (const c of recallByClass(
			extractEntities(s.reference),
			missingFor(s),
		)) {
			const agg = classAgg.get(c.class) ?? { total: 0, missing: 0 };
			agg.total += c.total;
			agg.missing += c.missing;
			classAgg.set(c.class, agg);
		}
	}
	const byClass = [...classAgg.entries()]
		.map(([cls, a]) => ({
			class: cls,
			total: a.total,
			missing: a.missing,
			recall: a.total === 0 ? null : (a.total - a.missing) / a.total,
		}))
		.sort((a, b) => (a.class < b.class ? -1 : 1));
	const ranked = scored
		.filter((s) => s.error === null)
		.map((s) => ({ idx: s.idx, r: s.recallLite ?? 1 }))
		.sort((a, b) => a.r - b.r);
	const spread = [0.1, 0.3, 0.5, 0.7, 0.9]
		.map((f) => ranked[Math.floor(f * ranked.length)]?.idx)
		.filter((v): v is number => v !== undefined);
	const empties = scored
		.filter((s) => s.error === null && s.irLite.trim().length === 0)
		.map((s) => s.idx)
		.slice(0, 5);
	const failures = [
		...new Set([
			...ranked.slice(0, 10).map((x) => x.idx),
			...empties,
			...spread,
		]),
	];
	const outDir = join(root, 'data', 'derived');
	mkdirSync(outDir, { recursive: true });
	// (ir-pilot.jsonl rows were appended incrementally above; crash-safe.)
	const summary = {
		generatedAt: new Date().toISOString(),
		prompt: 'prompts/ir-emit-v0.md',
		models: { lite: LITE_MODEL, flagship: FLAGSHIP_MODEL },
		n: scored.length,
		errors,
		flagshipErrors: scored.filter((s) => s.flagshipError !== null).length,
		lite,
		flash,
		recallByClass: byClass,
		spotCheckIdx: failures,
	};
	writeFileSync(
		join(outDir, 'ir-pilot-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} flagshipErrors=${summary.flagshipErrors}`,
	);
	console.log(
		`lite: p50=${lite.p50Ratio.toFixed(2)} mean=${lite.meanRatio.toFixed(2)} recall=${fmt(lite.meanRecall)}`,
	);
	console.log(
		`flash(n=${flash.n}): p50=${flash.p50Ratio.toFixed(2)} mean=${flash.meanRatio.toFixed(2)} recall=${fmt(flash.meanRecall)}`,
	);
	console.log(`spot-check idx: ${failures.join(',')}`);

	function missingFor(s: ScoredSample): string[] {
		return scoreSample(s.reference, s.irLite, s.fullTokens, s.liteTokens)
			.missing;
	}
}

function fmt(n: number | null): string {
	return n === null ? 'n/a' : n.toFixed(3);
}

async function runSample(
	client: GeminiClient,
	promptTemplate: string,
	sample: Sample,
	withFlagship: boolean,
	pacers: { lite: Pacer; flagship: Pacer },
): Promise<ScoredSample> {
	const prompt = `${promptTemplate}\n---\nCUSTOMER MESSAGE:\n${sample.instruction}\n\nIR:\n`;
	const full = await withRetry('countTokens', pacers.lite, () =>
		client.countTokens(LITE_MODEL, sample.reference),
	);
	if (!full.ok) {
		return empty(sample, full.error);
	}
	const lite = await withRetry('lite-generate', pacers.lite, () =>
		client.generate(LITE_MODEL, prompt, {
			temperature: TEMPERATURE,
			maxOutputTokens: MAX_IR_TOKENS,
		}),
	);
	if (!lite.ok) {
		return empty(sample, lite.error);
	}
	let irFlash: string | null = null;
	let flashTokens: number | null = null;
	let flagshipError: string | null = null;
	if (withFlagship) {
		const flash = await withRetry('flagship-generate', pacers.flagship, () =>
			client.generate(FLAGSHIP_MODEL, prompt, {
				temperature: TEMPERATURE,
				maxOutputTokens: MAX_IR_TOKENS,
			}),
		);
		if (!flash.ok) {
			flagshipError = flash.error;
		} else {
			irFlash = flash.value.text;
			flashTokens = flash.value.usage?.candidatesTokens ?? null;
			if (flashTokens === null) {
				const counted = await withRetry('flagship-count', pacers.flagship, () =>
					client.countTokens(FLAGSHIP_MODEL, irFlash as string),
				);
				if (!counted.ok) {
					flagshipError = counted.error;
					irFlash = null;
				} else {
					flashTokens = counted.value.totalTokens;
				}
			}
		}
	}
	const liteTokens = lite.value.usage?.candidatesTokens ?? null;
	if (liteTokens === null) {
		const counted = await withRetry('lite-count', pacers.lite, () =>
			client.countTokens(LITE_MODEL, lite.value.text),
		);
		if (!counted.ok) {
			return empty(sample, counted.error);
		}
		return done(
			sample,
			full.value.totalTokens,
			lite.value.text,
			counted.value.totalTokens,
			irFlash,
			flashTokens,
			flagshipError,
		);
	}
	return done(
		sample,
		full.value.totalTokens,
		lite.value.text,
		liteTokens,
		irFlash,
		flashTokens,
		flagshipError,
	);
}

function empty(sample: Sample, error: string): ScoredSample {
	return {
		idx: sample.idx,
		instruction: sample.instruction,
		reference: sample.reference,
		irLite: '',
		liteTokens: 0,
		fullTokens: 0,
		ratioLite: 0,
		recallLite: null,
		missingLite: [],
		irFlash: null,
		flashTokens: null,
		flagshipError: null,
		error,
	};
}

function done(
	sample: Sample,
	fullTokens: number,
	irLite: string,
	liteTokens: number,
	irFlash: string | null,
	flashTokens: number | null,
	flagshipError: string | null,
): ScoredSample {
	const s = scoreSample(sample.reference, irLite, fullTokens, liteTokens);
	return {
		idx: sample.idx,
		instruction: sample.instruction,
		reference: sample.reference,
		irLite,
		liteTokens,
		fullTokens,
		ratioLite: s.ratio,
		recallLite: s.recall,
		missingLite: s.missing,
		irFlash,
		flashTokens,
		flagshipError,
		error: null,
	};
}

await main();
