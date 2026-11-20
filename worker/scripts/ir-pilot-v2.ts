// Model-emitted IR pilot v2 (PLAN.md Step 5 precondition).
// v1 flaw (recorded, do not repeat): the model answered from the question
// alone, so "recall vs reference" measured answer overlap, not compression
// fidelity, and "ratio" measured terse-answering, not compression. v1 files
// (ir-pilot.ts, ir-pilot.jsonl) are frozen as the invalid-design record.
// v2 measures two grounded tasks:
//   compress: Bitext reference reply -> IR (pure compression; prompt v1).
//   grounded: MultiDoc2Dial history + referenced doc spans -> IR (joint
//     answer+compress, the production analog; grounded prompt v1).
// Scoring is grounded-recall: only reference entities also present in the
// grounding count (for compress, grounding == reference). Rows store the
// reference but NOT the grounding (large); grounding is reproducible from
// the corpus via the row key (see assembleGrounded). Values never logged.
// Run from worker/: node --experimental-strip-types scripts/ir-pilot-v2.ts [limit] [--skip-flagship]
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { extractEntities } from '../src/entities.ts';
import { GeminiClient } from '../src/gemini.ts';
import {
	recallByClass,
	type SampleScore,
	scoreGroundedSample,
	summarize,
} from '../src/ireval.ts';
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
/** Chosen sample sizes (flagship costs more; overlap split per arm). */
const COMPRESS_N = 200;
const GROUNDED_N = 100;
/** Calibration subset per arm (25 + 25 = v1's 50 total). Chosen. */
const OVERLAP_PER_ARM = 25;
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
/** Model's licensed abstention (grounded arm rule 3). Punts are counted, not scored. */
const PUNT_TEXT = 'insufficient grounding';

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

type Arm = 'compress' | 'grounded';

interface Sample {
	arm: Arm;
	key: string;
	promptInput: string;
	reference: string;
	grounding: string;
	groundingMeta: { docIds: string[]; historyTurns: number; words: number };
}

interface ScoredRow {
	arm: Arm;
	key: string;
	reference: string;
	groundingMeta: Sample['groundingMeta'];
	irLite: string;
	liteTokens: number;
	fullTokens: number;
	ratioLite: number;
	recallLite: number | null;
	missingLite: string[];
	classTotals: Record<string, number>;
	puntLite: boolean;
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

function isPunt(ir: string): boolean {
	return ir.trim().toLowerCase() === PUNT_TEXT;
}

interface Turn {
	role: string;
	utterance: string;
	references: Array<{ doc_id: string }>;
}

function loadCompressSamples(root: string, limit: number | null): Sample[] {
	const rows = parse(
		readFileSync(join(root, 'data', 'bitext', 'bitext-27k.csv'), 'utf8'),
		{ columns: true, skip_empty_lines: true },
	) as Array<Record<string, string>>;
	const n = limit ?? COMPRESS_N;
	return [...rows.keys()]
		.sort((a, b) => fnv1a(`bitext-${a}`) - fnv1a(`bitext-${b}`))
		.slice(0, n)
		.map((idx) => {
			const reference = rows[idx]?.response ?? '';
			return {
				arm: 'compress' as const,
				key: `bitext-${idx}`,
				promptInput: reference,
				reference,
				grounding: reference,
				groundingMeta: { docIds: [], historyTurns: 0, words: 0 },
			};
		});
}

function loadGroundedSamples(root: string, limit: number | null): Sample[] {
	const dialPath = join(
		root,
		'data',
		'multidoc2dial',
		'multidoc2dial',
		'multidoc2dial_dial_validation.json',
	);
	const docPath = join(
		root,
		'data',
		'multidoc2dial',
		'multidoc2dial',
		'multidoc2dial_doc.json',
	);
	const dialData = (
		JSON.parse(readFileSync(dialPath, 'utf8')) as {
			dial_data: Record<string, Array<{ dial_id: string; turns: Turn[] }>>;
		}
	).dial_data;
	const docData = (
		JSON.parse(readFileSync(docPath, 'utf8')) as {
			doc_data: Record<string, Record<string, { doc_text: string }>>;
		}
	).doc_data;
	const n = limit ?? GROUNDED_N;
	const out: Sample[] = [];
	for (const domain of Object.keys(dialData).sort()) {
		for (const dg of dialData[domain] ?? []) {
			const history: string[] = [];
			dg.turns.forEach((t, ti) => {
				if (t.role !== 'agent' || out.length >= n) {
					history.push(`${t.role}: ${t.utterance}`);
					return;
				}
				const question =
					[...dg.turns.slice(0, ti)].reverse().find((p) => p.role === 'user')
						?.utterance ?? '';
				if (question.trim().length === 0) {
					history.push(`${t.role}: ${t.utterance}`);
					return;
				}
				const docIds = [
					...new Set(t.references.map((r) => r.doc_id).filter((d) => d)),
				];
				const docs: string[] = [];
				for (const id of docIds) {
					const text = docData[domain]?.[id]?.doc_text;
					if (text !== undefined) {
						docs.push(`[${id}]\n${text}`);
					}
				}
				const grounding = `Conversation so far:\n${history.join('\n')}\n\nDocument excerpts:\n${docs.join('\n\n')}`;
				out.push({
					arm: 'grounded',
					key: `${domain}/${dg.dial_id}#${ti}`,
					promptInput: `GROUNDING:\n${grounding}\n\nCUSTOMER MESSAGE:\n${question}`,
					reference: t.utterance,
					grounding,
					groundingMeta: {
						docIds,
						historyTurns: history.length,
						words: grounding.split(/\s+/).length,
					},
				});
				history.push(`${t.role}: ${t.utterance}`);
			});
			if (out.length >= n) {
				break;
			}
		}
		if (out.length >= n) {
			break;
		}
	}
	return out;
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
	const compressPrompt = readFileSync(
		join(here, '..', 'prompts', 'ir-emit-v1.md'),
		'utf8',
	);
	const groundedPrompt = readFileSync(
		join(here, '..', 'prompts', 'ir-grounded-v1.md'),
		'utf8',
	);
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	const samples = [
		...loadCompressSamples(root, limit),
		...loadGroundedSamples(root, limit),
	];
	console.log(
		`arms: compress=${limit ?? COMPRESS_N} grounded=${limit ?? GROUNDED_N}`,
	);
	const client = new GeminiClient({ apiKey });
	const pacers = {
		lite: new Pacer(LITE_MIN_INTERVAL_MS),
		flagship: new Pacer(FLAGSHIP_MIN_INTERVAL_MS),
	};
	const jsonlPath = join(root, 'data', 'derived', 'ir-pilot-v2.jsonl');
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	writeFileSync(jsonlPath, '');
	const skipFlagship = process.argv.includes('--skip-flagship');
	console.log(
		`flagship arm: ${skipFlagship ? 'skipped' : `first ${OVERLAP_PER_ARM} per arm`}`,
	);
	const armSeen: Record<Arm, number> = { compress: 0, grounded: 0 };
	const scored: ScoredRow[] = new Array(samples.length);
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
			const seenInArm = armSeen[sample.arm];
			armSeen[sample.arm] += 1;
			scored[my] = await runSample(
				client,
				sample.arm === 'compress' ? compressPrompt : groundedPrompt,
				sample,
				seenInArm < OVERLAP_PER_ARM && !skipFlagship,
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
	const arms = summarizeArms(scored);
	const outDir = join(root, 'data', 'derived');
	const summary = {
		generatedAt: new Date().toISOString(),
		prompts: {
			compress: 'prompts/ir-emit-v1.md',
			grounded: 'prompts/ir-grounded-v1.md',
		},
		models: { lite: LITE_MODEL, flagship: FLAGSHIP_MODEL },
		n: scored.length,
		errors,
		flagshipErrors: scored.filter((s) => s.flagshipError !== null).length,
		arms,
	};
	writeFileSync(
		join(outDir, 'ir-pilot-v2-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} flagshipErrors=${summary.flagshipErrors}`,
	);
	for (const [name, a] of Object.entries(arms)) {
		console.log(
			`${name}(n=${a.n} punts=${a.punts}): lite p50=${a.lite.p50Ratio.toFixed(2)} mean=${a.lite.meanRatio.toFixed(2)} recall=${fmt(a.lite.meanRecall)} | flash(n=${a.flash.n}) recall=${fmt(a.flash.meanRecall)}`,
		);
		console.log(`  spot-check: ${a.spotCheck.join(' ')}`);
	}
}

interface ArmSummary {
	n: number;
	errors: number;
	punts: number;
	lite: ReturnType<typeof summarize>;
	flash: ReturnType<typeof summarize>;
	byClass: Array<{
		class: string;
		total: number;
		missing: number;
		recall: number | null;
	}>;
	spotCheck: string[];
}

function summarizeArms(scored: ScoredRow[]): Record<Arm, ArmSummary> {
	const out = {} as Record<Arm, ArmSummary>;
	for (const arm of ['compress', 'grounded'] as const) {
		const rows = scored.filter((s) => s.arm === arm);
		const ok = rows.filter((s) => s.error === null && !s.puntLite);
		const liteScores: SampleScore[] = ok.map((s) => ({
			fullTokens: s.fullTokens,
			irTokens: s.liteTokens,
			ratio: s.ratioLite,
			recall: s.recallLite,
			missing: s.missingLite,
			emptyIr: s.irLite.trim().length === 0,
		}));
		const flashScores: SampleScore[] = ok
			.filter((s) => s.irFlash !== null && s.flashTokens !== null)
			.map((s) => ({
				fullTokens: s.fullTokens,
				irTokens: s.flashTokens as number,
				ratio:
					(s.flashTokens as number) > 0
						? s.fullTokens / (s.flashTokens as number)
						: Number.POSITIVE_INFINITY,
				recall: null,
				missing: [],
				emptyIr: (s.irFlash as string).trim().length === 0,
			}));
		// Flash recall needs the grounding, which rows don't store; ratio only
		// here, recall recomputed offline from the corpus via row keys.
		const classAgg = new Map<string, { total: number; missing: number }>();
		for (const s of ok) {
			for (const c of byClassFor(s)) {
				const agg = classAgg.get(c.class) ?? { total: 0, missing: 0 };
				agg.total += c.total;
				agg.missing += c.missing;
				classAgg.set(c.class, agg);
			}
		}
		const ranked = ok
			.map((s) => ({ key: s.key, r: s.recallLite ?? 1 }))
			.sort((a, b) => a.r - b.r);
		const spread = [0.1, 0.3, 0.5, 0.7, 0.9]
			.map((f) => ranked[Math.floor(f * ranked.length)]?.key)
			.filter((v): v is string => v !== undefined);
		const bad = rows
			.filter(
				(s) => s.error === null && (s.puntLite || s.irLite.trim().length === 0),
			)
			.map((s) => s.key)
			.slice(0, 5);
		out[arm] = {
			n: rows.length,
			errors: rows.filter((s) => s.error !== null).length,
			punts: rows.filter((s) => s.puntLite).length,
			lite: summarize(liteScores),
			flash: summarize(flashScores),
			byClass: [...classAgg.entries()]
				.map(([cls, a]) => ({
					class: cls,
					total: a.total,
					missing: a.missing,
					recall: a.total === 0 ? null : (a.total - a.missing) / a.total,
				}))
				.sort((a, b) => (a.class < b.class ? -1 : 1)),
			spotCheck: [
				...new Set([
					...ranked.slice(0, 8).map((x) => x.key),
					...bad,
					...spread,
				]),
			],
		};
	}
	return out;
}

/** Per-class recall for one row, from stored measurable totals (computed at
 * score time where the grounding is available) plus missing keys. */
function byClassFor(
	s: ScoredRow,
): Array<{ class: string; total: number; missing: number }> {
	const missed = new Map<string, number>();
	for (const k of s.missingLite) {
		const cls = k.split(':')[0] ?? '';
		missed.set(cls, (missed.get(cls) ?? 0) + 1);
	}
	return Object.entries(s.classTotals).map(([cls, total]) => ({
		class: cls,
		total,
		missing: missed.get(cls) ?? 0,
	}));
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
): Promise<ScoredRow> {
	const prompt =
		sample.arm === 'compress'
			? `${promptTemplate}\n---\nREPLY TO COMPRESS:\n${sample.promptInput}\n\nIR:\n`
			: `${promptTemplate}\n---\n${sample.promptInput}\n\nIR:\n`;
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

function empty(sample: Sample, error: string): ScoredRow {
	return {
		arm: sample.arm,
		key: sample.key,
		reference: sample.reference,
		groundingMeta: sample.groundingMeta,
		irLite: '',
		liteTokens: 0,
		fullTokens: 0,
		ratioLite: 0,
		recallLite: null,
		missingLite: [],
		classTotals: {},
		puntLite: false,
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
): ScoredRow {
	const punt = isPunt(irLite);
	const s = punt
		? null
		: scoreGroundedSample(
				sample.reference,
				irLite,
				sample.grounding,
				fullTokens,
				liteTokens,
			);
	// Per-class measurable totals, computed where the grounding is available
	// (rows don't store grounding text; see header). Compress arm passes no
	// grounding, reducing to plain totals.
	const classTotals: Record<string, number> = {};
	if (s !== null) {
		for (const c of recallByClass(
			extractEntities(sample.reference),
			s.missing,
			sample.arm === 'grounded' ? extractEntities(sample.grounding) : undefined,
		)) {
			classTotals[c.class] = c.total;
		}
	}
	return {
		arm: sample.arm,
		key: sample.key,
		reference: sample.reference,
		groundingMeta: sample.groundingMeta,
		irLite,
		liteTokens,
		fullTokens,
		ratioLite: s?.ratio ?? 0,
		recallLite: s?.recall ?? null,
		missingLite: s?.missing ?? [],
		classTotals,
		puntLite: punt,
		irFlash,
		flashTokens,
		flagshipError,
		error: null,
	};
}

await main();
