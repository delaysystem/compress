// Exact template mining with entity-slot detection (PLAN.md Step 1).
// Deterministic pipeline: split sentences -> mask entity spans to typed slots
// -> exact-group normalized skeletons -> rank by frequency x fixed-word
// savings. Paraphrase (non-entity) variation stays split on purpose: splits
// cost dictionary space, merges corrupt meaning (PLAN.md safeguard #2).
// Embedding-based paraphrase clustering is a later, separately gated tier.
//
// Method limits (carried into every report this feeds): the sentence splitter
// is naive ([.!?] boundaries, breaks on abbreviations); skeletons keep
// first-seen casing (casing canonicalization is a Step 1 refinement); savings
// are counted in words with a 1-word code-cost proxy until the production
// tokenizer (countTokens) re-measures them. Assumes case folding preserves
// span offsets (true for ASCII/Latin corpora like ours).

import { DICT_MIN_SUPPORT } from './config.ts';
import { extractEntities } from './entities.ts';

export interface MinedTemplate {
	skeleton: string;
	slots: string[];
	count: number;
	examples: string[];
	meanWords: number;
	fixedWords: number;
	savedWords: number;
}

export interface CoveragePoint {
	k: number;
	entries: number;
	coverage: number;
	grossSavedWords: number;
}

export interface ExactGroup {
	text: string;
	count: number;
}

/** Proxy: a short code costs ~1 word/token. Origin: assumption, verify via countTokens. */
const CODE_WORDS = 1;
/** Templates with fewer fixed words than this save nothing. Origin: definitional (code costs 1). */
const MIN_FIXED_WORDS = 2;
/** Display cap. Origin: arbitrary readability choice. */
const DEFAULT_MAX_EXAMPLES = 3;

const PLACEHOLDER_RE = /\{[a-z]+:\d+\}/g;

export function splitSentences(text: string): string[] {
	return text
		.split(/[.!?]+(?:\s+|\s*$)/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

export function normalizeForCounting(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function countWords(text: string): number {
	const t = text.trim();
	return t.length === 0 ? 0 : t.split(/\s+/).length;
}

export interface MaskedSentence {
	skeleton: string;
	slotNames: string[];
	fixedWords: number;
	slotCount: number;
}

export function maskEntities(sentence: string): MaskedSentence {
	const spans = [...extractEntities(sentence)].sort(
		(a, b) => a.start - b.start,
	);
	const seen = new Map<string, number>();
	const numbered = spans.map((s) => {
		const n = (seen.get(s.class) ?? 0) + 1;
		seen.set(s.class, n);
		return { ...s, label: `{${s.class}:${n}}` };
	});
	let skeleton = sentence;
	for (let i = numbered.length - 1; i >= 0; i--) {
		const s = numbered[i];
		if (s === undefined) {
			continue;
		}
		skeleton = skeleton.slice(0, s.start) + s.label + skeleton.slice(s.end);
	}
	const slotNames = numbered.map((s) => s.label.slice(1, -1));
	const fixedWords = countWords(skeleton.replace(PLACEHOLDER_RE, ' '));
	return { skeleton, slotNames, fixedWords, slotCount: numbered.length };
}

export interface MineOptions {
	minSupport?: number;
	maxExamples?: number;
}

export function mineTemplates(
	texts: string[],
	opts: MineOptions = {},
): MinedTemplate[] {
	const minSupport = opts.minSupport ?? DICT_MIN_SUPPORT;
	const maxExamples = opts.maxExamples ?? DEFAULT_MAX_EXAMPLES;
	const groups = new Map<
		string,
		{
			skeleton: string;
			slots: string[];
			count: number;
			examples: string[];
			words: number;
			fixedWords: number;
		}
	>();
	for (const text of texts) {
		for (const sentence of splitSentences(text)) {
			const masked = maskEntities(sentence);
			const key = normalizeForCounting(masked.skeleton);
			const g = groups.get(key);
			if (g === undefined) {
				groups.set(key, {
					skeleton: masked.skeleton,
					slots: masked.slotNames,
					count: 1,
					examples: [sentence],
					words: countWords(sentence),
					fixedWords: masked.fixedWords,
				});
			} else {
				g.count += 1;
				g.words += countWords(sentence);
				if (g.examples.length < maxExamples) {
					g.examples.push(sentence);
				}
			}
		}
	}
	const out: MinedTemplate[] = [];
	for (const g of groups.values()) {
		if (g.count < minSupport || g.fixedWords < MIN_FIXED_WORDS) {
			continue;
		}
		out.push({
			skeleton: g.skeleton,
			slots: g.slots,
			count: g.count,
			examples: g.examples,
			meanWords: g.words / g.count,
			fixedWords: g.fixedWords,
			savedWords: Math.max(0, g.fixedWords - CODE_WORDS) * g.count,
		});
	}
	out.sort((a, b) => b.savedWords - a.savedWords);
	return out;
}

export function exactDuplicates(texts: string[]): ExactGroup[] {
	const counts = new Map<string, ExactGroup>();
	for (const t of texts) {
		const key = normalizeForCounting(t);
		const g = counts.get(key);
		if (g === undefined) {
			counts.set(key, { text: t, count: 1 });
		} else {
			g.count += 1;
		}
	}
	return [...counts.values()]
		.filter((g) => g.count > 1)
		.sort((a, b) => b.count - a.count);
}

export function coverageCurve(
	templates: MinedTemplate[],
	totalWords: number,
	ks: number[],
): CoveragePoint[] {
	return ks.map((k) => {
		const top = templates.slice(0, k);
		const gross = top.reduce((s, t) => s + t.savedWords, 0);
		return {
			k,
			entries: top.length,
			coverage: totalWords > 0 ? gross / totalWords : 0,
			grossSavedWords: gross,
		};
	});
}
