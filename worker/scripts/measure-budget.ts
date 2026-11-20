// End-to-end token + latency budget probe: emit IR then expand it on the
// same provider, recording provider usage (in/out/thinking) and wall time
// per stage, normalized per 100 reply-content tokens. Sequential calls, no
// pacer (small N). Cerebras-only for now (gpt-oss-120b default).
// Run from worker/: node --experimental-strip-types scripts/measure-budget.ts [limit] [--force] [--model <id>]
// Key: CEREBRAS_API_KEY from env (export from the agentcode .dev.vars).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CEREBRAS_API_KEY_NAME, CEREBRAS_BASE_URL } from '../src/config.ts';
import { dictFromJson, dictToPrompt } from '../src/dict.ts';
import {
	prepareExpansion,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';
import { OpenAIChatClient } from '../src/openai.ts';
import { autofixIr } from '../src/repair.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';
import { validateExpansion } from '../src/validator.ts';
import { autofixV3, decodeV3, encodeV3, parseV3 } from '../src/wirev3.ts';
import { buildStrictPrompt } from './lfm3-expand.ts';

const TEMPERATURE = 0;
const MAX_IR_TOKENS = 256;
const MAX_REPLY_TOKENS = 512;
/** gpt-oss rejects reasoning none (400; low is its floor); qwen takes none. Probed live. */

interface Stage {
	prompt: number;
	content: number;
	thinking: number;
	ms: number;
	finish: string;
}

interface BudgetRow {
	key: string;
	emit: Stage;
	expand: Stage;
	reply: string;
	irCoded: string;
	decodeOk: boolean;
	pass: boolean;
	error: string | null;
}

function flagValue(flag: string, def: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const model = flagValue('--model', 'gpt-oss-120b');
	const effort = flagValue('--effort', 'low');
	if (!['none', 'low', 'medium', 'high'].includes(effort)) {
		throw new Error(`--effort must be none|low|medium|high, got ${effort}`);
	}
	const dictFile = flagValue('--dict', 'dict-ir-v2.json');
	const promptFile = flagValue('--prompt', 'ir-emit-v6.md');
	if (dictFile.includes('/') || promptFile.includes('/')) {
		throw new Error('--dict/--prompt must be bare file names');
	}
	const dict = dictFromJson(
		JSON.parse(readFileSync(join(root, 'data', 'derived', dictFile), 'utf8')),
	);
	const base = readFileSync(join(here, '..', 'prompts', promptFile), 'utf8');
	if (!base.includes('[[CODEBOOK]]')) {
		throw new Error(`${promptFile} lacks [[CODEBOOK]] slot`);
	}
	const isV3 = dict.version === 'ir-v3';
	const promptHead = base.replace(
		'[[CODEBOOK]]',
		dictToPrompt(dict, { wire: isV3 ? 'v3' : 'bare' }),
	);
	const markers: Record<string, string> = isV3
		? (
				JSON.parse(
					readFileSync(join(root, 'data', 'derived', 'marker-v3.json'), 'utf8'),
				) as { aliases: Record<string, string> }
			).aliases
		: {};
	const v3codes = new Set(dict.entries.map((e) => e.code));
	const all = readFileSync(
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
					fullTokens: number;
				},
		)
		.filter((r) => r.arm === 'compress');
	const heldOut = all.slice(100, 200);
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : 5;
	// Longer refs so replies land near 100 tokens and normalization is ~1x.
	const samples = heldOut
		.filter((r) => (r.fullTokens ?? 0) >= 80)
		.slice(0, limit);
	const resolved = resolveSecret({
		name: CEREBRAS_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolved.resolution)} present=true`);
	console.log(`model: ${model} rows: ${samples.length}`);
	const client = new OpenAIChatClient({
		apiKey: resolved.value,
		baseUrl: CEREBRAS_BASE_URL,
		timeoutMs: 120_000,
	});
	const clean = (t: string): string => stripHarmony(stripThinkBlocks(t));
	const sleep = (ms: number): Promise<void> =>
		new Promise((r) => setTimeout(r, ms));
	const genWithRetry = async (prompt: string, maxTokens: number) => {
		for (let a = 0; a < 2; a++) {
			try {
				return await client.generate(model, prompt, {
					temperature: TEMPERATURE,
					maxOutputTokens: maxTokens,
					extraBody: { reasoning_effort: effort },
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (a === 0 && msg.includes('429')) {
					await sleep(30000);
					continue;
				}
				throw e;
			}
		}
		throw new Error('unreachable');
	};
	const rows: BudgetRow[] = [];
	for (const s of samples) {
		const row: BudgetRow = {
			key: s.key,
			emit: { prompt: 0, content: 0, thinking: 0, ms: 0, finish: '' },
			expand: { prompt: 0, content: 0, thinking: 0, ms: 0, finish: '' },
			reply: '',
			irCoded: '',
			decodeOk: false,
			pass: false,
			error: null,
		};
		try {
			const emitPrompt = `${promptHead}\n---\n\nREPLY TO COMPRESS:\n${s.reference}\n\nIR:`;
			const t0 = performance.now();
			const gen = await genWithRetry(emitPrompt, MAX_IR_TOKENS);
			row.emit.ms = Math.round(performance.now() - t0);
			row.emit.prompt = gen.usage?.promptTokens ?? 0;
			row.emit.thinking = gen.usage?.reasoningTokens ?? 0;
			row.emit.content = Math.max(
				0,
				(gen.usage?.candidatesTokens ?? 0) - row.emit.thinking,
			);
			row.emit.finish = gen.finishReason ?? '';
			const cleant = clean(gen.text);
			let decoded: string;
			if (isV3) {
				const f = autofixV3(parseV3(cleant, dict, markers), dict, markers);
				const d = decodeV3(f.segments, dict);
				if (!d.ok) {
					throw new Error(`decode: ${d.error}`);
				}
				row.decodeOk = true;
				row.irCoded = encodeV3(f.segments, v3codes);
				decoded = d.text;
			} else {
				const fixed = autofixIr(cleant, dict);
				const prep = prepareExpansion(fixed.ir, {
					dict,
					dictVersion: dict.version,
					store: { version: 'eval-empty', documents: new Map() },
					kbVersion: 'eval-empty',
				});
				if (!prep.ok) {
					throw new Error(`decode: ${prep.error.message}`);
				}
				row.decodeOk = true;
				row.irCoded = fixed.ir;
				decoded = prep.value.expandedIr;
			}
			const expandPrompt = buildStrictPrompt(decoded);
			const t1 = performance.now();
			const exp = await genWithRetry(expandPrompt, MAX_REPLY_TOKENS);
			row.expand.ms = Math.round(performance.now() - t1);
			row.expand.prompt = exp.usage?.promptTokens ?? 0;
			row.expand.thinking = exp.usage?.reasoningTokens ?? 0;
			row.expand.content = Math.max(
				0,
				(exp.usage?.candidatesTokens ?? 0) - row.expand.thinking,
			);
			row.expand.finish = exp.finishReason ?? '';
			row.reply = clean(exp.text);
			const v = validateExpansion({
				splicedIr: decoded,
				slotValues: [],
				output: row.reply,
				finishReason: row.expand.finish === 'STOP' ? 'STOP' : 'MAX_TOKENS',
			});
			row.pass = v.pass;
		} catch (e) {
			row.error = e instanceof Error ? e.message : String(e);
		}
		rows.push(row);
		await sleep(8000);
		console.log(
			`${s.key}: emit ${row.emit.ms}ms/${row.emit.content}tok/${row.emit.thinking}think expand ${row.expand.ms}ms/${row.expand.content}tok/${row.expand.thinking}think${row.error === null ? '' : ` ERROR ${row.error.slice(0, 100)}`}`,
		);
	}
	const jsonlPath = join(root, 'data', 'derived', 'cerebras-budget.jsonl');
	if (!process.argv.includes('--force')) {
		let existing = 0;
		try {
			existing = readFileSync(jsonlPath, 'utf8').length;
		} catch {
			existing = 0;
		}
		if (existing > 0) {
			throw new Error(`refusing to overwrite ${jsonlPath} without --force`);
		}
	}
	writeFileSync(
		jsonlPath,
		`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`,
	);
	const good = rows.filter((r) => r.error === null && r.decodeOk);
	const mean = (xs: number[]): number =>
		xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
	// Per-100 normalization scales every row to a 100-content-token reply.
	const scaled = good.map((r) => {
		const k = 100 / Math.max(1, r.expand.content);
		return {
			emitIn: r.emit.prompt * k,
			emitOut: r.emit.content * k,
			emitThink: r.emit.thinking * k,
			expIn: r.expand.prompt * k,
			expThink: r.expand.thinking * k,
		};
	});
	const per100 = {
		emitIn: mean(scaled.map((s) => s.emitIn)),
		emitOut: mean(scaled.map((s) => s.emitOut)),
		emitThink: mean(scaled.map((s) => s.emitThink)),
		expIn: mean(scaled.map((s) => s.expIn)),
		expOut: 100,
		expThink: mean(scaled.map((s) => s.expThink)),
	};
	const lat = (f: (r: BudgetRow) => number): number =>
		percentile(
			good.map(f).sort((a, b) => a - b),
			0.5,
		);
	const summary = {
		generatedAt: new Date().toISOString(),
		model,
		dict: dict.version,
		prompt: promptFile,
		n: good.length,
		errors: rows.length - good.length,
		passRate:
			good.length === 0
				? null
				: good.filter((r) => r.pass).length / good.length,
		meanReplyContentTokens: mean(good.map((r) => r.expand.content)),
		per100,
		totalPer100:
			per100.emitIn +
			per100.emitOut +
			per100.emitThink +
			per100.expIn +
			per100.expOut +
			per100.expThink,
		latencyP50ms: {
			emit: lat((r) => r.emit.ms),
			expand: lat((r) => r.expand.ms),
			total: lat((r) => r.emit.ms + r.expand.ms),
		},
	};
	writeFileSync(
		join(root, 'data', 'derived', 'cerebras-budget-summary.json'),
		`${JSON.stringify(summary, null, 2)}\n`,
	);
	console.log(JSON.stringify(summary, null, 1));
}

await main();
