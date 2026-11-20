// Hardening verification (runs 035/036): run the CURRENT validator over the
// banked LFM3 rows plus every historical passed expansion with a recoverable
// draft (lfm3/gemini/groq/nim). New checks must catch the banked fails and
// fire zero fails on historical good. Offline, deterministic. Run from worker/:
// node --experimental-strip-types scripts/lfm3-validate-baseline.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractEntities } from '../src/entities.ts';
import { validateExpansion } from '../src/validator.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const derived = join(root, 'data', 'derived');

interface Row {
	key: string;
	prepared: string;
	reply: string;
}

function readJsonl(name: string): Array<Record<string, unknown>> {
	return readFileSync(join(derived, name), 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// Drafts for the overlapping historical keys (same v2 IR set, one copy kept).
const irByKey = new Map<string, string>();
for (const r of readJsonl('lfm3-expand.jsonl')) {
	irByKey.set(str(r.key), str(r.ir));
}

const sources: Array<{ name: string; rows: Row[]; expectPass: boolean }> = [];
const banked: Row[] = readJsonl('lfm3-v3x-expand.jsonl').map((r) => ({
	key: str(r.key),
	prepared: str(r.prepared),
	reply: str(r.reply),
}));
sources.push({ name: 'banked-v3x', rows: banked, expectPass: false });
for (const f of ['lfm3-expand', 'gemini-expand', 'groq-expand', 'nim-expand']) {
	const rows: Row[] = [];
	for (const r of readJsonl(`${f}.jsonl`)) {
		if (r.pass !== true) {
			continue;
		}
		const draft =
			f === 'lfm3-expand' ? str(r.ir) : (irByKey.get(str(r.key)) ?? '');
		if (draft.length === 0) {
			continue;
		}
		rows.push({ key: str(r.key), prepared: draft, reply: str(r.reply) });
	}
	sources.push({ name: `${f}-passed`, rows, expectPass: true });
}

let fpFails = 0;
let fpWarns = 0;
for (const s of sources) {
	let fails = 0;
	let warns = 0;
	const failKeys: string[] = [];
	const warnKeys: string[] = [];
	for (const r of s.rows) {
		const slotValues = extractEntities(r.prepared).map((e) => e.raw);
		const v = validateExpansion({
			splicedIr: r.prepared,
			slotValues,
			output: r.reply,
			finishReason: 'stop',
		});
		if (!v.pass) {
			fails++;
			const failed = v.checks.filter((c) => !c.pass);
			failKeys.push(
				`${r.key}(${failed.map((c) => `${c.name}:${c.detail.slice(0, 40)}`).join('+')})`,
			);
			// Historical "pass" labels predate no-meta/no-greeting: a lone
			// draft-mention or greeting catch is known gap closure
			// (hand-verified genuine), not a false positive. Anything else
			// failing is a real FP.
			if (s.expectPass) {
				const gapClosure =
					failed.length === 1 &&
					((failed[0]?.name === 'no-meta' &&
						failed[0]?.detail === 'hits=draft-mention') ||
						failed[0]?.name === 'no-greeting');
				if (!gapClosure) {
					fpFails++;
				}
			}
		}
		if ((v.warnings ?? []).length > 0) {
			warns++;
			warnKeys.push(r.key);
		}
	}
	console.log(
		`${s.name}: n=${s.rows.length} fails=${fails} warns=${warns}` +
			(fails > 0 ? ` FAILKEYS=${failKeys.join(' ')}` : '') +
			(warns > 0 ? ` WARNKEYS=${warnKeys.join(' ')}` : ''),
	);
	if (s.expectPass) {
		fpWarns += warns;
	}
}
console.log(
	`historical-good structural false fails=${fpFails} warns=${fpWarns}`,
);
if (fpFails > 0) {
	process.exitCode = 1;
}
