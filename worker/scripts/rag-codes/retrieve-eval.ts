// RAG-code prototype, step 2 (THE GATE): for held-out bitext questions,
// retrieve top-3 neighbors from the file store and measure whether neighbor
// replies contain the reference's move shapes (skeleton overlap) and entities.
// PASS bar: >=50% of refs share >=1 move skeleton with a neighbor at Jaccard
// 0.6. Below that, retrieval cannot supply phrases and the track stops here.
// Run from worker/: node --experimental-strip-types scripts/rag-codes/retrieve-eval.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';

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

function skeleton(s: string): string {
	return s
		.toLowerCase()
		.replace(/\{\{[^}]+\}\}/g, '{S}')
		.replace(/https?:\/\/\S+/g, '{S}')
		.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '{S}')
		.replace(/\d[\d,./:-]*/g, '{S}')
		.replace(/[^a-z\s{}]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function sentences(t: string): string[] {
	return t
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 8);
}

function jaccard(a: string, b: string): number {
	const A = new Set(a.split(' '));
	const B = new Set(b.split(' '));
	let inter = 0;
	for (const w of A) {
		if (B.has(w)) inter++;
	}
	return inter / Math.max(1, new Set([...A, ...B]).size);
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
	// Query embeddings were saved alongside the gate inputs by build-store --queries
	const qpath = join(root, 'data', 'derived', 'rag-queries.jsonl');
	const queries = new Map<string, number[]>();
	for (const l of readFileSync(qpath, 'utf8').trim().split('\n')) {
		if (!l) continue;
		const r = JSON.parse(l) as { id: string; emb: number[] };
		queries.set(r.id, r.emb);
	}
	let withMove = 0;
	let withMove5 = 0;
	let tested = 0;
	for (const key of v2keys) {
		const q = queries.get(key);
		const row = rows[Number(key.split('-')[1])];
		if (!q || !row) continue;
		tested++;
		const scored = store
			.map((s) => ({ s, sim: cosine(q, s.emb) }))
			.sort((a, b) => b.sim - a.sim)
			.slice(0, 3);
		const refSkels = sentences(row.response ?? '').map(skeleton);
		const nbSkels = scored.flatMap(({ s }) =>
			sentences(s.response).map(skeleton),
		);
		const covered = (t: number) =>
			refSkels.filter((r) => nbSkels.some((n) => jaccard(r, n) >= t)).length;
		if (covered(0.6) >= 1) withMove++;
		if (covered(0.5) >= 1) withMove5++;
	}
	console.log(
		`tested=${tested} withMove@0.6=${withMove} (${((100 * withMove) / Math.max(1, tested)).toFixed(0)}%) withMove@0.5=${withMove5}`,
	);
	console.log(
		withMove / Math.max(1, tested) >= 0.5 ? 'GATE: PASS' : 'GATE: FAIL',
	);
}

await main();
