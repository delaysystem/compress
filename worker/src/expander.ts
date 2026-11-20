// Cheap-expander path (PLAN.md Phase 2): deterministic splice of codes/spans,
// then one SLM expansion call. Code uses in IR look like:
//   :<code>|<slot 1>|<slot 2>
// Span refs look like:
//   @span:{"d": "<doc id>", "s": "<span id>"}
// Lines starting with : or @ that parse as neither are malformed: prepare
// fails fast with a line number (feeds the ladder repair path), never silently.
// Slot values must not contain '|' (v0 limitation, enforced below).

import { type Dictionary, decodeLine } from './dict.ts';
import { extractEntities } from './entities.ts';
import type { GenerateResult } from './gemini.ts';

/** Minimal structural surface the expander needs. Both provider clients
 * satisfy it (method bivariance); usage arrives in TokenUsage vocabulary
 * (providers map their own counters onto it at their boundary). */
export interface ExpanderClient {
	generate(
		model: string,
		prompt: string,
		params?: {
			temperature?: number;
			maxOutputTokens?: number;
			extraBody?: Record<string, unknown>;
		},
	): Promise<GenerateResult>;
}

import {
	expandShortRefs,
	parseRef,
	parseShortRef,
	resolveRefs,
	type SpanRef,
	type SpanStore,
} from './spanref.ts';

// Single-char code prefix: : fractures to 2 tok/line in cl100k (measured best
// of %, !, :, #, ^, ~, @). Spans keep @span: (unused in pilots).
const CODE_PREFIX = ':';
const SPAN_PREFIX = '@span:';

export interface PreparedExpansion {
	expandedIr: string;
	appliedCodes: string[];
	appliedSpans: SpanRef[];
}

export type PrepareErrorKind = 'malformed' | 'resolve';

export interface PrepareError {
	kind: PrepareErrorKind;
	message: string;
}

export type PrepareResult =
	| { ok: true; value: PreparedExpansion }
	| { ok: false; error: PrepareError };

export type LineKind = 'code' | 'span' | 'text' | 'malformed';

export function classifyLine(line: string): LineKind {
	const t = line.trim();
	if (t.startsWith(CODE_PREFIX)) {
		return /^:[a-z]{1,2}(\|[^|]*)*$/.test(t) ? 'code' : 'malformed';
	}
	if (parseShortRef(t) !== undefined) {
		return 'span';
	}
	// Lenient bare codes (run 028): the emitter drops the : prefix on ~2%
	// of lines (measured). A bare 1-2 letter code shape is near-certainly
	// a code (ultra-terse fragments never contain pipes); unknown codes
	// still fail loud at decode. The prompt still demands the prefix —
	// this is forgiveness, not a second wire format.
	if (/^[a-z]{1,2}\|[^|]*(\|[^|]*)*$/.test(t)) {
		return 'code';
	}
	if (!t.startsWith('@')) {
		return 'text';
	}
	if (t.startsWith(SPAN_PREFIX)) {
		return parseRef(t.slice(SPAN_PREFIX.length)) === undefined
			? 'malformed'
			: 'span';
	}
	return 'malformed';
}

export interface CodeUse {
	code: string;
	slotValues: string[];
}

export interface SlotViolation {
	line: number;
	code: string;
	words: number;
	maxWords: number;
}

/** Slot-budget check (run 031+): every slot value must fit maxWords.
 * Long slots are prose hiding in values — the repair loop sends them
 * back, not through. Pure and total over the IR text. */
export function slotViolations(
	irText: string,
	maxWords: number,
): SlotViolation[] {
	const out: SlotViolation[] = [];
	const lines = irText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		if (classifyLine(line) !== 'code') {
			continue;
		}
		const use = parseCodeLine(line);
		if (use === undefined) {
			continue;
		}
		for (const v of use.slotValues) {
			const n = v.split(/\s+/).filter((w) => w.length > 0).length;
			if (n > maxWords) {
				out.push({ line: i + 1, code: use.code, words: n, maxWords });
			}
		}
	}
	return out;
}

export function parseCodeLine(line: string): CodeUse | undefined {
	if (classifyLine(line) !== 'code') {
		return undefined;
	}
	const t = line.trim();
	const body = t.startsWith(CODE_PREFIX) ? t.slice(CODE_PREFIX.length) : t;
	const [code, ...rest] = body.split('|');
	if (code === undefined || code.length === 0) {
		return undefined;
	}
	// Forgive trailing pipes (:w|a|b|): trailing empties carry nothing.
	// Middle empties are kept: a missing slot must fail arity, not shift.
	const slotValues = [...rest];
	while (slotValues.length > 0 && slotValues[slotValues.length - 1] === '') {
		slotValues.pop();
	}
	return { code, slotValues };
}

export interface SpliceInputs {
	dict: Dictionary;
	dictVersion: string;
	store: SpanStore;
	kbVersion: string;
}

export function prepareExpansion(
	irText: string,
	inputs: SpliceInputs,
): PrepareResult {
	const out: string[] = [];
	const appliedCodes: string[] = [];
	const appliedSpans: SpanRef[] = [];
	const lines = irText.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const kind = classifyLine(line);
		if (kind === 'text') {
			out.push(line);
			continue;
		}
		if (kind === 'malformed') {
			return {
				ok: false,
				error: { kind: 'malformed', message: `malformed IR line ${i + 1}` },
			};
		}
		if (kind === 'code') {
			const use = parseCodeLine(line);
			if (use === undefined) {
				return {
					ok: false,
					error: { kind: 'malformed', message: `malformed code line ${i + 1}` },
				};
			}
			const decoded = decodeLine(
				inputs.dict,
				inputs.dictVersion,
				use.code,
				use.slotValues,
			);
			if (!decoded.ok) {
				return {
					ok: false,
					error: {
						kind: 'resolve',
						message: `line ${i + 1}: ${decoded.error}`,
					},
				};
			}
			appliedCodes.push(use.code);
			out.push(decoded.text);
			continue;
		}
		const ref = line.trim().startsWith(SPAN_PREFIX)
			? parseRef(line.trim().slice(SPAN_PREFIX.length))
			: parseShortRef(line.trim());
		if (ref === undefined) {
			return {
				ok: false,
				error: { kind: 'malformed', message: `malformed span line ${i + 1}` },
			};
		}
		const resolved = resolveRefs(inputs.store, inputs.kbVersion, [ref]);
		if (!resolved.ok) {
			return {
				ok: false,
				error: { kind: 'resolve', message: `line ${i + 1}: ${resolved.error}` },
			};
		}
		const first = resolved.spans[0];
		if (first === undefined) {
			return {
				ok: false,
				error: { kind: 'resolve', message: `line ${i + 1}: empty resolution` },
			};
		}
		appliedSpans.push(ref);
		out.push(first.text);
	}
	// Inline short refs (^12 inside spliced code lines or text): resolve
	// against the request map so slots can cite spans, not just lines.
	const final: string[] = [];
	for (let i = 0; i < out.length; i++) {
		const expanded = expandShortRefs(
			inputs.store,
			inputs.kbVersion,
			out[i] ?? '',
		);
		if (!expanded.ok) {
			return {
				ok: false,
				error: { kind: 'resolve', message: `line ${i + 1}: ${expanded.error}` },
			};
		}
		final.push(expanded.text);
	}
	return {
		ok: true,
		value: { expandedIr: final.join('\n'), appliedCodes, appliedSpans },
	};
}

// Expansion prompt v1 (run 016: rule 3 strengthened after a 75-row
// two-model eval — LFM3 greeting leaks 8/30 -> 0/30, Gemini unchanged at
// 41/41 with zero leaks on either wording). Rule 3 couples to the wrapper:
// greeting/sign-off are added deterministically downstream, never here.
const EXPANSION_RULES = [
	'You expand a telegraphic support-draft into one fluent customer reply.',
	'Rules:',
	'1. Say exactly what the draft says — no new facts, names, numbers, dates, links, or offers.',
	'2. Copy every number, date, URL, name, and quoted string character-exact.',
	'3. Start directly with the requested content. NEVER open with a greeting (no Hi/Hello/Hey/Thank you) and NEVER close with a sign-off (no Best regards/Thanks/Your Support Team).',
	'4. Output only the reply text.',
].join('\n');

/** Anchor line prefix. Validator strips output lines starting with it:
 * parroted prompt words must neither inflate novelty nor smuggle entities. */
export const ANCHOR_PREFIX = 'Must include these exact values:';

export function buildExpansionPrompt(
	expandedIr: string,
	repairHint?: string,
): string {
	const parts = [EXPANSION_RULES, 'DRAFT:', expandedIr];
	// Entity anchor (run 046): small models de-brace placeholders into prose
	// ("your tracking number" for {{Tracking Number}}). Naming each draft
	// entity as must-include flips LFM3 drops to clean (2/2) and is a no-op
	// for compliant models (cross-emitter: ling/qwen 12/12 pass either way).
	// Entity-less drafts omit the line, keeping the prompt byte-identical.
	const raws = extractEntities(expandedIr).map((e) => e.raw);
	if (raws.length > 0) {
		parts.push(`${ANCHOR_PREFIX} ${raws.join(', ')}.`);
	}
	if (repairHint !== undefined && repairHint.length > 0) {
		parts.push(`REPAIR: ${repairHint}`);
	}
	parts.push('REPLY:');
	return parts.join('\n');
}

// Deliberation stripper (run 023): Qwen-class models deliberate in-band
// ("We need...") and delimit with </think> before the real answer. Served
// and validated text is everything after the LAST closing tag; text without
// a tag passes through (truncated-deliberation rows carry no answer and fail
// completeness downstream). Gemini never emits the tag (verified 83/83),
// so this is a no-op for non-deliberating models.
export function stripThinkBlocks(text: string): string {
	const idx = text.lastIndexOf('</think>');
	return (idx >= 0 ? text.slice(idx + '</think>'.length) : text).trim();
}

// Harmony stripper (run 027): gpt-oss-class models deliberate in an analysis
// channel and delimit with <|channel|>final<|message|> before the real
// answer. Served and validated text is everything after the LAST final
// marker, minus trailing channel tokens; text without a marker passes
// through (same contract as stripThinkBlocks).
const HARMONY_FINAL = '<|channel|>final<|message|>';
export function stripHarmony(text: string): string {
	const idx = text.lastIndexOf(HARMONY_FINAL);
	const tail = idx >= 0 ? text.slice(idx + HARMONY_FINAL.length) : text;
	return tail.replace(/(?:<\|[^|]*\|>|\s)+$/, '').trim();
}

// Anchor-parrot stripper (run 049): finetuned LFM3 rewords the must-include
// anchor line into the reply ("Please note that this service must include
// the exact values: ..."), duplicating entities past parity. Legit replies
// never use prompt language ("must include the exact value"), so a sentence
// containing it is always a parrot. Empty remainder keeps the original.
const PARROT_RE = /must include the exact values?/i;
export function stripAnchorParrot(text: string): string {
	// Separators are captured and replayed: entity extraction treats
	// line-initial numbers as list markers, so reflowing newlines into
	// spaces would mint phantom number entities (v12 bitext-10330).
	const parts = text.split(/(?<=[.!?…])(\s+)/);
	const out: string[] = [];
	let dropped = false;
	for (let i = 0; i < parts.length; i += 2) {
		const sent = parts[i] ?? '';
		if (PARROT_RE.test(sent)) {
			dropped = true;
			continue;
		}
		out.push(sent, parts[i + 1] ?? '');
	}
	if (!dropped) {
		return text.trim();
	}
	const joined = out.join('').trim();
	return joined.length > 0 ? joined : text;
}

// Model-brace normalizer (run 049): the model wraps draft prose in
// placeholders ({{Product Details}} for "product details") or stacks
// braces ({{{{X}}}}). Rules, in order: a span whose inner matches a
// draft marker collapses to the single-brace canonical; a span whose
// words all occur in the draft unwraps to plain prose; anything else
// (invented {{Amount}}) passes through for the validator to fail.
export function normalizeModelBraces(output: string, draft: string): string {
	const draftWords = new Set(
		draft
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
			.filter((w) => w.length > 0),
	);
	const markers = new Map<string, string>();
	for (const m of draft.match(/\{+([^{}]+)\}+/g) ?? []) {
		const inner = m.replace(/^\{+|\}+$/g, '').trim();
		const key = inner.toLowerCase().replace(/\s+/g, ' ');
		if (!markers.has(key)) {
			markers.set(key, `{{${inner}}}`);
		}
	}
	return output.replace(/\{+([^{}]+)\}+/g, (span, inner: string) => {
		const clean = inner.trim();
		const key = clean.toLowerCase().replace(/\s+/g, ' ');
		const canonical = markers.get(key);
		if (canonical !== undefined) {
			return canonical;
		}
		const words = clean
			.toLowerCase()
			.split(/\s+/)
			.filter((w) => w.length > 0);
		if (words.length > 0 && words.every((w) => draftWords.has(w))) {
			return clean;
		}
		return span;
	});
}

export async function expand(
	client: ExpanderClient,
	model: string,
	preparedIr: string,
	repairHint?: string,
	extraBody?: Record<string, unknown>,
): Promise<GenerateResult> {
	const prompt =
		repairHint === undefined
			? buildExpansionPrompt(preparedIr)
			: buildExpansionPrompt(preparedIr, repairHint);
	const result =
		extraBody === undefined
			? await client.generate(model, prompt)
			: await client.generate(model, prompt, { extraBody });
	// Strip deliberation before return so the ladder validates exactly what
	// would ship (usage still counts generated tokens: honest cost accounting).
	const stripped = stripThinkBlocks(stripHarmony(result.text));
	return {
		...result,
		text: normalizeModelBraces(stripAnchorParrot(stripped), preparedIr),
	};
}

// v0 deterministic fallback render: the prepared IR itself, whitespace-trimmed.
// Adds and drops nothing by construction. Richer intent-templated renders are
// follow-up work with evals, not edits.
export function renderTemplateFallback(preparedIr: string): string {
	return preparedIr
		.split('\n')
		.map((l) => l.trimEnd())
		.join('\n')
		.trim();
}
