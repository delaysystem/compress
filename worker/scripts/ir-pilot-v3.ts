// Model-emitted IR pilot v3: stratified grounded rerun (run 011 requirement).
// Lineage: v1 (ir-pilot.ts) measured ungrounded answering — invalid, frozen.
// v2 (ir-pilot-v2.ts) proved pure compression (recall 0.978) but left the
// grounded arm thin (n=15 measurable), dmv-only, and punt-mixed. v3
// re-measures ONLY the grounded arm, fixed: round-robin domains (25 each),
// answerable-only subset (preceding user message is a genuine question AND
// ≥1 measurable entity via the real groundedRecall denominator), execution
// interleaved so an early abort stays representative. Prompts frozen (v1);
// grounding format byte-identical to v2; v1/v2 files and outputs untouched.
// New outputs: data/derived/ir-pilot-v3.jsonl + ir-pilot-v3-summary.json.
// Run from worker/: node --experimental-strip-types scripts/ir-pilot-v3.ts [limit] [--skip-flagship] [--dry-run] [--force]
// --force is REQUIRED to overwrite a non-empty ir-pilot-v3.jsonl (a smoke
// once ate 100 full-run rows; refusing by default since run 014).
// --dry-run prints per-domain yields and exits before any API call (or key
// lookup). Fails fast when a domain cannot fill its quota (no silent
// shrink). Values never logged.
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { extractEntities } from '../src/entities.ts';
import { GeminiClient } from '../src/gemini.ts';
import {
	groundedRecall,
	recallByClass,
	type SampleScore,
	scoreGroundedSample,
	summarize,
} from '../src/ireval.ts';
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

/** Probed live 2026-11-11 (API redirect targets); re-probe on 404. */
const LITE_MODEL = 'gemini-3.5-flash-lite';
/** Probed live 2026-11-11; see above. */
const FLAGSHIP_MODEL = 'gemini-3.8-flash';
/** Chosen: 25 × 4 domains = 100, matching v2's grounded N with stratification. */
const PER_DOMAIN = 25;
/** Calibration subset from the round-robin head (stratified by construction). Chosen. */
const OVERLAP_N = 25;
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
/** Model's licensed abstention (grounded prompt rule 3). Counted, not scored. */
const PUNT_TEXT = 'insufficient grounding';
/** Answerable-only: question-form message floor. Chosen (kills "not", "No, I don't"). */
const MIN_QUESTION_WORDS = 4;

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

export interface Sample {
	key: string;
	promptInput: string;
	reference: string;
	grounding: string;
	groundingMeta: { docIds: string[]; historyTurns: number; words: number };
}

interface ScoredRow {
	arm: 'grounded';
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
	trip: BackpressureTrip,
	fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
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
			const value = await fn();
			trip.recordSuccess();
			return { ok: true, value };
		} catch (e) {
			if (!isRetryable(e)) {
				return { ok: false, error: `${label}: ${messageOf(e)}`.slice(0, 200) };
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

function isPunt(ir: string): boolean {
	return ir.trim().toLowerCase() === PUNT_TEXT;
}

interface Turn {
	role: string;
	utterance: string;
	references: Array<{ doc_id: string }>;
}

export interface DomainYield {
	domain: string;
	agentTurns: number;
	questionForm: number;
	measuring: number;
	selected: number;
}

/** Genuine-question test: interrogative form with substance. */
function isQuestion(text: string): boolean {
	const t = text.trim();
	return (
		t.endsWith('?') &&
		t.split(/\s+/).filter((w) => w.length > 0).length >= MIN_QUESTION_WORDS
	);
}

function loadDomain(
	domain: string,
	dialogues: Array<{ dial_id: string; turns: Turn[] }>,
	docData: Record<string, Record<string, { doc_text: string }>>,
): { samples: Sample[]; stats: Omit<DomainYield, 'domain' | 'selected'> } {
	const samples: Sample[] = [];
	let agentTurns = 0;
	let questionForm = 0;
	let measuring = 0;
	for (const dg of dialogues) {
		const history: string[] = [];
		for (let ti = 0; ti < dg.turns.length; ti++) {
			const t = dg.turns[ti] as Turn;
			if (t.role !== 'agent') {
				history.push(`${t.role}: ${t.utterance}`);
				continue;
			}
			agentTurns += 1;
			const question =
				[...dg.turns.slice(0, ti)].reverse().find((p) => p.role === 'user')
					?.utterance ?? '';
			history.push(`${t.role}: ${t.utterance}`);
			if (!isQuestion(question)) {
				continue;
			}
			questionForm += 1;
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
			// Byte-identical format to v2 (comparability).
			const grounding = `Conversation so far:\n${history.slice(0, -1).join('\n')}\n\nDocument excerpts:\n${docs.join('\n\n')}`;
			const g = groundedRecall(
				extractEntities(t.utterance),
				[],
				extractEntities(grounding),
			);
			if (g.measuring === 0) {
				continue;
			}
			measuring += 1;
			samples.push({
				key: `${domain}/${dg.dial_id}#${ti}`,
				promptInput: `GROUNDING:\n${grounding}\n\nCUSTOMER MESSAGE:\n${question}`,
				reference: t.utterance,
				grounding,
				groundingMeta: {
					docIds,
					historyTurns: history.length - 1,
					words: grounding.split(/\s+/).length,
				},
			});
		}
	}
	return { samples, stats: { agentTurns, questionForm, measuring } };
}

export function loadStratified(
	root: string,
	perDomain: number,
	limit: number | null,
): { samples: Sample[]; yields: DomainYield[] } {
	const base = join(root, 'data', 'multidoc2dial', 'multidoc2dial');
	const dialData = (
		JSON.parse(
			readFileSync(join(base, 'multidoc2dial_dial_validation.json'), 'utf8'),
		) as {
			dial_data: Record<string, Array<{ dial_id: string; turns: Turn[] }>>;
		}
	).dial_data;
	const docData = (
		JSON.parse(readFileSync(join(base, 'multidoc2dial_doc.json'), 'utf8')) as {
			doc_data: Record<string, Record<string, { doc_text: string }>>;
		}
	).doc_data;
	const yields: DomainYield[] = [];
	const perDomainSamples: Sample[][] = [];
	for (const domain of Object.keys(dialData).sort()) {
		const { samples, stats } = loadDomain(
			domain,
			dialData[domain] ?? [],
			docData,
		);
		if (samples.length < perDomain) {
			throw new Error(
				`domain ${domain} yields ${samples.length} measurable samples, need ${perDomain} (no silent shrink; adjust quota honestly)`,
			);
		}
		yields.push({ domain, ...stats, selected: perDomain });
		perDomainSamples.push(samples.slice(0, perDomain));
	}
	// Round-robin interleave: the execution head of any length stays stratified.
	const interleaved: Sample[] = [];
	for (let i = 0; i < perDomain; i++) {
		for (const bucket of perDomainSamples) {
			const s = bucket[i];
			if (s !== undefined) {
				interleaved.push(s);
			}
		}
	}
	return {
		samples: limit === null ? interleaved : interleaved.slice(0, limit),
		yields,
	};
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	const { samples, yields } = loadStratified(root, PER_DOMAIN, limit);
	for (const y of yields) {
		console.log(
			`yield ${y.domain}: agent=${y.agentTurns} questionForm=${y.questionForm} measuring=${y.measuring} selected=${y.selected}`,
		);
	}
	if (process.argv.includes('--dry-run')) {
		console.log(`dry-run: ${samples.length} samples, no API calls made`);
		return;
	}
	const jsonlPath = join(root, 'data', 'derived', 'ir-pilot-v3.jsonl');
	if (!process.argv.includes('--force')) {
		let existing = 0;
		try {
			existing = statSync(jsonlPath).size;
		} catch {
			existing = 0; // Missing file: nothing to protect.
		}
		if (existing > 0) {
			throw new Error(
				`refusing to overwrite ${jsonlPath} (${existing} bytes) without --force`,
			);
		}
	}
	const { value: apiKey, resolution } = resolveSecret({
		name: GEMINI_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolution)} present=true`);
	const promptTemplate = readFileSync(
		join(here, '..', 'prompts', 'ir-grounded-v1.md'),
		'utf8',
	);
	console.log(`samples: ${samples.length} (round-robin stratified)`);
	const client = new GeminiClient({ apiKey });
	const pacers = {
		lite: new Pacer(LITE_MIN_INTERVAL_MS),
		flagship: new Pacer(FLAGSHIP_MIN_INTERVAL_MS),
	};
	// One trip per model: a live model must not reset a dead model's trip.
	const trips = {
		lite: new BackpressureTrip(),
		flagship: new BackpressureTrip(),
	};
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	writeFileSync(jsonlPath, '');
	const skipFlagship = process.argv.includes('--skip-flagship');
	console.log(
		`flagship arm: ${skipFlagship ? 'skipped' : `first ${OVERLAP_N} samples`}`,
	);
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
			scored[my] = await runSample(
				client,
				promptTemplate,
				sample,
				my < OVERLAP_N && !skipFlagship,
				pacers,
				trips,
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
	const ok = scored.filter((s) => s.error === null && !s.puntLite);
	const liteScores: SampleScore[] = ok.map((s) => ({
		fullTokens: s.fullTokens,
		irTokens: s.liteTokens,
		ratio: s.ratioLite,
		recall: s.recallLite,
		missing: s.missingLite,
		emptyIr: s.irLite.trim().length === 0,
	}));
	const lite = summarize(liteScores);
	const flashRows = ok.filter(
		(s) => s.irFlash !== null && s.flashTokens !== null,
	);
	const flash = summarize(
		flashRows.map((s) => ({
			fullTokens: s.fullTokens,
			irTokens: s.flashTokens as number,
			ratio:
				(s.flashTokens as number) > 0
					? s.fullTokens / (s.flashTokens as number)
					: Number.POSITIVE_INFINITY,
			recall: null,
			missing: [],
			emptyIr: (s.irFlash as string).trim().length === 0,
		})),
	);
	// Flash recall needs grounding text (rows don't store it); ratio only
	// here, recall recomputed offline from the corpus via row keys if needed.
	const classAgg = new Map<string, { total: number; missing: number }>();
	for (const s of ok) {
		for (const [cls, total] of Object.entries(s.classTotals)) {
			const agg = classAgg.get(cls) ?? { total: 0, missing: 0 };
			agg.total += total;
			classAgg.set(cls, agg);
		}
		for (const k of s.missingLite) {
			const cls = k.split(':')[0] ?? '';
			const agg = classAgg.get(cls) ?? { total: 0, missing: 0 };
			agg.missing += 1;
			classAgg.set(cls, agg);
		}
	}
	const ranked = ok
		.map((s) => ({ key: s.key, r: s.recallLite ?? 1 }))
		.sort((a, b) => a.r - b.r);
	const spread = [0.1, 0.3, 0.5, 0.7, 0.9]
		.map((f) => ranked[Math.floor(f * ranked.length)]?.key)
		.filter((v): v is string => v !== undefined);
	const bad = scored
		.filter(
			(s) => s.error === null && (s.puntLite || s.irLite.trim().length === 0),
		)
		.map((s) => s.key)
		.slice(0, 8);
	const summary = {
		generatedAt: new Date().toISOString(),
		prompt: 'prompts/ir-grounded-v1.md',
		models: { lite: LITE_MODEL, flagship: FLAGSHIP_MODEL },
		n: scored.length,
		errors,
		flagshipErrors: scored.filter((s) => s.flagshipError !== null).length,
		punts: scored.filter((s) => s.puntLite).length,
		yields,
		lite,
		flash,
		recallByClass: [...classAgg.entries()]
			.map(([cls, a]) => ({
				class: cls,
				total: a.total,
				missing: a.missing,
				recall: a.total === 0 ? null : (a.total - a.missing) / a.total,
			}))
			.sort((a, b) => (a.class < b.class ? -1 : 1)),
		spotCheck: [
			...new Set([...ranked.slice(0, 10).map((x) => x.key), ...bad, ...spread]),
		],
	};
	writeFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v3-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} flagshipErrors=${summary.flagshipErrors} punts=${summary.punts}`,
	);
	console.log(
		`lite: p50=${lite.p50Ratio.toFixed(2)} recall=${fmt(lite.meanRecall)} recallN=${lite.recallN}`,
	);
	console.log(
		`flash(n=${flash.n}): p50=${flash.p50Ratio.toFixed(2)} recall=${fmt(flash.meanRecall)}`,
	);
	console.log(`spot-check: ${summary.spotCheck.join(' ')}`);
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
	trips: { lite: BackpressureTrip; flagship: BackpressureTrip },
): Promise<ScoredRow> {
	const prompt = `${promptTemplate}\n---\n${sample.promptInput}\n\nIR:\n`;
	const full = await withRetry('countTokens', pacers.lite, trips.lite, () =>
		client.countTokens(LITE_MODEL, sample.reference),
	);
	if (!full.ok) {
		return empty(sample, full.error);
	}
	const lite = await withRetry('lite-generate', pacers.lite, trips.lite, () =>
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
		const flash = await withRetry(
			'flagship-generate',
			pacers.flagship,
			trips.flagship,
			() =>
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
				const counted = await withRetry(
					'flagship-count',
					pacers.flagship,
					trips.flagship,
					() => client.countTokens(FLAGSHIP_MODEL, irFlash as string),
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
		const counted = await withRetry('lite-count', pacers.lite, trips.lite, () =>
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
		arm: 'grounded',
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
	const classTotals: Record<string, number> = {};
	if (s !== null) {
		for (const c of recallByClass(
			extractEntities(sample.reference),
			s.missing,
			extractEntities(sample.grounding),
		)) {
			classTotals[c.class] = c.total;
		}
	}
	return {
		arm: 'grounded',
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

if (import.meta.main) {
	await main();
}
