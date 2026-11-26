// Tier 2 slot-parameterized LRU expansion cache.
// Replaces concrete slot values and {{Markers}} with indexed tokens (__V0__, ...)
// so structurally identical IR skeletons reuse validated fluent expansions in
// <0.5ms with exact slot substitution and full 8-check re-validation.

import type { SupportedLang } from './i18n.ts';
import { type ValidatorVerdict, validateExpansion } from './validator.ts';

export interface CanonicalSkeleton {
	key: string;
	bindings: string[];
}

export interface CacheHit {
	text: string;
	verdict: ValidatorVerdict;
}

const PLACEHOLDER_RE = /\{\{[^{}]+\}\}/g;

export function canonicalizeSkeleton(
	preparedIr: string,
	slotValues: string[],
): CanonicalSkeleton {
	const rawSet = new Set<string>();
	for (const s of slotValues) {
		if (s.length > 0) {
			rawSet.add(s);
		}
	}
	for (const m of preparedIr.match(PLACEHOLDER_RE) ?? []) {
		rawSet.add(m);
	}
	// Longest-first replacement prevents shorter substrings from corrupting longer values.
	const candidates = [...rawSet].sort((a, b) => b.length - a.length);
	const bindings: string[] = [];
	let key = preparedIr;
	for (const val of candidates) {
		if (key.includes(val)) {
			const idx = bindings.length;
			bindings.push(val);
			key = key.split(val).join(`__V${idx}__`);
		}
	}
	return { key, bindings };
}

export class ExpansionCache {
	private readonly maxEntries: number;
	private readonly map = new Map<string, string>();

	constructor(maxEntries = 512) {
		this.maxEntries = Math.max(1, maxEntries);
	}

	get size(): number {
		return this.map.size;
	}

	clear(): void {
		this.map.clear();
	}

	get(
		preparedIr: string,
		slotValues: string[],
		lang: SupportedLang = 'en',
	): CacheHit | undefined {
		const { key, bindings } = canonicalizeSkeleton(preparedIr, slotValues);
		const namespacedKey = `${lang}\0${key}`;
		const template = this.map.get(namespacedKey);
		if (template === undefined) {
			return undefined;
		}
		// Refresh LRU recency.
		this.map.delete(namespacedKey);
		this.map.set(namespacedKey, template);

		let restored = template;
		for (let i = 0; i < bindings.length; i++) {
			const val = bindings[i];
			if (val !== undefined) {
				restored = restored.split(`__V${i}__`).join(val);
			}
		}

		const verdict = validateExpansion({
			splicedIr: preparedIr,
			slotValues,
			output: restored,
			finishReason: 'STOP',
			source: 'model',
			lang,
		});
		if (!verdict.pass) {
			return undefined;
		}
		return { text: restored, verdict };
	}

	set(
		preparedIr: string,
		slotValues: string[],
		reply: string,
		lang: SupportedLang = 'en',
	): boolean {
		const { key, bindings } = canonicalizeSkeleton(preparedIr, slotValues);
		const namespacedKey = `${lang}\0${key}`;
		let parameterized = reply;
		for (let i = 0; i < bindings.length; i++) {
			const val = bindings[i];
			if (val === undefined) {
				continue;
			}
			if (!parameterized.includes(val)) {
				return false;
			}
			parameterized = parameterized.split(val).join(`__V${i}__`);
		}
		if (this.map.has(namespacedKey)) {
			this.map.delete(namespacedKey);
		} else if (this.map.size >= this.maxEntries) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) {
				this.map.delete(oldest);
			}
		}
		this.map.set(namespacedKey, parameterized);
		return true;
	}
}
