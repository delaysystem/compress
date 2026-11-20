// Offline rescore of the v2 pilot with the CURRENT entity extractor.
// The v2 run scored in-memory with pre-list-marker semantics; this recomputes
// recall/missing/per-class from the frozen rows (reference + IR) without new
// API calls. Grounded-arm grounding is reassembled from the corpus by row key,
// mirroring loadGroundedSamples in scripts/ir-pilot-v2.ts; assembly fidelity
// is asserted per row against the stored grounding word count (abort on any
// mismatch). Reads ir-pilot-v2.jsonl (never modified); writes
// data/derived/ir-pilot-v2-rescored.json.
// Run from worker/: node --experimental-strip-types scripts/rescore-v2.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntities } from '../src/entities.ts';
import {
	recallByClass,
	type SampleScore,
	scoreGroundedSample,
	summarize,
} from '../src/ireval.ts';

interface Row {
	arm: 'compress' | 'grounded';
	key: string;
	reference: string;
	groundingMeta: { words: number };
	irLite: string;
	liteTokens: number;
	fullTokens: number;
	puntLite: boolean;
	error: string | null;
}

interface Turn {
	role: string;
	utterance: string;
	references: Array<{ doc_id: string }>;
}

function loadCorpus(root: string): {
	dialData: Record<string, Array<{ dial_id: string; turns: Turn[] }>>;
	docData: Record<string, Record<string, { doc_text: string }>>;
} {
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
	return { dialData, docData };
}

/** Mirror of the runner's grounding assembly (see header for the proof). */
function reassemble(
	key: string,
	expectedWords: number,
	corpus: ReturnType<typeof loadCorpus>,
): string {
	const m = key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
	if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
		throw new Error(`unparseable key ${key}`);
	}
	const dg = (corpus.dialData[m[1]] ?? []).find((d) => d.dial_id === m[2]);
	const ti = Number(m[3]);
	const turn = dg?.turns[ti];
	if (dg === undefined || turn === undefined || turn.role !== 'agent') {
		throw new Error(`key does not resolve to an agent turn: ${key}`);
	}
	const history = dg.turns.slice(0, ti).map((t) => `${t.role}: ${t.utterance}`);
	const docIds = [
		...new Set(turn.references.map((r) => r.doc_id).filter((d) => d)),
	];
	const docs: string[] = [];
	for (const id of docIds) {
		const text = corpus.docData[m[1]]?.[id]?.doc_text;
		if (text !== undefined) {
			docs.push(`[${id}]\n${text}`);
		}
	}
	const grounding = `Conversation so far:\n${history.join('\n')}\n\nDocument excerpts:\n${docs.join('\n\n')}`;
	if (grounding.split(/\s+/).length !== expectedWords) {
		throw new Error(
			`grounding reassembly mismatch for ${key} (runner logic drifted?)`,
		);
	}
	return grounding;
}

function main(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const rows = readFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v2.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as Row);
	const corpus = loadCorpus(root);
	const arms = {} as Record<
		Row['arm'],
		{
			scores: SampleScore[];
			byClass: ReturnType<typeof recallByClass>;
			missRows: Array<{
				key: string;
				recall: number | null;
				missing: string[];
			}>;
		}
	>;
	for (const arm of ['compress', 'grounded'] as const) {
		const ok = rows.filter(
			(r) => r.arm === arm && r.error === null && !r.puntLite,
		);
		const totals = new Map<string, { total: number; missing: number }>();
		const missRows: Array<{
			key: string;
			recall: number | null;
			missing: string[];
		}> = [];
		const scores: SampleScore[] = ok.map((r) => {
			const grounding =
				arm === 'compress'
					? r.reference
					: reassemble(r.key, r.groundingMeta.words, corpus);
			const s = scoreGroundedSample(
				r.reference,
				r.irLite,
				grounding,
				r.fullTokens,
				r.liteTokens,
			);
			if (s.recall !== null && s.recall < 1) {
				missRows.push({ key: r.key, recall: s.recall, missing: s.missing });
			}
			for (const c of recallByClass(
				extractEntities(r.reference),
				s.missing,
				arm === 'grounded' ? extractEntities(grounding) : undefined,
			)) {
				const agg = totals.get(c.class) ?? { total: 0, missing: 0 };
				agg.total += c.total;
				agg.missing += c.missing;
				totals.set(c.class, agg);
			}
			return s;
		});
		arms[arm] = {
			scores,
			byClass: [...totals.entries()]
				.map(([cls, a]) => ({
					class: cls,
					total: a.total,
					missing: a.missing,
					recall: a.total === 0 ? null : (a.total - a.missing) / a.total,
				}))
				.sort((a, b) => (a.class < b.class ? -1 : 1)),
			missRows,
		};
	}
	const out = {
		generatedAt: new Date().toISOString(),
		source: 'data/derived/ir-pilot-v2.jsonl (frozen run output)',
		extractorNote:
			'current entities.ts WITH list-marker exclusion (run-010 fix)',
		arms: Object.fromEntries(
			(
				Object.entries(arms) as Array<
					[
						col: string,
						v: {
							scores: SampleScore[];
							byClass: unknown;
							missRows: unknown;
						},
					]
				>
			).map(([arm, v]) => [
				arm,
				{ lite: summarize(v.scores), byClass: v.byClass, missRows: v.missRows },
			]),
		),
	};
	writeFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v2-rescored.json'),
		`${JSON.stringify(out, null, 2)}\n`,
	);
	for (const [arm, v] of Object.entries(arms)) {
		const s = summarize(v.scores);
		const r = s.meanRecall === null ? 'n/a' : s.meanRecall.toFixed(3);
		console.log(
			`${arm}: n=${s.n} p50=${s.p50Ratio.toFixed(2)} mean=${s.meanRatio.toFixed(2)} recall=${r} recallN=${s.recallN}`,
		);
		for (const c of v.byClass) {
			console.log(
				`  ${c.class}: total=${c.total} missing=${c.missing} recall=${c.recall === null ? 'n/a' : c.recall.toFixed(3)}`,
			);
		}
		for (const m of v.missRows) {
			console.log(`  MISS ${m.key} recall=${m.recall} ${m.missing.join(' ')}`);
		}
	}
}

main();
