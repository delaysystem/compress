// Request pipeline composition (pure over injected deps; runs in workerd AND node tests).
// Flow: parse+validate body -> pin versions -> load spans -> deterministic
// splice -> ladder (expand/repair/template) -> optional wrap -> JSON.
// Single-call invariant: this path spends zero flagship calls (the one call
// is emit, upstream). No regen, no breaker, no budgets.
// Request values are never echoed into error messages.
import { NIM_API_KEY_NAME } from './config.ts';
import type { Dictionary } from './dict.ts';
import {
	classifyLine,
	type ExpanderClient,
	expand,
	prepareExpansion,
	renderTemplateFallback,
} from './expander.ts';
import { type LadderResult, runLadder } from './ladder.ts';
import { NO_THINK_EXTRA_BODY } from './openai.ts';
import type { SpanStore } from './spanref.ts';

export interface AppDeps {
	dict: Dictionary;
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
		},
	};
}

export interface ApiResponse {
	status: number;
	json: unknown;
}

export async function handleExpand(
	deps: AppDeps,
	body: unknown,
): Promise<ApiResponse> {
	const parsed = parseExpandBody(body);
	if (!parsed.ok) {
		return { status: 400, json: { error: parsed.error } };
	}
	const req = parsed.value;
	if (req.dictVersion !== deps.dict.version) {
		return {
			status: 422,
			json: { error: `dict version mismatch: have ${deps.dict.version}` },
		};
	}
	if (!KB_VERSION_RE.test(req.kbVersion)) {
		return { status: 400, json: { error: 'kbVersion: invalid characters' } };
	}
	// Spanless requests skip the store entirely: no KV read on the common path.
	const needsSpans = req.ir
		.split('\n')
		.some((line) => classifyLine(line) === 'span');
	let store: SpanStore | undefined;
	if (needsSpans) {
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
	const prepared = prepareExpansion(req.ir, {
		dict: deps.dict,
		dictVersion: req.dictVersion,
		store: store ?? {
			version: req.kbVersion,
			documents: new Map<string, Map<string, string>>(),
		},
		kbVersion: req.kbVersion,
	});
	if (!prepared.ok) {
		const status = prepared.error.kind === 'malformed' ? 400 : 422;
		return { status, json: { error: prepared.error.message } };
	}
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
		result = await runLadder(prepared.value.expandedIr, {
			expandPrepared: async (irText: string, hint?: string) => {
				const r =
					hint === undefined
						? await expand(
								llm,
								req.model,
								irText,
								undefined,
								NO_THINK_EXTRA_BODY,
							)
						: await expand(llm, req.model, irText, hint, NO_THINK_EXTRA_BODY);
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
		});
	} catch (e) {
		console.error(
			'expander upstream error:',
			e instanceof Error ? e.message : String(e),
		);
		return { status: 502, json: { error: 'expander upstream error' } };
	}
	const text =
		req.greeting === undefined && req.signoff === undefined
			? result.text
			: wrapWithCopy(result.text, req.greeting, req.signoff);
	return {
		status: 200,
		json: {
			ok: result.ok,
			text,
			path: result.path,
			usage: result.usage,
			versions: { dict: req.dictVersion, kb: req.kbVersion },
			verdicts: result.verdicts,
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
		return Response.json(r.json, { status: r.status });
	}
	return Response.json({ error: 'not found' }, { status: 404 });
}
