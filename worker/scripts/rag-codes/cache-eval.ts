// RAG-code prototype, answer-cache eval (Layer 0b): for held-out bitext
// questions, find the nearest cached neighbor and measure hit rates plus
// answer closeness (wordDiff of cached reply vs reference). A hit means a
// future turn could skip the flagship call entirely.
// Run from worker/: node --experimental-strip-types scripts/rag-codes/cache-eval.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { wordDiff } from '../../src/ireval.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

type StoreRow = {
	id: string;
	instruction: string;
	response: string;
	emb: number[];
};

function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i] ?? 0;
		const y = b[i] ?? 0;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function main(): Promise<void> {
	const store: StoreRow[] = readFileSync(
		join(root, 'data', 'derived', 'rag-store.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.filter((l) => l.length > 0)
		.map((l) => JSON.parse(l) as StoreRow);
	console.log(`store: ${store.length} rows dim=${store[0]?.emb.length ?? 0}`);
	const v2keys = readFileSync(
		join(root, 'data', 'derived', 'ir-pilot-v2.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { arm: string; key: string })
		.filter((r) => r.arm === 'compress')
		.slice(100, 200)
		.map((r) => r.key)
		.filter((k) => k.startsWith('bitext-'));
	const rows = parse(
		readFileSync(join(root, 'data', 'bitext', 'bitext-27k.csv'), 'utf8'),
		{
			columns: true,
			skip_empty_lines: true,
		},
	) as Array<Record<string, string>>;
	const queries = new Map<string, number[]>();
	for (const l of readFileSync(
		join(root, 'data', 'derived', 'rag-queries.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')) {
		if (!l) continue;
		const r = JSON.parse(l) as { id: string; emb: number[] };
		queries.set(r.id, r.emb);
	}
	const hits = { h90: 0, h95: 0, h98: 0 };
	const diffs: number[] = [];
	const diffs95: number[] = [];
	const diffs98: number[] = [];
	let tested = 0;
	for (const key of v2keys) {
		const q = queries.get(key);
		const row = rows[Number(key.split('-')[1])];
		if (!q || !row) continue;
		tested++;
		let best = { sim: -1, resp: '' };
		for (const s of store) {
			const sim = cosine(q, s.emb);
			if (sim > best.sim) best = { sim, resp: s.response };
		}
		if (best.sim >= 0.9) hits.h90++;
		if (best.sim >= 0.95) hits.h95++;
		if (best.sim >= 0.98) hits.h98++;
		const d = wordDiff(best.resp, row.response ?? '');
		if (best.sim >= 0.9) diffs.push(d);
		if (best.sim >= 0.95) diffs95.push(d);
		if (best.sim >= 0.98) diffs98.push(d);
	}
	const med = (a: number[]): number => {
		a.sort((x, y) => x - y);
		return a.length > 0 ? (a[Math.floor(a.length / 2)] ?? 0) : 0;
	};
	console.log(
		`tested=${tested} hit@0.90=${hits.h90} hit@0.95=${hits.h95} hit@0.98=${hits.h98} ` +
			`diffMed@0.90=${med(diffs)}(n=${diffs.length}) diffMed@0.95=${med(diffs95)}(n=${diffs95.length}) diffMed@0.98=${med(diffs98)}(n=${diffs98.length})`,
	);
}

await main();
