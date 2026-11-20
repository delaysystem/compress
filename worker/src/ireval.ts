// IR pilot measurement (PLAN.md Step 5 precondition): ratio + entity recall.
// Pure functions over recorded data; the live loop lives in scripts/ir-pilot.ts.
// Recall is SET-based (distinct entities): dropping duplicate mentions is
// compression working, not information lost. (The expansion validator keeps
// multiset semantics per the plan; different direction, different rule.)

import { diffEntities, type Entity, extractEntities } from './entities.ts';

export interface SampleScore {
	fullTokens: number;
	irTokens: number;
	ratio: number;
	recall: number | null;
	missing: string[];
	emptyIr: boolean;
}

function dedupeByKey(ents: Entity[]): Entity[] {
	const seen = new Set<string>();
	return ents.filter((e) => {
		const k = `${e.class}:${e.canonical}`;
		if (seen.has(k)) {
			return false;
		}
		seen.add(k);
		return true;
	});
}

export function scoreSample(
	fullText: string,
	irText: string,
	fullTokens: number,
	irTokens: number,
): SampleScore {
	const ref = dedupeByKey(extractEntities(fullText));
	const ir = dedupeByKey(extractEntities(irText));
	const diff = diffEntities(ref, ir);
	return {
		fullTokens,
		irTokens,
		ratio: irTokens > 0 ? fullTokens / irTokens : Number.POSITIVE_INFINITY,
		recall:
			ref.length === 0 ? null : (ref.length - diff.missing.length) / ref.length,
		missing: diff.missing,
		emptyIr: irText.trim().length === 0,
	};
}

export interface ClassRecall {
	class: string;
	total: number;
	missing: number;
	recall: number | null;
}

export function recallByClass(
	ref: Entity[],
	missingKeys: string[],
	ground?: Entity[],
): ClassRecall[] {
	// With grounding, totals count only measurable entities (reference keys
	// also present in grounding); ungrounded reference entities are excluded,
	// mirroring groundedRecall.
	const groundKeys =
		ground === undefined
			? null
			: new Set(ground.map((e) => `${e.class}:${e.canonical}`));
	const totals = new Map<string, number>();
	for (const e of dedupeByKey(ref)) {
		if (groundKeys !== null && !groundKeys.has(`${e.class}:${e.canonical}`)) {
			continue;
		}
		totals.set(e.class, (totals.get(e.class) ?? 0) + 1);
	}
	const missed = new Map<string, number>();
	for (const k of missingKeys) {
		const cls = k.split(':')[0] ?? '';
		missed.set(cls, (missed.get(cls) ?? 0) + 1);
	}
	return [...totals.entries()]
		.map(([cls, total]) => {
			const m = missed.get(cls) ?? 0;
			return {
				class: cls,
				total,
				missing: m,
				recall: total === 0 ? null : (total - m) / total,
			};
		})
		.sort((a, b) => (a.class < b.class ? -1 : 1));
}

export function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) {
		throw new Error('percentile of empty set');
	}
	const clamped = Math.min(1, Math.max(0, p));
	const idx = Math.min(
		sortedAsc.length - 1,
		Math.floor(clamped * sortedAsc.length),
	);
	const v = sortedAsc[idx];
	if (v === undefined) {
		throw new Error('percentile index out of range');
	}
	return v;
}

export interface PilotSummary {
	n: number;
	emptyIr: number;
	meanRatio: number;
	p50Ratio: number;
	meanRecall: number | null;
	recallN: number;
}

export function summarize(scores: SampleScore[]): PilotSummary {
	const ratios = scores
		.filter((s) => !s.emptyIr)
		.map((s) => s.ratio)
		.sort((a, b) => a - b);
	const recalls = scores
		.map((s) => s.recall)
		.filter((r): r is number => r !== null);
	const mean = (xs: number[]): number | null =>
		xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
	const meanRatio = mean(ratios);
	return {
		n: scores.length,
		emptyIr: scores.filter((s) => s.emptyIr).length,
		meanRatio: meanRatio ?? 0,
		p50Ratio: ratios.length === 0 ? 0 : percentile(ratios, 0.5),
		meanRecall: mean(recalls),
		recallN: recalls.length,
	};
}

export interface GroundedRecall {
	recall: number | null;
	measuring: number;
	missing: string[];
}

// Recall over entities the model could have preserved: present in BOTH the
// reference and the grounding. Entities the reference states but the grounding
// never contained are unmeasurable, not dropped (v1 pilot flaw: the model
// answered from the question alone, so reference-vs-IR recall measured answer
// overlap, not compression fidelity).
export function groundedRecall(
	ref: Entity[],
	ir: Entity[],
	ground: Entity[],
): GroundedRecall {
	const key = (e: Entity): string => `${e.class}:${e.canonical}`;
	const groundKeys = new Set(ground.map(key));
	const irKeys = new Set(ir.map(key));
	const measurable = [...new Set(dedupeByKey(ref).map(key))].filter((k) =>
		groundKeys.has(k),
	);
	const missing = measurable.filter((k) => !irKeys.has(k));
	return {
		recall:
			measurable.length === 0
				? null
				: (measurable.length - missing.length) / measurable.length,
		measuring: measurable.length,
		missing,
	};
}

export function scoreGroundedSample(
	reference: string,
	irText: string,
	grounding: string,
	fullTokens: number,
	irTokens: number,
): SampleScore {
	const g = groundedRecall(
		extractEntities(reference),
		extractEntities(irText),
		extractEntities(grounding),
	);
	return {
		fullTokens,
		irTokens,
		ratio: irTokens > 0 ? fullTokens / irTokens : Number.POSITIVE_INFINITY,
		recall: g.recall,
		missing: g.missing,
		emptyIr: irText.trim().length === 0,
	};
}

/** Normalize once for the lossless gate: lowercase, split on whitespace,
 * strip surrounding punctuation per token, drop empties. */
function gateWords(s: string): string[] {
	return s
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
		.filter((w) => w.length > 0);
}

/** Word-level Levenshtein (lossless gate): insert/delete/substitute cost 1.
 * A lossless pass is wordDiff(expanded, native) <= LOSSLESS_WORD_BUDGET. */
export function wordDiff(a: string, b: string): number {
	const x = gateWords(a);
	const y = gateWords(b);
	let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
	for (let i = 1; i <= x.length; i++) {
		const cur = [i];
		for (let j = 1; j <= y.length; j++) {
			cur[j] = Math.min(
				(prev[j] ?? 0) + 1,
				(cur[j - 1] ?? 0) + 1,
				(prev[j - 1] ?? 0) + (x[i - 1] === y[j - 1] ? 0 : 1),
			);
		}
		prev = cur;
	}
	return prev[y.length] ?? 0;
}
