// Deterministic v3 wire assignment (run 036+): UPPERCASE 2-letter
// single-token separators for the 46 v2 intents + compositional marker
// table. Uppercase is a case barrier: lowercase payload words (to/of/in)
// can never collide with separators, so common words parse as payload
// with no violation, no fix, no noise. All choices verified, none
// hand-picked: inventory from cl100k, exclusions from corpus uppercase
// pairs + common capped pairs, assignment same-first-letter-first
// (mnemonic) with sorted fallback. Re-running reproduces the files
// byte-for-byte (modulo JSON key order, fixed here).
// Run from worker/: node --experimental-strip-types scripts/assign-v3-separators.ts
// Outputs: data/derived/dict-ir-v3.json, marker-v3.json, v2-to-v3.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_encoding } from 'tiktoken';

/** Common capped two-letter tokens, kept out of the separator set even
 * when the corpus happens to miss them. */
const WORD_STOPLIST = new Set(
	'TV AI US UK ID OK AM PM FM EU UN OS IP AA AC DC PC'.split(' '),
);

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const enc = get_encoding('cl100k_base');
const count = (s: string): number => enc.encode(s).length;

// 1. Single-token inventory: space-prefixed 2-letter combos, cl100k.
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const inventory: string[] = [];
for (const a of letters) {
	for (const b of letters) {
		if (count(` ${a}${b}`) === 1) {
			inventory.push(`${a}${b}`);
		}
	}
}
console.log(`inventory: ${inventory.length}/676 single-token`);

// 2. Exclusions: corpus uppercase pairs + stoplist. v2 codes are
// lowercase and cannot collide (case differs), so they stay eligible.
const v2 = JSON.parse(
	readFileSync(join(root, 'data', 'derived', 'dict-ir-v2.json'), 'utf8'),
) as {
	version: string;
	entries: Array<{ code: string; template: string; slots: string[] }>;
};
const excluded = new Set<string>([...WORD_STOPLIST]);
const corpusText =
	readFileSync(join(root, 'data', 'derived', 'ir-pilot-v2.jsonl'), 'utf8') +
	readFileSync(join(root, 'data', 'derived', 'emit-dict-v8.jsonl'), 'utf8');
for (const w of corpusText.match(/[A-Za-z]{2}/g) ?? []) {
	if (/^[A-Z]{2}$/.test(w)) {
		excluded.add(w);
	}
}
const free = inventory.filter((c) => !excluded.has(c));
console.log(`excluded: ${excluded.size}, survivors: ${free.length}`);
if (free.length < 100) {
	throw new Error(`separator margin too thin: ${free.length}`);
}

// 3. Marker table: multi-word markers -> lowernospace form (decoder
// restores); single-word markers stay verbatim. Closed-set verified at
// assignment time against every reference in the corpus.
const refText = readFileSync(
	join(root, 'data', 'derived', 'ir-pilot-v2.jsonl'),
	'utf8',
);
const markers = [...new Set(refText.match(/\{\{[^}]+\}\}/g) ?? [])].sort();
const aliases: Record<string, string> = {};
const verbatim: string[] = [];
for (const m of markers) {
	const inner = m.slice(2, -2);
	if (!inner.includes(' ')) {
		verbatim.push(m);
		continue;
	}
	const form = inner.toLowerCase().replace(/ /g, '');
	if (form in aliases) {
		throw new Error(`alias collision: ${form} for ${m} and ${aliases[form]}`);
	}
	aliases[form] = m;
}
console.log(
	`markers: ${markers.length} (${Object.keys(aliases).length} aliased, ${verbatim.length} verbatim)`,
);

// 4. Assignment: same first letter (sorted) else first free (sorted).
const taken = new Set<string>();
// 47th entry: TX identity code (template {t}) carries free text. v2's
// 14 non-code lines are 11 strays (impossible in v3) + 3 real text
// lines, so the hatch must exist. Prefer literal TX when free.
const v3entries = v2.entries.map((e) => {
	const same = free
		.filter((c) => c[0] === (e.code[0] ?? '').toUpperCase() && !taken.has(c))
		.sort();
	const pick = same[0] ?? free.filter((c) => !taken.has(c)).sort()[0];
	if (pick === undefined) {
		throw new Error(`no separator left for ${e.code}`);
	}
	taken.add(pick);
	return { code: pick, template: e.template, slots: e.slots, v2code: e.code };
});
const textPick =
	!taken.has('TX') && free.includes('TX')
		? 'TX'
		: free.filter((c) => !taken.has(c)).sort()[0];
if (textPick === undefined) {
	throw new Error('no separator left for TX');
}
taken.add(textPick);
v3entries.push({
	code: textPick,
	template: '{t}',
	slots: ['t'],
	v2code: '*text*',
});
console.log(`text identity: *text* -> ${textPick}`);
const derived = join(root, 'data', 'derived');
writeFileSync(
	join(derived, 'dict-ir-v3.json'),
	`${JSON.stringify(
		{
			version: 'ir-v3',
			entries: v3entries.map(({ code, template, slots }) => ({
				code,
				template,
				slots,
			})),
		},
		null,
		2,
	)}\n`,
);
writeFileSync(
	join(derived, 'marker-v3.json'),
	`${JSON.stringify({ version: 'marker-v3', aliases, verbatim }, null, 2)}\n`,
);
writeFileSync(
	join(derived, 'v2-to-v3.json'),
	`${JSON.stringify(
		Object.fromEntries(v3entries.map((e) => [e.v2code, e.code])),
		null,
		2,
	)}\n`,
);
console.log('assigned:');
for (const e of v3entries) {
	console.log(`  ${e.v2code} -> ${e.code}`);
}
enc.free();
