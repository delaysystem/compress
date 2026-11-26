// Request pipeline composition (pure over injected deps; runs in workerd AND node tests).
// Flow: parse+validate body -> pin versions -> load spans -> deterministic
// splice/decode -> Tier 1 deterministic fluent realizer (v3) -> Tier 2
// slot-parameterized expansion cache -> Tier 3 ladder (LLM + deterministic
// framing repair + optional SLM repair + template) -> optional wrap -> JSON/SSE.
// Single-call invariant: this path spends zero flagship calls (the one call
// is emit, upstream). No regen, no breaker, no budgets.
// Request values are never echoed into error messages.

import type { ExpansionCache } from './cache.ts';
import { NIM_API_KEY_NAME } from './config.ts';
import type { Dictionary } from './dict.ts';
import {
	classifyLine,
	type ExpanderClient,
	expand,
	prepareExpansion,
	renderTemplateFallback,
	stripFramingLeaks,
} from './expander.ts';
import {
	listSupportedLanguages,
	normalizeLang,
	type SupportedLang,
} from './i18n.ts';
import { type LadderResult, runLadder } from './ladder.ts';
import { NO_THINK_EXTRA_BODY } from './openai.ts';
import { tryFastRealize } from './realizer.ts';
import type { SpanStore } from './spanref.ts';
import { formatServerTiming, roundMs, type StageTimings } from './timing.ts';
import type { ValidatorVerdict } from './validator.ts';
import { autofixV3, decodeV3, parseV3, type V3Segment } from './wirev3.ts';

export interface AppDeps {
	dict: Dictionary;
	dicts?: Record<string, Dictionary>;
	markers?: Record<string, string>;
	cache?: ExpansionCache;
	llm: ExpanderClient | undefined;
	loadSpans: (kbVersion: string) => Promise<SpanLoad>;
}

export type SpanLoad =
	| { ok: true; store: SpanStore }
	| { ok: false; reason: 'not-configured' | 'unknown-version' | 'unavailable' };

export interface ParsedExpandBody {
	ir: string;
	dictVersion: string;
	kbVersion: string;
	slotValues: string[];
	model: string;
	greeting: string | undefined;
	signoff: string | undefined;
	repairAttempts: number | undefined;
	fastMode: boolean | undefined;
	lang: SupportedLang | undefined;
}

/** Conservative key-safe charset (no separators/control chars). Verified against KV at provisioning follow-up. */
const KB_VERSION_RE = /^[A-Za-z0-9._-]+$/;

export type ParseBodyResult =
	| { ok: true; value: ParsedExpandBody }
	| { ok: false; error: string };

export function parseExpandBody(body: unknown): ParseBodyResult {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { ok: false, error: 'body must be a JSON object' };
	}
	const r = body as Record<string, unknown>;
	const req = (field: string): string | undefined => {
		const v = r[field];
		return typeof v === 'string' && v.length > 0 ? v : undefined;
	};
	const ir = req('ir');
	if (ir === undefined) {
		return { ok: false, error: 'ir: required non-empty string' };
	}
	const dictVersion = req('dictVersion');
	if (dictVersion === undefined) {
		return { ok: false, error: 'dictVersion: required non-empty string' };
	}
	const kbVersion = req('kbVersion');
	if (kbVersion === undefined) {
		return { ok: false, error: 'kbVersion: required non-empty string' };
	}
	const model = req('model');
	if (model === undefined) {
		return { ok: false, error: 'model: required non-empty string' };
	}
	let slotValues: string[] = [];
	const rawSlots = r.slotValues;
	if (rawSlots !== undefined) {
		if (!Array.isArray(rawSlots)) {
			return { ok: false, error: 'slotValues: must be string[]' };
		}
		const checked: string[] = [];
		for (const s of rawSlots) {
			if (typeof s !== 'string') {
				return { ok: false, error: 'slotValues: must be string[]' };
			}
			checked.push(s);
		}
		slotValues = checked;
	}
	const greetRaw = r.greeting;
	if (greetRaw !== undefined && typeof greetRaw !== 'string') {
		return { ok: false, error: 'greeting: must be a string' };
	}
	const signRaw = r.signoff;
	if (signRaw !== undefined && typeof signRaw !== 'string') {
		return { ok: false, error: 'signoff: must be a string' };
	}
	const repairRaw = r.repairAttempts;
	if (
		repairRaw !== undefined &&
		(typeof repairRaw !== 'number' ||
			!Number.isInteger(repairRaw) ||
			repairRaw < 0 ||
			repairRaw > 5)
	) {
		return { ok: false, error: 'repairAttempts: must be an integer 0..5' };
	}
	const fastRaw = r.fastMode;
	if (fastRaw !== undefined && typeof fastRaw !== 'boolean') {
		return { ok: false, error: 'fastMode: must be a boolean' };
	}
	let lang: SupportedLang | undefined;
	const langRaw = r.lang;
	if (langRaw !== undefined) {
		if (typeof langRaw !== 'string') {
			return { ok: false, error: 'lang: must be a supported language code' };
		}
		lang = normalizeLang(langRaw);
		if (lang === undefined) {
			return { ok: false, error: 'lang: unsupported language' };
		}
	}
	return {
		ok: true,
		value: {
			ir,
			dictVersion,
			kbVersion,
			slotValues,
			model,
			greeting: greetRaw,
			signoff: signRaw,
			repairAttempts: repairRaw,
			fastMode: fastRaw,
			lang,
		},
	};
}

export interface ApiResponse {
	status: number;
	json: unknown;
	timings?: StageTimings;
}

function resolveDict(
	deps: AppDeps,
	dictVersion: string,
): Dictionary | undefined {
	if (dictVersion === deps.dict.version) {
		return deps.dict;
	}
	return deps.dicts?.[dictVersion];
}

function greetingOnlyRepair(
	lang: SupportedLang,
): (output: string, verdict: ValidatorVerdict) => string | null {
	return (output: string, verdict: ValidatorVerdict): string | null => {
		const failed = verdict.checks.filter((c) => !c.pass);
		if (failed.length === 1 && failed[0]?.name === 'no-greeting') {
			const fixed = stripFramingLeaks(output, lang);
			return fixed !== output ? fixed : null;
		}
		return null;
	};
}

export async function handleExpand(
	deps: AppDeps,
	body: unknown,
): Promise<ApiResponse> {
	const tTotal0 = performance.now();
	const tParse0 = performance.now();
	const parsed = parseExpandBody(body);
	const parseBodyMs = roundMs(performance.now() - tParse0);
	if (!parsed.ok) {
		return { status: 400, json: { error: parsed.error } };
	}
	const req = parsed.value;
	const dict = resolveDict(deps, req.dictVersion);
	if (dict === undefined) {
		return {
			status: 422,
			json: { error: `dict version mismatch: have ${deps.dict.version}` },
		};
	}
	if (!KB_VERSION_RE.test(req.kbVersion)) {
		return { status: 400, json: { error: 'kbVersion: invalid characters' } };
	}

	const isV3 = req.dictVersion.startsWith('ir-v3');
	let loadSpansMs = 0;
	let decodeIrMs = 0;
	let preparedIr = '';
	let v3Segments: V3Segment[] = [];

	if (isV3) {
		const tDec0 = performance.now();
		const markers = deps.markers ?? {};
		const rawSegs = parseV3(req.ir, dict, markers);
		const fixed = autofixV3(rawSegs, dict);
		v3Segments = fixed.segments;
		const decoded = decodeV3(v3Segments, dict);
		decodeIrMs = roundMs(performance.now() - tDec0);
		if (!decoded.ok) {
			return { status: 422, json: { error: decoded.error } };
		}
		preparedIr = decoded.text;
	} else {
		// Spanless requests skip the store entirely: no KV read on the common path.
		const needsSpans = req.ir
			.split('\n')
			.some((line) => classifyLine(line) === 'span');
		let store: SpanStore | undefined;
		if (needsSpans) {
			const tSpan0 = performance.now();
			let loaded: SpanLoad;
			try {
				loaded = await deps.loadSpans(req.kbVersion);
			} catch (e) {
				console.error(
					'span store read failed:',
					e instanceof Error ? e.message : String(e),
				);
				return { status: 502, json: { error: 'span store unavailable' } };
			}
			loadSpansMs = roundMs(performance.now() - tSpan0);
			if (!loaded.ok) {
				if (loaded.reason === 'not-configured') {
					return { status: 501, json: { error: 'span store not configured' } };
				}
				if (loaded.reason === 'unknown-version') {
					return { status: 422, json: { error: 'unknown kb version' } };
				}
				return { status: 502, json: { error: 'span store unavailable' } };
			}
			if (loaded.store.version !== req.kbVersion) {
				return { status: 422, json: { error: 'kb store version mismatch' } };
			}
			store = loaded.store;
		}
		const tDec0 = performance.now();
		const prepared = prepareExpansion(req.ir, {
			dict,
			dictVersion: req.dictVersion,
			store: store ?? {
				version: req.kbVersion,
				documents: new Map<string, Map<string, string>>(),
			},
			kbVersion: req.kbVersion,
		});
		decodeIrMs = roundMs(performance.now() - tDec0);
		if (!prepared.ok) {
			const status = prepared.error.kind === 'malformed' ? 400 : 422;
			return { status, json: { error: prepared.error.message } };
		}
		preparedIr = prepared.value.expandedIr;
	}

	const allowFast = req.fastMode !== false;
	const lang: SupportedLang = req.lang ?? 'en';

	// Tier 1: Sub-millisecond deterministic fluent realizer (v3 IR, 20 languages).
	let fastPathMs = 0;
	if (isV3 && allowFast) {
		const tFast0 = performance.now();
		const fast = tryFastRealize({
			segments: v3Segments,
			preparedIr,
			slotValues: req.slotValues,
			dict,
			lang,
		});
		fastPathMs = roundMs(performance.now() - tFast0);
		if (fast.ok) {
			const tWrap0 = performance.now();
			const text =
				req.greeting === undefined && req.signoff === undefined
					? fast.text
					: wrapWithCopy(fast.text, req.greeting, req.signoff);
			const wrapMs = roundMs(performance.now() - tWrap0);
			const timings: StageTimings = {
				parseBodyMs,
				loadSpansMs,
				decodeIrMs,
				fastPathMs,
				cacheMs: 0,
				buildPromptMs: 0,
				llmExpandMs: 0,
				postProcessMs: 0,
				validateMs: fastPathMs,
				repairMs: 0,
				wrapMs,
				totalMs: roundMs(performance.now() - tTotal0),
				tier: 'fast-realizer',
			};
			return {
				status: 200,
				timings,
				json: {
					ok: true,
					text,
					path: 'fast-realizer',
					lang,
					usage: null,
					versions: { dict: req.dictVersion, kb: req.kbVersion },
					verdicts: [fast.verdict],
					timings,
				},
			};
		}
	}

	// Tier 2: Slot-parameterized expansion cache (namespaced by language).
	let cacheMs = 0;
	if (deps.cache !== undefined && allowFast) {
		const tCache0 = performance.now();
		const hit = deps.cache.get(preparedIr, req.slotValues, lang);
		cacheMs = roundMs(performance.now() - tCache0);
		if (hit !== undefined) {
			const tWrap0 = performance.now();
			const text =
				req.greeting === undefined && req.signoff === undefined
					? hit.text
					: wrapWithCopy(hit.text, req.greeting, req.signoff);
			const wrapMs = roundMs(performance.now() - tWrap0);
			const timings: StageTimings = {
				parseBodyMs,
				loadSpansMs,
				decodeIrMs,
				fastPathMs,
				cacheMs,
				buildPromptMs: 0,
				llmExpandMs: 0,
				postProcessMs: 0,
				validateMs: cacheMs,
				repairMs: 0,
				wrapMs,
				totalMs: roundMs(performance.now() - tTotal0),
				tier: 'cache',
			};
			return {
				status: 200,
				timings,
				json: {
					ok: true,
					text,
					path: 'cached',
					lang,
					usage: null,
					versions: { dict: req.dictVersion, kb: req.kbVersion },
					verdicts: [hit.verdict],
					timings,
				},
			};
		}
	}

	// Tier 3: LLM expansion + deterministic greeting repair + fallback ladder.
	const llm = deps.llm;
	if (llm === undefined) {
		return {
			status: 500,
			json: {
				error: `server misconfigured: ${NIM_API_KEY_NAME} binding missing`,
			},
		};
	}
	let result: LadderResult;
	try {
		result = await runLadder(preparedIr, {
			expandPrepared: async (irText: string, hint?: string) => {
				const r =
					hint === undefined
						? await expand(
								llm,
								req.model,
								irText,
								undefined,
								NO_THINK_EXTRA_BODY,
								lang,
							)
						: await expand(
								llm,
								req.model,
								irText,
								hint,
								NO_THINK_EXTRA_BODY,
								lang,
							);
				return {
					text: r.text,
					finishReason: r.finishReason,
					usage: r.usage ?? null,
				};
			},
			templateRender: (irText: string) => renderTemplateFallback(irText),
			slotValues: req.slotValues,
			...(req.repairAttempts === undefined
				? {}
				: { repairAttempts: req.repairAttempts }),
			skipStyleRepair: req.fastMode ?? isV3,
			...(allowFast ? { fastRepair: greetingOnlyRepair(lang) } : {}),
			lang,
		});
	} catch (e) {
		console.error(
			'expander upstream error:',
			e instanceof Error ? e.message : String(e),
		);
		return { status: 502, json: { error: 'expander upstream error' } };
	}

	if (result.ok && result.path === 'direct' && deps.cache !== undefined) {
		deps.cache.set(preparedIr, req.slotValues, result.text, lang);
	}

	const tWrap0 = performance.now();
	const text =
		req.greeting === undefined && req.signoff === undefined
			? result.text
			: wrapWithCopy(result.text, req.greeting, req.signoff);
	const wrapMs = roundMs(performance.now() - tWrap0);
	const provider = (llm as { lastProvider?: string }).lastProvider;
	const timings: StageTimings = {
		parseBodyMs,
		loadSpansMs,
		decodeIrMs,
		fastPathMs,
		cacheMs,
		buildPromptMs: 0,
		llmExpandMs: roundMs(result.timings?.llmMs ?? 0),
		postProcessMs: 0,
		validateMs: roundMs(result.timings?.validateMs ?? 0),
		repairMs: roundMs(result.timings?.repairMs ?? 0),
		wrapMs,
		totalMs: roundMs(performance.now() - tTotal0),
		tier: result.path === 'template' ? 'template' : 'llm',
		...(provider === undefined ? {} : { provider }),
	};
	return {
		status: 200,
		timings,
		json: {
			ok: result.ok,
			text,
			path: result.path,
			usage: result.usage,
			versions: { dict: req.dictVersion, kb: req.kbVersion },
			verdicts: result.verdicts,
			timings,
		},
	};
}

function wrapWithCopy(
	text: string,
	greeting: string | undefined,
	signoff: string | undefined,
): string {
	const parts = [greeting ?? '', text, signoff ?? '']
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return parts.join('\n\n');
}

export async function routeRequest(
	deps: AppDeps,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	if (url.pathname === '/health' && request.method === 'GET') {
		return Response.json({ ok: true, dictVersion: deps.dict.version });
	}
	if (url.pathname === '/languages' && request.method === 'GET') {
		return Response.json({ languages: listSupportedLanguages() });
	}
	if (url.pathname === '/expand') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'method not allowed' }, { status: 405 });
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'invalid JSON body' }, { status: 400 });
		}
		const r = await handleExpand(deps, body);
		const headers: Record<string, string> = {};
		if (r.timings !== undefined) {
			headers['Server-Timing'] = formatServerTiming(r.timings);
		}
		return Response.json(r.json, { status: r.status, headers });
	}
	if (url.pathname === '/expand/stream') {
		if (request.method !== 'POST') {
			return Response.json({ error: 'method not allowed' }, { status: 405 });
		}
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'invalid JSON body' }, { status: 400 });
		}
		const r = await handleExpand(deps, body);
		if (r.status !== 200) {
			return Response.json(r.json, { status: r.status });
		}
		const payload = r.json as { text?: string };
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				if (typeof payload.text === 'string' && payload.text.length > 0) {
					controller.enqueue(
						encoder.encode(
							`event: delta\ndata: ${JSON.stringify({ text: payload.text })}\n\n`,
						),
					);
				}
				controller.enqueue(
					encoder.encode(`event: done\ndata: ${JSON.stringify(r.json)}\n\n`),
				);
				controller.close();
			},
		});
		const headers: Record<string, string> = {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache',
		};
		if (r.timings !== undefined) {
			headers['Server-Timing'] = formatServerTiming(r.timings);
		}
		return new Response(stream, { status: 200, headers });
	}
	return Response.json({ error: 'not found' }, { status: 404 });
}
