// Offline pilot runner (PLAN.md Step 1): mines Bitext responses, writes
// data/derived/bitext-mining.json + dict-v0.json.
// Run from worker/: node --experimental-strip-types scripts/mine-bitext.ts
// Uses csv-parse (devDep): correct multiline-quoted CSV parsing; stdlib has none.
// All figures are word-unit PROXIES until countTokens re-measures them.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { DICT_MIN_SUPPORT } from '../src/config.ts';
import {
	countWords,
	coverageCurve,
	exactDuplicates,
	mineTemplates,
} from '../src/mining.ts';

/** Assumed output/input price ratio. Origin: research price book, Nov 2026 — re-verify at build. */
const PRICE_RATIO_PROXY = 4;

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');
const rows = parse(
	readFileSync(join(dataDir, 'bitext', 'bitext-27k.csv'), 'utf8'),
	{
		columns: true,
		skip_empty_lines: true,
	},
) as Array<Record<string, string>>;
const responses = rows.map((r) => r.response ?? '').filter((s) => s.length > 0);
const totalWords = responses.reduce((s, t) => s + countWords(t), 0);

const exact = exactDuplicates(responses);
const exactCovered = exact.reduce(
	(s, g) => s + countWords(g.text) * g.count,
	0,
);
const templates = mineTemplates(responses, { minSupport: DICT_MIN_SUPPORT });
const curve = coverageCurve(templates, totalWords, [10, 25, 50, 100, 200, 500]);

const outDir = join(dataDir, 'derived');
mkdirSync(outDir, { recursive: true });

const dict = {
	version: 'bitext-v0',
	source: 'Bitext 26.9k responses; mined offline; PROXY (not staging logs)',
	entries: templates.map((t, i) => ({
		code: `t${i + 1}`,
		template: t.skeleton,
		slots: t.slots,
	})),
};
writeFileSync(
	join(outDir, 'dict-v0.json'),
	`${JSON.stringify(dict, null, 2)}\n`,
);

const s100 = curve.find((p) => p.k === 100)?.grossSavedWords ?? 0;
const perTurn = responses.length > 0 ? s100 / responses.length : 0;
const report = {
	generatedAt: new Date().toISOString(),
	corpus: { rows: responses.length, totalWords },
	exactDuplicates: {
		groups: exact.length,
		coveredWords: exactCovered,
		coverage: totalWords > 0 ? exactCovered / totalWords : 0,
	},
	templatesFound: templates.length,
	top: templates.slice(0, 50).map((t) => ({
		skeleton: t.skeleton,
		slots: t.slots,
		count: t.count,
		fixedWords: t.fixedWords,
		savedWords: t.savedWords,
		example: t.examples[0] ?? '',
	})),
	curve,
	breakEvenWordProxy: {
		assumedPriceRatio: PRICE_RATIO_PROXY,
		basis:
			'top-100 savings PER TURN (corpus gross / responses); word units, NOT tokens',
		savedWordsPerTurnTop100: perTurn,
		byCallsPerAnswer: [1, 2, 3, 5].map((k) => ({
			k,
			maxDictWords: Math.floor((perTurn * PRICE_RATIO_PROXY) / k),
		})),
	},
	limits: [
		'Naive sentence splitter; paraphrase variation stays split by design.',
		'Word units throughout; token re-measurement via countTokens pending.',
		'Bitext is synthetic/curated, not staging traffic: prize is directional.',
	],
};
writeFileSync(
	join(outDir, 'bitext-mining.json'),
	`${JSON.stringify(report, null, 2)}\n`,
);

console.log(`responses=${responses.length} totalWords=${totalWords}`);
console.log(
	`exactDup groups=${exact.length} coverage=${(exactCovered / totalWords).toFixed(3)}`,
);
console.log(`templates(minSupport=${DICT_MIN_SUPPORT})=${templates.length}`);
for (const p of curve) {
	console.log(
		`top-${p.k}: entries=${p.entries} coverage=${p.coverage.toFixed(3)} saved=${p.grossSavedWords}`,
	);
}
console.log(
	`dict-v0 entries=${dict.entries.length} -> data/derived/dict-v0.json`,
);
