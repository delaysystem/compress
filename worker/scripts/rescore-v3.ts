// Offline rescore of the v3 pilot with the CURRENT entity extractor.
// The v3 run scored in-memory before the spacing-tolerance fix (run 013),
// which understated recall (split canonicals on corpus spacing). Recomputes
// recall/missing/per-class from the frozen rows (reference + IR + corpus
// grounding by key, per-row word-count assert). No API calls. Reads
// ir-pilot-v3.jsonl (never modified); writes ir-pilot-v3-rescored.json.
// Run from worker/: node --experimental-strip-types scripts/rescore-v3.ts
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

function main(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const rows = readFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v3.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as Row);
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
	const ok = rows.filter((r) => r.error === null && !r.puntLite);
	const totals = new Map<string, { total: number; missing: number }>();
	const missRows: Array<{
		key: string;
		recall: number | null;
		missing: string[];
	}> = [];
	const scores: SampleScore[] = ok.map((r) => {
		const m = r.key.match(/^([^/]+)\/([^#]+)#(\d+)$/);
		if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) {
			throw new Error(`unparseable key ${r.key}`);
		}
		const dg = (dialData[m[1]] ?? []).find((d) => d.dial_id === m[2]);
		const ti = Number(m[3]);
		if (dg === undefined || dg.turns[ti]?.role !== 'agent') {
			throw new Error(`key does not resolve to an agent turn: ${r.key}`);
		}
		const history = dg.turns
			.slice(0, ti)
			.map((t) => `${t.role}: ${t.utterance}`);
		const turn = dg.turns[ti] as Turn;
		const docIds = [
			...new Set(turn.references.map((x) => x.doc_id).filter((d) => d)),
		];
		const docs: string[] = [];
		for (const id of docIds) {
			const text = docData[m[1]]?.[id]?.doc_text;
			if (text !== undefined) {
				docs.push(`[${id}]\n${text}`);
			}
		}
		const grounding = `Conversation so far:\n${history.join('\n')}\n\nDocument excerpts:\n${docs.join('\n\n')}`;
		if (grounding.split(/\s+/).length !== r.groundingMeta.words) {
			throw new Error(`grounding reassembly mismatch for ${r.key}`);
		}
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
			extractEntities(grounding),
		)) {
			const agg = totals.get(c.class) ?? { total: 0, missing: 0 };
			agg.total += c.total;
			agg.missing += c.missing;
			totals.set(c.class, agg);
		}
		return s;
	});
	const lite = summarize(scores);
	const out = {
		generatedAt: new Date().toISOString(),
		source: 'data/derived/ir-pilot-v3.jsonl (frozen run output)',
		extractorNote: 'current entities.ts WITH spacing tolerance (run-013 fix)',
		lite,
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
	writeFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v3-rescored.json'),
		`${JSON.stringify(out, null, 2)}\n`,
	);
	console.log(
		`n=${lite.n} recall=${lite.meanRecall === null ? 'n/a' : lite.meanRecall.toFixed(3)} recallN=${lite.recallN} missRows=${missRows.length}`,
	);
	for (const c of out.byClass) {
		console.log(
			`  ${c.class}: total=${c.total} missing=${c.missing} recall=${c.recall === null ? 'n/a' : c.recall.toFixed(3)}`,
		);
	}
}

main();
