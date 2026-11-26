// Validator pass rate on replies captured by latency-bench.ts, per run label.
// Applies the same model-output cleanup as expand() before validating.
// Run from worker/: node --experimental-strip-types scripts/quality-check.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	normalizeModelBraces,
	stripAnchorParrot,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { validateExpansion } from '../src/validator.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const rawPath = '/tmp/opencode/latency-results.jsonl.raw';
const prepared = new Map(
	readFileSync(
		join(root, 'data', 'derived', 'lfm3ftv13b-v3gem100.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.map((l) => JSON.parse(l) as { key: string; prepared: string })
		.map((r) => [r.key, r.prepared] as const),
);

interface Captured {
	key: string;
	text: string;
	error: string | null;
}
const lines = readFileSync(rawPath, 'utf8').trim().split('\n');
for (const line of lines) {
	const run = JSON.parse(line ?? '{}') as {
		label: string;
		results: Captured[];
	};
	const captured = (run.results ?? []).filter(
		(r) => r.error === null && typeof r.text === 'string',
	);
	if (captured.length === 0) continue;
	let pass = 0;
	const fails: string[] = [];
	for (const r of captured) {
		const draft = prepared.get(r.key) ?? '';
		const text = normalizeModelBraces(
			stripAnchorParrot(stripHarmony(stripThinkBlocks(r.text))),
			draft,
		);
		const v = validateExpansion({
			splicedIr: draft,
			slotValues: [],
			output: text,
			finishReason: 'STOP',
		});
		if (v.pass) pass++;
		else
			fails.push(
				`${r.key}: ${v.checks
					.filter((c) => !c.pass)
					.map((c) => c.name)
					.join(',')}`,
			);
	}
	console.log(
		JSON.stringify({ label: run.label, n: captured.length, pass, fails }),
	);
}
