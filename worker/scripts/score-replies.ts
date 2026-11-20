// Score a kernel replies file (key/reply/finish/error rows) with the product
// validator, reusing the exact prepare+strip+validate path the live evals use.
// Samples are the identical 45 (LFM3 row files), matched by key.
//
// Run from worker/:
//   node --experimental-strip-types scripts/score-replies.ts <replies.jsonl> [label] [--group <field>]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	prepareExpansion,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { validateExpansion } from '../src/validator.ts';

type Reply = {
	key: string;
	reply: string;
	finish: string;
	error: string | null;
};

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const file = process.argv[2];
if (!file) {
	throw new Error('usage: score-replies.ts <replies.jsonl> [label]');
}
const label = process.argv[3] ?? file;
const groupFlag = process.argv.indexOf('--group');
const groupField = groupFlag >= 0 ? process.argv[groupFlag + 1] : null;
if (groupFlag >= 0 && !groupField) {
	throw new Error('--group needs a field name');
}
const samples = new Map<string, string>();
for (const name of ['lfm3-expand.jsonl', 'lfm3-expand-v3.jsonl']) {
	for (const line of readFileSync(join(root, 'data', 'derived', name), 'utf8')
		.trim()
		.split('\n')) {
		const row = JSON.parse(line) as { key: string; ir: string };
		if (!samples.has(row.key)) {
			samples.set(row.key, row.ir);
		}
	}
}
const replies = readFileSync(file, 'utf8')
	.trim()
	.split('\n')
	.map((l) => JSON.parse(l) as Reply);
let pass = 0;
const checkFails = new Map<string, number>();
const failing: string[] = [];
const finishes = new Map<string, number>();
const groups = new Map<string, { pass: number; total: number }>();
for (const r of replies) {
	finishes.set(r.finish || 'ERR', (finishes.get(r.finish || 'ERR') ?? 0) + 1);
	const g = groupField
		? String((r as unknown as Record<string, unknown>)[groupField] ?? 'none')
		: 'all';
	let rec = groups.get(g);
	if (!rec) {
		rec = { pass: 0, total: 0 };
		groups.set(g, rec);
	}
	rec.total++;
	const tag = groupField ? ` {${g}}` : '';
	const fail = (why: string) => {
		failing.push(`${r.key}${tag} [${why}]`);
	};
	if (r.error) {
		fail(`row-error: ${r.error.slice(0, 60)}`);
		continue;
	}
	const ir = samples.get(r.key);
	if (ir === undefined) {
		fail('no-sample');
		continue;
	}
	const prepared = prepareExpansion(ir, {
		dict: { version: 'eval-empty', entries: [] },
		dictVersion: 'eval-empty',
		store: { version: 'eval-empty', documents: new Map() },
		kbVersion: 'eval-empty',
	});
	if (!prepared.ok) {
		fail(`prepare: ${prepared.error.message}`);
		continue;
	}
	const v = validateExpansion({
		splicedIr: prepared.value.expandedIr,
		slotValues: [],
		output: stripThinkBlocks(stripHarmony(r.reply)),
		finishReason: r.finish === 'stop' ? 'STOP' : 'MAX_TOKENS',
	});
	if (v.pass) {
		pass++;
		rec.pass++;
	} else {
		const bad = v.checks.filter((c) => !c.pass).map((c) => c.name);
		for (const b of bad) {
			checkFails.set(b, (checkFails.get(b) ?? 0) + 1);
		}
		fail(bad.join(','));
	}
}
console.log(`--- ${label} ---`);
console.log(`pass: ${pass}/${replies.length}`);
if (groupField) {
	for (const [name, s] of [...groups.entries()].sort()) {
		console.log(`group ${name}: ${s.pass}/${s.total}`);
	}
}
console.log(
	`check fails: ${[...checkFails.entries()].map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`,
);
console.log(
	`finishes: ${[...finishes.entries()].map(([k, n]) => `${k}=${n}`).join(' ')}`,
);
for (const f of failing.slice(0, 12)) {
	console.log(`FAIL ${f}`);
}
if (failing.length > 12) {
	console.log(`... +${failing.length - 12} more`);
}
