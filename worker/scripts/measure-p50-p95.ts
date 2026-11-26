// Compute p50/p95 for system latency + compression ratio from recorded
// per-sample eval data (the same JSONL the eval summaries were built from).
// No network calls: re-measures offline from stored wall times / token counts.
// Run from worker/: node --experimental-strip-types scripts/measure-p50-p95.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { percentile } from '../src/ireval.ts';

interface EmitRow {
	key: string;
	ratio: number;
	fullTokens: number;
	liteTokens: number;
	wallMs: number;
	error: string | null;
}

interface ExpandRow {
	key: string;
	wallMs: number;
	promptTokens: number;
	completionTokens: number;
	error: string | null;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dir = join(root, 'data', 'derived');

function load<T>(file: string): T[] {
	return readFileSync(join(dir, file), 'utf8')
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as T);
}

/** Project convention: sorted index = floor(p * n), clamped (ireval.percentile). */
function p50(xs: number[]): number {
	return xs.length === 0
		? NaN
		: percentile(
				[...xs].sort((a, b) => a - b),
				0.5,
			);
}
function p95(xs: number[]): number {
	return xs.length === 0
		? NaN
		: percentile(
				[...xs].sort((a, b) => a - b),
				0.95,
			);
}
const mean = (xs: number[]): number =>
	xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
const n2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const ms = (v: number): string =>
	Number.isFinite(v) ? String(Math.round(v)) : 'n/a';

interface Report {
	name: string;
	emitFile: string;
	expandFile: string;
}

const reports: Report[] = [
	{
		name: 'v3 emitter + LFM3 v13b expander (100 matched rows)',
		emitFile: 'emit-v3gem100.jsonl',
		expandFile: 'lfm3ftv13b-v3gem100.jsonl',
	},
	{
		name: 'v3x wire emitter + LFM3 expander (25 matched rows)',
		emitFile: 'emit-v3xling25.jsonl',
		expandFile: 'lfm3-v3x-expand.jsonl',
	},
];

for (const r of reports) {
	const emit = load<EmitRow>(r.emitFile).filter(
		(x) => x.error === null && Number.isFinite(x.ratio) && x.ratio > 0,
	);
	const expand = load<ExpandRow>(r.expandFile).filter(
		(x) => x.error === null && Number.isFinite(x.wallMs) && x.wallMs > 0,
	);
	const expandByKey = new Map(expand.map((x) => [x.key, x]));
	const matched = emit.filter((x) => expandByKey.has(x.key));
	const ratios = matched.map((x) => x.ratio);
	const emitMs = matched.map((x) => x.wallMs);
	const expMs = matched.map((x) => expandByKey.get(x.key)?.wallMs ?? 0);
	const totalMs = matched.map((x, i) => x.wallMs + (expMs[i] ?? 0));

	console.log(`\n=== ${r.name} ===`);
	console.log(
		`emit=${r.emitFile}  expand=${r.expandFile}  matched N=${matched.length}`,
	);
	console.log('Compression ratio (fullTokens / IR tokens, lite tokenizer):');
	console.log(
		`  p50 = ${n2(p50(ratios))}x   p95 = ${n2(p95(ratios))}x   mean = ${n2(mean(ratios))}x`,
	);
	console.log('Latency (ms):');
	console.log(`  emit   p50 = ${ms(p50(emitMs))}   p95 = ${ms(p95(emitMs))}`);
	console.log(`  expand p50 = ${ms(p50(expMs))}   p95 = ${ms(p95(expMs))}`);
	console.log(`  total  p50 = ${ms(p50(totalMs))}   p95 = ${ms(p95(totalMs))}`);
}
