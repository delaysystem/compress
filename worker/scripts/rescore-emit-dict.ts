// Offline rescore for the dict pilot (no API calls): re-decodes with the
// fixed codec, re-scores recall with reference grounding, fixes the p50,
// and recounts BOTH dict IRs and v1 IRs (same held-out half) in cl100k
// for an apples-to-apples ratio comparison.
// --translate-prefix <old> rewrites legacy-coded lines to the current wire
// format before decode (one-off for @code:-era rows; same codes, new prefix).
// --dict <name> selects the codebook (must match the run).
// --input <path> scores a different rows file (default emit-dict.jsonl).
// Run from worker/: node --experimental-strip-types scripts/rescore-emit-dict.ts [--translate-prefix @code:] [--dict dict-ir-v1]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_encoding } from 'tiktoken';
import { dictFromJson } from '../src/dict.ts';
import { classifyLine, prepareExpansion } from '../src/expander.ts';
import { percentile, scoreGroundedSample } from '../src/ireval.ts';
import { decodeV3, parseV3 } from '../src/wirev3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const enc = get_encoding('cl100k_base');
const count = (s: string): number => enc.encode(s).length;
const countCodes = (ir: string): number =>
	ir.split('\n').filter((l) => classifyLine(l.trim()) === 'code').length;

type Row = {
	key: string;
	irCoded: string;
	fullTokens?: number;
	liteTokens?: number | null;
	compTokens?: number | null;
	error: string | null;
	punt?: boolean;
	codeLines?: number;
	totalLines?: number;
	unknownCodes?: string[];
};

const dictFlag = process.argv.indexOf('--dict');
const dictName =
	dictFlag >= 0 ? (process.argv[dictFlag + 1] ?? 'dict-ir-v0') : 'dict-ir-v0';
const inputFlag = process.argv.indexOf('--input');
const inputName =
	inputFlag >= 0
		? (process.argv[inputFlag + 1] ?? 'emit-dict.jsonl')
		: 'emit-dict.jsonl';
const inputPath = inputName.startsWith('/')
	? inputName
	: join(root, 'data', 'derived', inputName);
const dict = dictFromJson(
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', `${dictName}.json`), 'utf8'),
	),
);
console.log(`dict: ${dict.version} entries=${dict.entries.length}`);
const isV3 = dict.version === 'ir-v3';
const markers: Record<string, string> = isV3
	? (
			JSON.parse(
				readFileSync(join(root, 'data', 'derived', 'marker-v3.json'), 'utf8'),
			) as { aliases: Record<string, string> }
		).aliases
	: {};
const countCodesV3or2 = (ir: string): number =>
	isV3
		? parseV3(ir, dict, markers).filter((s) => s.kind === 'code').length
		: countCodes(ir);
const countSegs = (ir: string): number =>
	isV3
		? parseV3(ir, dict, markers).length
		: ir.split('\n').filter((l) => l.trim()).length;
const rows = readFileSync(inputPath, 'utf8')
	.trim()
	.split('\n')
	.filter((l) => l.length > 0)
	.map((l) => JSON.parse(l) as Row);
const tpFlag = process.argv.indexOf('--translate-prefix');
const legacyPrefix = tpFlag >= 0 ? (process.argv[tpFlag + 1] ?? '') : '';
let translated = 0;
if (legacyPrefix.length > 0) {
	for (const r of rows) {
		const lines = r.irCoded.split('\n');
		const fixed = lines.map((ln) => {
			if (ln.trim().startsWith(legacyPrefix)) {
				translated++;
				return `${ln.slice(0, ln.indexOf(legacyPrefix))}%${ln.slice(ln.indexOf(legacyPrefix) + legacyPrefix.length)}`;
			}
			return ln;
		});
		r.irCoded = fixed.join('\n');
	}
	console.log(`translated ${translated} legacy lines`);
}
const v2 = readFileSync(
	join(root, 'data', 'derived', 'ir-pilot-v2.jsonl'),
	'utf8',
)
	.trim()
	.split('\n')
	.map(
		(l) =>
			JSON.parse(l) as {
				arm: string;
				key: string;
				reference: string;
				irLite: string;
			},
	)
	.filter((r) => r.arm === 'compress');
const refOf = new Map(v2.map((r) => [r.key, r.reference] as const));
const v1irOf = new Map(v2.map((r) => [r.key, r.irLite] as const));

const clean = rows.filter((r) => r.error === null && !r.punt);
const ratios: number[] = [];
const recalls: number[] = [];
const tikDict: number[] = [];
const tikV1: number[] = [];
let decodeFails = 0;
for (const r of clean) {
	let decoded: string;
	if (isV3) {
		const d = decodeV3(parseV3(r.irCoded, dict, markers), dict);
		if (!d.ok) {
			decodeFails++;
		}
		decoded = d.ok ? d.text : r.irCoded;
	} else {
		const prep = prepareExpansion(r.irCoded, {
			dict,
			dictVersion: dict.version,
			store: { version: 'eval-empty', documents: new Map() },
			kbVersion: 'eval-empty',
		});
		const ok = prep.ok && prep.value.expandedIr.trim() !== '';
		if (!ok) {
			decodeFails++;
		}
		decoded = ok ? prep.value.expandedIr : r.irCoded;
	}
	const ref = refOf.get(r.key) ?? '';
	// Token fallbacks (kernel rows lack provider counts): full from v2 or
	// cl100k recount; lite from provider usage, else cl100k recount.
	const fullTokens = r.fullTokens ?? count(ref);
	const liteTokens = r.liteTokens ?? r.compTokens ?? count(r.irCoded);
	const s = scoreGroundedSample(ref, decoded, ref, fullTokens, liteTokens);
	ratios.push(s.ratio);
	if (s.recall !== null) {
		recalls.push(s.recall);
	}
	tikDict.push(count(ref) / Math.max(1, count(r.irCoded)));
	const v1ir = v1irOf.get(r.key) ?? '';
	tikV1.push(count(ref) / Math.max(1, count(v1ir)));
}
ratios.sort((a, b) => a - b);
const summary = {
	n: clean.length,
	ratioP50: percentile(ratios, 0.5),
	ratioMean: ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length),
	recallMean: recalls.reduce((a, b) => a + b, 0) / Math.max(1, recalls.length),
	recallN: recalls.length,
	decodeFails,
	codeUseRate:
		clean.reduce((a, r) => a + (r.codeLines ?? countCodesV3or2(r.irCoded)), 0) /
		Math.max(
			1,
			clean.reduce((a, r) => a + (r.totalLines ?? countSegs(r.irCoded)), 0),
		),
	unknownCodeLines: clean.reduce(
		(a, r) => a + (r.unknownCodes?.length ?? 0),
		0,
	),
	tikDictP50: percentile(
		[...tikDict].sort((a, b) => a - b),
		0.5,
	),
	tikV1P50: percentile(
		[...tikV1].sort((a, b) => a - b),
		0.5,
	),
};
writeFileSync(
	join(root, 'data', 'derived', 'emit-dict-rescored.json'),
	`${JSON.stringify(summary, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 1));
enc.free();
