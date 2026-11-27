// Tier 1 sub-millisecond deterministic fluent realizer for Wire v3 IR.
// Supports all 20 most spoken languages across all 46 dict-ir-v3 codes PLUS
// deterministic fluent realization of concise TX / TEXT segments, gated by
// the full 8-check validateExpansion() contract.

import { SKIP_EXPANSION_TOKENS } from './config.ts';
import { type Dictionary, findEntry } from './dict.ts';
import {
	SUPPORTED_LANGUAGES,
	type SupportedLang,
	TX_DETAIL_PREFIX,
} from './i18n.ts';
import { FLUENT_TEMPLATES_BY_LANG } from './i18n-templates.ts';
import { type ValidatorVerdict, validateExpansion } from './validator.ts';
import type { V3Segment } from './wirev3.ts';

/** English fluent templates (re-exported for backwards compatibility). */
export const FLUENT_V3_TEMPLATES: Record<string, string> =
	FLUENT_TEMPLATES_BY_LANG.en;

const EN_IMPERATIVE_RE =
	/^(?:provide|proceed|enter|click|check|verify|select|submit|contact|confirm|review|update|switch|navigate|open|use|visit|follow|send|share|include|type|scroll|locate|find|go|reset|change|cancel|track|view|log|sign)\b/i;

function glueRatio(text: string, lang: SupportedLang): number {
	const meta = SUPPORTED_LANGUAGES[lang];
	if (meta.cjk) {
		const chars = [...text.replace(/\s+/g, '')];
		if (chars.length === 0) {
			return 0;
		}
		let hits = 0;
		for (const g of meta.glueWords) {
			if (text.includes(g)) {
				hits += 1;
			}
		}
		return hits / Math.max(1, Math.ceil(chars.length / 4));
	}
	const words = text
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
		.filter((w) => w.length > 0);
	if (words.length === 0) {
		return 0;
	}
	return (
		words.filter(
			(w) => meta.glueWords.has(w) || SUPPORTED_LANGUAGES.en.glueWords.has(w),
		).length / words.length
	);
}

function wordCount(text: string, lang: SupportedLang): number {
	if (SUPPORTED_LANGUAGES[lang].cjk) {
		return Math.ceil(text.replace(/\s+/g, '').length / 2);
	}
	return text
		.trim()
		.split(/\s+/)
		.filter((w) => w.length > 0).length;
}

function ensureSentence(text: string, lang: SupportedLang): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) {
		return '';
	}
	const meta = SUPPORTED_LANGUAGES[lang];
	const capped =
		meta.cjk ||
		meta.rtl ||
		trimmed.startsWith('{{') ||
		trimmed.startsWith('http')
			? trimmed
			: `${trimmed[0]?.toUpperCase() ?? ''}${trimmed.slice(1)}`;
	return /[.!?…।。！？؟۔]$/.test(capped)
		? capped
		: `${capped}${meta.sentenceEnd}`;
}

function lowerFirstAscii(text: string): string {
	if (text.length === 0 || text.startsWith('{{') || text.startsWith('http')) {
		return text;
	}
	const first = text[0] ?? '';
	const second = text[1] ?? '';
	// Keep acronyms (PIN, URL, ID) uppercase.
	if (/[A-Z]/.test(first) && /[A-Z]/.test(second)) {
		return text;
	}
	return `${first.toLowerCase()}${text.slice(1)}`;
}

function realizeFreeText(text: string, lang: SupportedLang): string {
	const t = text.trim();
	const wc = wordCount(t, lang);
	if (wc >= 5 && glueRatio(t, lang) >= 0.2) {
		return ensureSentence(t, lang);
	}
	if (lang === 'en' && EN_IMPERATIVE_RE.test(t)) {
		return ensureSentence(`Please ${lowerFirstAscii(t)}`, lang);
	}
	const prefix = TX_DETAIL_PREFIX[lang];
	const sep = SUPPORTED_LANGUAGES[lang].cjk ? '' : ' ';
	return ensureSentence(`${prefix}${sep}${t}`, lang);
}

function fillFluentTemplate(
	template: string,
	slotNames: string[],
	slotValues: string[],
): string {
	let out = template;
	for (let i = 0; i < slotNames.length; i++) {
		const name = slotNames[i];
		const val = slotValues[i];
		if (name === undefined || val === undefined) {
			continue;
		}
		out = out.replaceAll(`{${name}}`, val);
	}
	return out;
}

/** Realize parsed Wire v3 segments into fluent prose in any of the 20 supported languages.
 * Handles all 46 dict-ir-v3 codes plus concise/mixed TX & TEXT segments deterministically.
 * Returns null only for long (>SKIP_EXPANSION_TOKENS) code-less free-text blobs or unknown codes. */
export function realizeV3Segments(
	segments: V3Segment[],
	dict: Dictionary,
	lang: SupportedLang = 'en',
): string | null {
	if (segments.length === 0) {
		return null;
	}
	const templates = FLUENT_TEMPLATES_BY_LANG[lang];
	const meta = SUPPORTED_LANGUAGES[lang];
	const hasCodedSegment = segments.some(
		(s) => s.kind === 'code' && s.code !== 'TX',
	);
	const sentences: string[] = [];
	let totalTextWords = 0;

	for (const seg of segments) {
		if (seg.kind === 'text') {
			const t = seg.text.trim();
			if (t.length === 0) {
				continue;
			}
			totalTextWords += wordCount(t, lang);
			if (!hasCodedSegment && totalTextWords > SKIP_EXPANSION_TOKENS) {
				return null;
			}
			sentences.push(realizeFreeText(t, lang));
			continue;
		}

		if (seg.code === 'TX') {
			const t = (seg.slots[0] ?? '').trim();
			if (t.length === 0) {
				continue;
			}
			totalTextWords += wordCount(t, lang);
			if (!hasCodedSegment && totalTextWords > SKIP_EXPANSION_TOKENS) {
				return null;
			}
			sentences.push(realizeFreeText(t, lang));
			continue;
		}

		const fluent = templates[seg.code];
		const entry = findEntry(dict, seg.code);
		if (
			fluent === undefined ||
			entry === undefined ||
			seg.slots.length !== entry.slots.length
		) {
			return null;
		}
		sentences.push(
			ensureSentence(fillFluentTemplate(fluent, entry.slots, seg.slots), lang),
		);
	}

	if (sentences.length === 0) {
		return null;
	}
	return sentences.join(meta.joiner);
}

export type FastRealizeResult =
	| { ok: true; text: string; verdict: ValidatorVerdict }
	| { ok: false };

/** Attempt Tier 1 deterministic realization and gate it with full 8-check validation. */
export function tryFastRealize(opts: {
	segments: V3Segment[];
	preparedIr: string;
	slotValues: string[];
	dict: Dictionary;
	lang?: SupportedLang;
}): FastRealizeResult {
	const lang = opts.lang ?? 'en';
	const text = realizeV3Segments(opts.segments, opts.dict, lang);
	if (text === null) {
		return { ok: false };
	}
	const verdict = validateExpansion({
		splicedIr: opts.preparedIr,
		slotValues: opts.slotValues,
		output: text,
		finishReason: 'STOP',
		source: 'model',
		lang,
	});
	const hasTerse = (verdict.warnings ?? []).some((w) =>
		w.startsWith('terse-mirror'),
	);
	if (!verdict.pass || hasTerse) {
		return { ok: false };
	}
	return { ok: true, text, verdict };
}
