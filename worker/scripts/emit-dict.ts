// Dict-coded IR emission pilot (10x drive): the same v2 compress
// references, re-emitted by Groq qwen3.8-27b (reasoning none) under the v3
// dict-aware prompt with the ir-v0 codebook injected. Honest split: shapes
// verified on rows[:100], TESTED on rows[100:200].
// Ratio uses REAL Groq completion tokens vs v2 fullTokens (Gemini
// countTokens, same references). Recall via scoreGroundedSample on DECODED
// text (falls back to coded when decode fails, flagged). Compliance
// diagnostics (code-use rate, unknown codes, decode fails) ride along.
// Budget: 100 rows x ~1.4k prompt tokens ≈ 140k < 200k/day free tier.
// --provider groq|gemini|openrouter|cerebras selects the emitter.
// openrouter needs --model <id> (:free only) and OPENROUTER_API_KEY in
// env; cerebras takes --model (default gpt-oss-120b) and --effort
// none|low|medium|high (default low; qwen takes none, gpt-oss rejects
// it). Resume chains providers (walled run continues, zero lost rows).
// --rows <name> selects the rows file (default emit-dict.jsonl); the
// summary mirrors it. Separate files keep emitters unmixed.
// --dict <name> (default dict-ir-v0) and --prompt <file> (default
// ir-emit-v3.md) select the book and prompt; the summary records both.
// --wire :|bare|v3x selects book rendering (default :); v3x is the compact
// cache-optimized form (no means-wrappers). v3 dicts default to v3 rendering.
// --slot-budget N enables slot-budget violation measurement (reported as
// budgetFails; never repaired — single-call invariant: one flagship call
// per row, the emit itself).
// Deterministic autofix runs on every row regardless of flags: lines
// decode would reject are rewritten without a model call.
// --dict dict-ir-v3 selects the v3 stream wire (book and wire travel
// together; the codebook usage line, parser, and checks switch with it).
// --keys k1,k2 restricts to those held-out keys (targeted regression probes).
// --samples <file> reads a different sample file (default ir-pilot-v2.jsonl
// rows[100:200]); custom files run whole (fresh-key evals).
// Run from worker/: node --experimental-strip-types scripts/emit-dict.ts [limit] [--force] [--resume] [--provider gemini]
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CEREBRAS_API_KEY_NAME,
	CEREBRAS_BASE_URL,
	GEMINI_API_KEY_NAME,
	GROQ_API_KEY_NAME,
	GROQ_BASE_URL,
	OPENROUTER_API_KEY_NAME,
	OPENROUTER_BASE_URL,
} from '../src/config.ts';
import {
	type Dictionary,
	dictFromJson,
	dictToPrompt,
	findEntry,
} from '../src/dict.ts';
import { extractEntities } from '../src/entities.ts';
import {
	classifyLine,
	parseCodeLine,
	prepareExpansion,
	slotViolations,
	stripHarmony,
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
import { buildEmitPrompt } from '../src/prompt.ts';
import { autofixIr, codeViolations } from '../src/repair.ts';
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
import {
	autofixV3,
	codeViolationsV3,
	decodeV3,
	encodeV3,
	parseV3,
	slotViolationsV3,
} from '../src/wirev3.ts';

const MODEL = 'qwen/qwen3.8-27b';
/** Gemini fallback emitter (v2's lite id); smoke-gated, re-probe on 404. */
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0;
const MAX_IR_TOKENS = 256;
const GROQ_EXTRA_BODY = { reasoning_effort: 'none' };
/** Probed live: disables thinking on OpenRouter free models (ling rtokens 16 -> 0). */
const OPENROUTER_EXTRA_BODY = { reasoning: { effort: 'none' } };
/** Cerebras reasoning floor is per-model (probed live): gpt-oss rejects
 * none (400, low minimum), qwen-3.8-27b takes none (0 thinking tokens).
 * --effort selects it (default low preserves gpt-oss behavior). */
const GROQ_MIN_INTERVAL_MS = 5000;
const CONCURRENCY = 4;
const MAX_ERROR_RATE = 0.1;
const PUNT_TEXT = 'insufficient grounding';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Sample {
	key: string;
	reference: string;
	fullTokens: number;
}

/** Minimal structural surface both clients satisfy (method bivariance). */
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

interface EmitRow {
	key: string;
	provider: string;
	irCoded: string;
	irFirst: string;
	irDecoded: string | null;
	decodeError: string | null;
	recallOn: 'decoded' | 'coded';
	codeLines: number;
	totalLines: number;
	unknownCodes: string[];
	liteTokens: number | null;
	billedTokens: number | null;
	fullTokens: number;
	ratio: number;
	recall: number | null;
	missing: string[];
	classTotals: Record<string, number>;
	punt: boolean;
	rtokens: number | null;
	repaired: boolean;
	repairAttempts: number;
	coverageRepair: boolean;
	fixedLines: number;
	budgetFails: number;
	arityFails: number;
	wallMs: number;
	error: string | null;
}

function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Fail-loud codebook load: every slot must appear in its template, in order. */
function loadDict(root: string, name: string): Dictionary {
	const dict = dictFromJson(
		JSON.parse(
			readFileSync(join(root, 'data', 'derived', `${name}.json`), 'utf8'),
		),
	);
	for (const e of dict.entries) {
		let pos = 0;
		for (const s of e.slots) {
			const at = e.template.indexOf(`{${s}}`, pos);
			if (at < 0) {
				throw new Error(`${name}: slot {${s}} missing/misordered in ${e.code}`);
			}
			pos = at + 1;
		}
	}
	return dict;
}

function flagValue(flag: string, def: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

async function withRetry(
	label: string,
	pacer: Pacer,
	trip: BackpressureTrip,
	client: GenClient,
	model: string,
	prompt: string,
	extra: Record<string, unknown> | undefined,
): Promise<
	| {
			ok: true;
			text: string;
			finish: string;
			rtokens: number | null;
			tokens: number | null;
	  }
	| { ok: false; error: string }
> {
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
			return {
				ok: true,
				text: r.text,
				finish: r.finishReason ?? '',
				rtokens: r.usage?.reasoningTokens ?? null,
				tokens: r.usage?.candidatesTokens ?? null,
			};
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

async function runSample(
	client: GenClient,
	pacer: Pacer,
	trip: BackpressureTrip,
	model: string,
	provider: string,
	extra: Record<string, unknown> | undefined,
	prompt: string,
	sample: Sample,
	dict: Dictionary,
	budget: number,
	markers: Record<string, string>,
): Promise<EmitRow> {
	const started = performance.now();
	const fail = (error: string): EmitRow => ({
		key: sample.key,
		provider,
		irCoded: '',
		irFirst: '',
		irDecoded: null,
		decodeError: null,
		recallOn: 'coded',
		codeLines: 0,
		totalLines: 0,
		unknownCodes: [],
		liteTokens: null,
		billedTokens: null,
		fullTokens: sample.fullTokens,
		ratio: 0,
		recall: null,
		missing: [],
		classTotals: {},
		punt: false,
		rtokens: null,
		repaired: false,
		repairAttempts: 0,
		coverageRepair: false,
		fixedLines: 0,
		budgetFails: 0,
		arityFails: 0,
		wallMs: Math.round(performance.now() - started),
		error,
	});
	// gpt-oss (cerebras) wraps output in Harmony channels; strip them so
	// only the final channel reaches the IR parser.
	const clean = (t: string): string =>
		provider === 'cerebras'
			? stripHarmony(stripThinkBlocks(t))
			: stripThinkBlocks(t);
	const gen = await withRetry(
		'emit',
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
	const irFirst = clean(gen.text);
	let irCoded = irFirst;
	const isV3 = dict.version === 'ir-v3';
	const v3codes = new Set(dict.entries.map((e) => e.code));
	// v3 shares the loop shape; only the wire primitives differ.
	const autoFix = (text: string): { ir: string; fixedLines: number } => {
		if (!isV3) {
			return autofixIr(text, dict);
		}
		const f = autofixV3(parseV3(text, dict, markers), dict, markers);
		return {
			ir: encodeV3(f.segments, v3codes),
			fixedLines: f.fixedSegments,
		};
	};
	const probeDecode = (
		text: string,
	): { decoded: string | null; error: string | null } => {
		if (!isV3) {
			const probe = prepareExpansion(text, {
				dict,
				dictVersion: dict.version,
				store: probeStore,
				kbVersion: 'eval-empty',
			});
			if (!probe.ok) {
				return { decoded: null, error: probe.error.message.slice(0, 160) };
			}
			// v2 decode accepts empties (prod contract); pilots fail them loud.
			if (probe.value.expandedIr.trim() === '') {
				return { decoded: null, error: 'empty IR: nothing to expand' };
			}
			return { decoded: probe.value.expandedIr, error: null };
		}
		const r = decodeV3(parseV3(text, dict, markers), dict);
		return r.ok
			? { decoded: r.text, error: null }
			: { decoded: null, error: r.error.slice(0, 160) };
	};
	const codeV = (text: string) =>
		isV3
			? codeViolationsV3(parseV3(text, dict, markers), dict)
			: codeViolations(text, dict);
	const slotV = (text: string) =>
		isV3
			? slotViolationsV3(parseV3(text, dict, markers), budget)
			: slotViolations(text, budget);
	const shipTokens: number | null = gen.tokens;
	const shipRtokens: number | null = gen.rtokens;
	const billedTokens = (gen.tokens ?? 0) + (gen.rtokens ?? 0);
	let fixedLines = 0;
	// Deterministic pass (run 035+): free line-level repair, always on —
	// decode-side robustness like the lenient wire parser. Only lines
	// decode would reject are rewritten; budget overruns are left alone.
	const auto = autoFix(irCoded);
	irCoded = auto.ir;
	fixedLines += auto.fixedLines;
	const probeStore: SpanStore = {
		version: 'eval-empty',
		documents: new Map(),
	};
	// Single-call invariant (run 046): exactly one flagship call per row —
	// the emit above. No codeless/structural/coverage/polish LLM repair;
	// deterministic autofix already ran. Decode failures ship loud below
	// (decodeFails), never silently.
	const budgetFails = budget > 0 ? slotV(irCoded).length : 0;
	const arityFails = codeV(irCoded).filter((v) => v.kind === 'arity').length;
	const punt = irCoded.trim().toLowerCase() === PUNT_TEXT;
	const unknownCodes: string[] = [];
	let codeLines = 0;
	let totalLines = 0;
	if (isV3) {
		const segs = parseV3(irCoded, dict, markers);
		totalLines = segs.length;
		for (const s of segs) {
			if (s.kind !== 'code') {
				continue;
			}
			codeLines++;
			if (findEntry(dict, s.code) === undefined) {
				unknownCodes.push(s.code);
			}
		}
	} else {
		const lines = irCoded.split('\n').filter((l) => l.trim().length > 0);
		totalLines = lines.length;
		for (const line of lines) {
			if (classifyLine(line) !== 'code') {
				continue;
			}
			codeLines++;
			const use = parseCodeLine(line);
			if (use === undefined || findEntry(dict, use.code) === undefined) {
				unknownCodes.push(line.slice(0, 60));
			}
		}
	}
	const final = punt ? null : probeDecode(irCoded);
	const irDecoded = final?.decoded ?? null;
	const decodeError = final?.error ?? null;
	const recallOn = irDecoded !== null ? 'decoded' : 'coded';
	// Owner contract 2026-11-12: thinking tokens count. Ratio uses the
	// SHIPPED call's tokens; billedTokens sums EVERY call (each repair costs).
	const shippedTokens = (shipTokens ?? 0) + (shipRtokens ?? 0);
	const s = punt
		? null
		: scoreGroundedSample(
				sample.reference,
				irDecoded ?? irCoded,
				sample.reference,
				sample.fullTokens,
				shippedTokens,
			);
	const classTotals: Record<string, number> = {};
	if (s !== null) {
		for (const c of recallByClass(
			extractEntities(sample.reference),
			s.missing,
			undefined,
		)) {
			classTotals[c.class] = c.total;
		}
	}
	return {
		key: sample.key,
		provider,
		irCoded,
		irFirst,
		irDecoded,
		decodeError,
		recallOn,
		codeLines,
		totalLines,
		unknownCodes,
		liteTokens: shippedTokens,
		billedTokens,
		fullTokens: sample.fullTokens,
		ratio: s?.ratio ?? 0,
		recall: s?.recall ?? null,
		missing: s?.missing ?? [],
		classTotals,
		punt,
		rtokens: gen.rtokens,
		repaired: false,
		repairAttempts: 0,
		coverageRepair: false,
		fixedLines,
		budgetFails,
		arityFails,
		wallMs: Math.round(performance.now() - started),
		error: null,
	};
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const dictName = flagValue('--dict', 'dict-ir-v0');
	const promptName = flagValue('--prompt', 'ir-emit-v3.md');
	const wireFlag = flagValue('--wire', ':');
	if (wireFlag !== ':' && wireFlag !== 'bare' && wireFlag !== 'v3x') {
		throw new Error(`--wire must be :, bare, or v3x, got ${wireFlag}`);
	}
	const wire = wireFlag as ':' | 'bare' | 'v3x';
	const slotBudget = Number(flagValue('--slot-budget', '0')) || 0;
	if (process.argv.includes('--polish')) {
		throw new Error(
			'--polish removed: single-call invariant allows no LLM repair passes',
		);
	}
	const dict = loadDict(root, dictName);
	console.log(`dict: ${dict.version} entries=${dict.entries.length}`);
	const base = readFileSync(join(here, '..', 'prompts', promptName), 'utf8');
	if (!base.includes('[[CODEBOOK]]')) {
		throw new Error(`${promptName} lacks [[CODEBOOK]] slot`);
	}
	const bookWire =
		wire === 'v3x' ? 'v3x' : dict.version === 'ir-v3' ? 'v3' : wire;
	const promptHead = base.replace(
		'[[CODEBOOK]]',
		dictToPrompt(dict, { wire: bookWire }),
	);
	const markers: Record<string, string> =
		dict.version === 'ir-v3'
			? (
					JSON.parse(
						readFileSync(
							join(root, 'data', 'derived', 'marker-v3.json'),
							'utf8',
						),
					) as { aliases: Record<string, string> }
				).aliases
			: {};
	const samplesName = flagValue('--samples', 'ir-pilot-v2.jsonl');
	if (samplesName.includes('/') || samplesName.includes('\\')) {
		throw new Error('--samples must be a bare file name');
	}
	const all = readFileSync(join(root, 'data', 'derived', samplesName), 'utf8')
		.trim()
		.split('\n')
		.map(
			(l) =>
				JSON.parse(l) as {
					arm: string;
					key: string;
					reference: string;
					fullTokens: number;
				},
		)
		.filter((r) => r.arm === 'compress');
	// Held-out half: codebook shapes were verified on rows[:100].
	// Custom sample files (run 051: ir-pilot-v3 fresh keys) run whole.
	const heldOut =
		samplesName === 'ir-pilot-v2.jsonl' ? all.slice(100, 200) : all;
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	const keysFlag = process.argv.indexOf('--keys');
	const keyFilter =
		keysFlag >= 0
			? new Set(
					(process.argv[keysFlag + 1] ?? '')
						.split(',')
						.map((k) => k.trim())
						.filter((k) => k.length > 0),
				)
			: null;
	const samples: Sample[] = heldOut
		.filter((r) => keyFilter === null || keyFilter.has(r.key))
		.slice(0, limit ?? heldOut.length)
		.map((r) => ({
			key: r.key,
			reference: r.reference,
			fullTokens: r.fullTokens,
		}));
	if (keyFilter !== null && samples.length === 0) {
		throw new Error('--keys matched none of rows[100:200]');
	}
	const resume = process.argv.includes('--resume');
	const rowsName = flagValue('--rows', 'emit-dict.jsonl');
	if (rowsName.includes('/') || rowsName.includes('\\')) {
		throw new Error('--rows must be a bare file name');
	}
	const jsonlPath = join(root, 'data', 'derived', rowsName);
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
	const providerFlag = process.argv.indexOf('--provider');
	const provider =
		providerFlag >= 0 ? (process.argv[providerFlag + 1] ?? 'groq') : 'groq';
	if (
		provider !== 'groq' &&
		provider !== 'gemini' &&
		provider !== 'openrouter' &&
		provider !== 'cerebras'
	) {
		throw new Error(
			'--provider must be groq, gemini, openrouter, or cerebras, ' +
				`got ${provider}`,
		);
	}
	const model =
		provider === 'gemini'
			? GEMINI_MODEL
			: provider === 'openrouter'
				? flagValue('--model', '')
				: provider === 'cerebras'
					? flagValue('--model', 'gpt-oss-120b')
					: MODEL;
	if (provider === 'openrouter' && model.length === 0) {
		throw new Error('--provider openrouter needs --model <id> (:free only)');
	}
	const effort = flagValue('--effort', 'low');
	if (!['none', 'low', 'medium', 'high'].includes(effort)) {
		throw new Error(`--effort must be none|low|medium|high, got ${effort}`);
	}
	const extra =
		provider === 'groq'
			? GROQ_EXTRA_BODY
			: provider === 'openrouter'
				? OPENROUTER_EXTRA_BODY
				: provider === 'cerebras'
					? { reasoning_effort: effort }
					: undefined;
	const resolved = resolveSecret({
		name:
			provider === 'gemini'
				? GEMINI_API_KEY_NAME
				: provider === 'openrouter'
					? OPENROUTER_API_KEY_NAME
					: provider === 'cerebras'
						? CEREBRAS_API_KEY_NAME
						: GROQ_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolved.resolution)} present=true`);
	console.log(`provider: ${provider} model: ${model}`);
	console.log(`jobs: ${samples.length} (${samplesName})`);
	const client: GenClient =
		provider === 'gemini'
			? new GeminiClient({ apiKey: resolved.value })
			: new OpenAIChatClient({
					apiKey: resolved.value,
					baseUrl:
						provider === 'openrouter'
							? OPENROUTER_BASE_URL
							: provider === 'cerebras'
								? CEREBRAS_BASE_URL
								: GROQ_BASE_URL,
					timeoutMs: 120_000,
				});
	const pacer = new Pacer(GROQ_MIN_INTERVAL_MS);
	const trip = new BackpressureTrip();
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	const done = new Set(
		resume
			? readFileSync(jsonlPath, 'utf8')
					.trim()
					.split('\n')
					.filter((l) => l.length > 0)
					.map((l) => (JSON.parse(l) as EmitRow).key)
			: [],
	);
	const pending = samples.filter((s) => !done.has(s.key));
	const scored: EmitRow[] = [];
	let cursor = 0;
	let errors = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= pending.length) {
				return;
			}
			const sample = pending[my];
			if (sample === undefined) {
				return;
			}
			const prompt = buildEmitPrompt(promptHead, sample.reference);
			const row = await runSample(
				client,
				pacer,
				trip,
				model,
				provider,
				extra,
				prompt,
				sample,
				dict,
				slotBudget,
				markers,
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
	const prior: EmitRow[] = resume
		? readFileSync(jsonlPath, 'utf8')
				.trim()
				.split('\n')
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as EmitRow)
				.filter((r) => done.has(r.key))
		: [];
	const clean = [...prior, ...scored].filter(
		(r) => r.error === null && !r.punt,
	);
	const ratios = clean.map((r) => r.ratio).sort((a, b) => a - b);
	// Null recall = no measurable entities (same as v2's recallN); never average as zero.
	const recalls = clean.map((r) => r.recall).filter((x) => x !== null);
	const summary = {
		generatedAt: new Date().toISOString(),
		model,
		providers: [...new Set([...prior, ...scored].map((r) => r.provider))],
		prompt: `prompts/${promptName}`,
		dict: dict.version,
		wire,
		rows: rowsName,
		n: clean.length,
		errors,
		punts: [...prior, ...scored].filter((r) => r.punt).length,
		decodeFails: clean.filter((r) => r.decodeError !== null).length,
		repairedRows: clean.filter((r) => r.repaired).length,
		budgetFailRows: clean.filter((r) => r.budgetFails > 0).length,
		arityFailRows: clean.filter((r) => r.arityFails > 0).length,
		autoFixedRows: clean.filter((r) => r.fixedLines > 0).length,
		keyFilter: keyFilter === null ? null : [...keyFilter],
		ratioP50: ratios.length > 0 ? percentile(ratios, 0.5) : 0,
		ratioMean:
			ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
		recallMean:
			recalls.length > 0
				? recalls.reduce((a, b) => a + b, 0) / recalls.length
				: 0,
		recallN: recalls.length,
		codeUseRate:
			clean.reduce((a, r) => a + r.codeLines, 0) /
			Math.max(
				1,
				clean.reduce((a, r) => a + r.totalLines, 0),
			),
		unknownCodeLines: clean.reduce((a, r) => a + r.unknownCodes.length, 0),
		maxRtok: Math.max(0, ...clean.map((r) => r.rtokens ?? 0)),
	};
	writeFileSync(
		join(
			root,
			'data',
			'derived',
			`${rowsName.replace(/\.jsonl$/, '')}-summary.json`,
		),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(
		`n=${summary.n} errors=${errors} ratioP50=${summary.ratioP50.toFixed(2)} ratioMean=${summary.ratioMean.toFixed(2)} recall=${summary.recallMean.toFixed(3)}(N=${summary.recallN}) codeUse=${summary.codeUseRate.toFixed(2)} decodeFails=${summary.decodeFails} repaired=${summary.repairedRows} budgetFail=${summary.budgetFailRows} arityFail=${summary.arityFailRows} fixed=${summary.autoFixedRows}`,
	);
}

await main();
