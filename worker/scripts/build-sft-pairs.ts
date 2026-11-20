// SFT pair builder (run 047): (expansion-prompt(draft) -> reply) pairs for
// LFM3 LoRA tuning. Prompts use the REAL buildExpansionPrompt (anchor
// included), byte-identical to serve time. Targets: references (flagship
// voice) + banked validator-clean LFM3 replies (self-distillation).
// Outputs data/sft/expand-train.jsonl + expand-eval.jsonl (draft-disjoint).
// Run from worker/: node --experimental-strip-types scripts/build-sft-pairs.ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffCountedEntities, extractEntities } from '../src/entities.ts';
import { buildExpansionPrompt } from '../src/expander.ts';
import { buildRepairHint } from '../src/ladder.ts';
import { validateExpansion } from '../src/validator.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const derived = join(root, 'data', 'derived');
const outDir = join(root, 'data', 'sft');

interface Banked {
	key: string;
	prepared: string;
	reply: string;
	finish: string;
}

function readJsonl(name: string): Banked[] {
	return readFileSync(join(derived, name), 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Banked);
}

const refs = new Map<string, string>();
for (const line of readFileSync(join(derived, 'ir-pilot-v2.jsonl'), 'utf8')
	.split('\n')
	.filter((l) => l.trim().length > 0)) {
	const r = JSON.parse(line) as { key: string; reference: string };
	refs.set(r.key, r.reference);
}

interface Pair {
	key: string;
	source: string;
	messages: Array<{ role: string; content: string }>;
}

const pairs: Pair[] = [];
const seen = new Set<string>();
function addPair(
	key: string,
	source: string,
	prepared: string,
	target: string,
): void {
	const id = `${key}\0${source}`;
	if (seen.has(id)) {
		return;
	}
	seen.add(id);
	pairs.push({
		key,
		source,
		messages: [
			{ role: 'user', content: buildExpansionPrompt(prepared) },
			{ role: 'assistant', content: target },
		],
	});
}

for (const [file, tag, refOk] of [
	['lfm3-v3x-expand.jsonl', 'v3x25', true],
	['lfm3-v3gem100-anch.jsonl', 'v3gem100', true],
	['lfm3ftv12-v3gem100.jsonl', 'v12gem100', false],
	['lfm3ftv12-v3fresh25.jsonl', 'v12fresh25', false],
] as const) {
	for (const r of readJsonl(file)) {
		const ref = refs.get(r.key);
		// Entity-faithful references only: 26/125 refs drop draft entities
		// (template boilerplate the IR adds), and training on them teaches
		// dropping (run 047 v1: entity fails 13->32). Single copy only:
		// duplicating the same refs (run 058 v13: 43% refs) teaches
		// verbose bitext voice with extras (66/100 direct).
		if (
			refOk &&
			ref !== undefined &&
			ref.trim().length > 0 &&
			diffCountedEntities(extractEntities(r.prepared), extractEntities(ref))
				.missing.length === 0
		) {
			addPair(r.key, `ref-${tag}`, r.prepared, ref);
		}
		const v = validateExpansion({
			splicedIr: r.prepared,
			slotValues: extractEntities(r.prepared).map((e) => e.raw),
			output: r.reply,
			finishReason: r.finish,
		});
		if (v.pass && (v.warnings ?? []).length === 0) {
			addPair(r.key, `self-${tag}`, r.prepared, r.reply);
		}
	}
}

// Qwen gold replies for tuned-model fails (validator-clean only).
for (const [file, tag] of [
	['qwen-gold-21.jsonl', 'gold-qwen'],
	['qwen-gold-v13.jsonl', 'gold-qwen-v13'],
] as const) {
	for (const line of readFileSync(join(derived, file), 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)) {
		const r = JSON.parse(line) as {
			key: string;
			prepared: string;
			reply: string;
		};
		const v = validateExpansion({
			splicedIr: r.prepared,
			slotValues: extractEntities(r.prepared).map((e) => e.raw),
			output: r.reply,
			finishReason: 'STOP',
		});
		if (v.pass && (v.warnings ?? []).length === 0) {
			addPair(r.key, tag, r.prepared, r.reply);
		} else {
			console.log(
				`gold SKIP ${r.key}: ${v.checks
					.filter((c) => !c.pass)
					.map((c) => c.name)
					.join('+')}`,
			);
		}
	}
}

// Repair-following pairs (run 056): prompts carry the real REPAIR hint
// the ladder would send for the banked fail, targets are the repaired
// replies. Teaches hint-following explicitly (v12 does 25-33% zero-shot).
{
	let n = 0;
	for (const line of readFileSync(
		join(derived, 'repair-fixed-v13.jsonl'),
		'utf8',
	)
		.split('\n')
		.filter((l) => l.trim().length > 0)) {
		const r = JSON.parse(line) as {
			key: string;
			prepared: string;
			reply: string;
		};
		const banked = readJsonl('lfm3ftv12-v3gem100.jsonl').find(
			(b) => b.key === r.key,
		);
		if (banked === undefined) {
			continue;
		}
		const hint = buildRepairHint(
			validateExpansion({
				splicedIr: r.prepared,
				slotValues: extractEntities(r.prepared).map((e) => e.raw),
				output: banked.reply,
				finishReason: banked.finish,
			}),
		);
		pairs.push({
			key: `${r.key}-repair`,
			source: 'repair-hint',
			messages: [
				{ role: 'user', content: buildExpansionPrompt(r.prepared, hint) },
				{ role: 'assistant', content: r.reply },
			],
		});
		n += 1;
	}
	console.log(`repair pairs=${n}`);
}

// Synthetic verbatim-copy drills (run 048): the tuned model demotes
// placeholders to prose ("your order number" for {{Order Number}}).
// Minimal draft->reply pairs over the real placeholder vocabulary,
// each self-validated (only validator-clean drills ship).
{
	const aliases = (
		JSON.parse(readFileSync(join(derived, 'marker-v3.json'), 'utf8')) as {
			aliases: Record<string, string>;
		}
	).aliases;
	const placeholders = [...new Set(Object.values(aliases))].sort();
	const numbers = ['3-7 business days', '1-3 business days', '42', 'Feb 25'];
	let n = 0;
	const drill = (draft: string, reply: string): void => {
		const v = validateExpansion({
			splicedIr: draft,
			slotValues: extractEntities(draft).map((e) => e.raw),
			output: reply,
			finishReason: 'STOP',
		});
		if (v.pass && (v.warnings ?? []).length === 0) {
			n += 1;
			addPair(`drill-${String(n).padStart(3, '0')}`, 'drill', draft, reply);
		}
	};
	for (const e of placeholders) {
		// Never identity pairs: reply must reframe (echo teaches echoing).
		drill(`Code: ${e}.`, `Your code is ${e}.`);
		drill(`Provide ${e} to continue.`, `Please provide ${e} to continue.`);
	}
	for (let i = 0; i + 1 < placeholders.length; i += 2) {
		const a = placeholders[i] as string;
		const b = placeholders[i + 1] as string;
		drill(`Need ${a}, ${b}.`, `We need ${a} and ${b} to proceed.`);
	}
	for (const num of numbers) {
		drill(`Arrives ${num}.`, `Your order arrives in ${num}.`);
	}
	console.log(`drills kept=${n}`);
}

// Draft-disjoint split: hold out every 5th key (sorted) for eval.
const keys = [...new Set(pairs.map((p) => p.key))].sort();
const evalKeys = new Set(keys.filter((_, i) => i % 5 === 4));
const train = pairs.filter((p) => !evalKeys.has(p.key));
const evalRows = pairs.filter((p) => evalKeys.has(p.key));
mkdirSync(outDir, { recursive: true });
writeFileSync(
	join(outDir, 'expand-train.jsonl'),
	`${train.map((p) => JSON.stringify(p)).join('\n')}\n`,
);
writeFileSync(
	join(outDir, 'expand-eval.jsonl'),
	`${evalRows.map((p) => JSON.stringify(p)).join('\n')}\n`,
);
const bySource: Record<string, number> = {};
for (const p of pairs) {
	bySource[p.source] = (bySource[p.source] ?? 0) + 1;
}
console.log(
	`pairs=${pairs.length} train=${train.length} eval=${evalRows.length} keys=${keys.length} evalKeys=${evalKeys.size}`,
);
console.log(`bySource=${JSON.stringify(bySource)}`);
