// Probe all configured AI providers (4 existing + 7 new .dev.vars + local)
// and measure decompression latency per stage in baseline or reshaped mode.
// Run from worker/:
//   node --experimental-strip-types scripts/measure-stages.ts --mode baseline --n 20
//   node --experimental-strip-types scripts/measure-stages.ts --mode reshaped --n 20

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpansionCache } from '../src/cache.ts';
import { dictFromJson } from '../src/dict.ts';
import {
	buildExpansionPrompt,
	expand,
	normalizeModelBraces,
	stripAnchorParrot,
	stripFramingLeaks,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';
import { buildRepairHint, buildStyleHint, runLadder } from '../src/ladder.ts';
import { NO_THINK_EXTRA_BODY, OpenAIChatClient } from '../src/openai.ts';
import {
	ALL_PROVIDER_CONFIGS,
	type ProviderConfig,
	type ProviderEntry,
	ProviderPool,
} from '../src/providers.ts';
import { tryFastRealize } from '../src/realizer.ts';
import { readEnvFile } from '../src/secrets.ts';
import { validateExpansion } from '../src/validator.ts';
import { autofixV3, decodeV3, parseV3 } from '../src/wirev3.ts';
import { wrapReply } from '../src/wrapper.ts';

function flag(name: string, def: string): string {
	const i = process.argv.indexOf(name);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

const mode = flag('--mode', 'baseline') as 'baseline' | 'reshaped';
const n = Number(flag('--n', '20'));
const probeOnly = process.argv.includes('--probe-only');

interface ProbeResult {
	id: string;
	baseUrl: string;
	hasKey: boolean;
	ok: boolean;
	modelsStatus: number | null;
	modelsCount: number;
	selectedModel: string;
	rttMs: number | null;
	error: string | null;
}

const FAST_MODEL_PREFERENCES = [
	/llama-3\.1-8b/i,
	/llama3\.1-8b/i,
	/gemma/i,
	/qwen3.*(8b|14b|27b|30b|32b)/i,
	/typhoon.*30b/i,
	/mistral-small/i,
	/gpt-4o-mini/i,
	/flash/i,
	/mini/i,
	/lite/i,
	/small/i,
	/free/i,
	/auto/i,
];

function pickFastModel(models: string[], fallback: string): string {
	if (models.length === 0) {
		return fallback;
	}
	if (models.includes(fallback)) {
		return fallback;
	}
	for (const re of FAST_MODEL_PREFERENCES) {
		const hit = models.find(
			(m) => re.test(m) && !/embed|whisper|tts|vision/i.test(m),
		);
		if (hit !== undefined) {
			return hit;
		}
	}
	const chatLike = models.find(
		(m) => !/embed|whisper|tts|rerank|guard/i.test(m),
	);
	return chatLike ?? models[0] ?? fallback;
}

async function probeProvider(
	cfg: ProviderConfig,
	apiKey: string | undefined,
): Promise<{ probe: ProbeResult; entry?: ProviderEntry }> {
	if (apiKey === undefined || apiKey.length === 0) {
		return {
			probe: {
				id: cfg.id,
				baseUrl: cfg.baseUrl,
				hasKey: false,
				ok: false,
				modelsStatus: null,
				modelsCount: 0,
				selectedModel: cfg.defaultModel,
				rttMs: null,
				error: 'missing key',
			},
		};
	}

	let modelsStatus: number | null = null;
	const listedModels: string[] = [];
	const base = cfg.baseUrl.replace(/\/$/, '');

	try {
		const res = await fetch(`${base}/models`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(6000),
		});
		modelsStatus = res.status;
		if (res.ok) {
			const data = (await res.json()) as {
				data?: Array<{ id?: unknown }>;
			};
			for (const m of data.data ?? []) {
				if (typeof m.id === 'string' && m.id.length > 0) {
					listedModels.push(m.id);
				}
			}
		}
	} catch {
		// /models may be unsupported or blocked; continue to chat completion probe.
	}

	const candidateModels = [
		pickFastModel(listedModels, cfg.defaultModel),
		cfg.defaultModel,
		...listedModels.slice(0, 3),
	].filter((m, idx, arr) => m.length > 0 && arr.indexOf(m) === idx);

	const client = new OpenAIChatClient({
		apiKey,
		baseUrl: cfg.baseUrl,
		timeoutMs: 12_000,
	});

	let lastError = 'no candidate model succeeded';
	for (const model of candidateModels) {
		const t0 = performance.now();
		try {
			const r = await client.chat(
				model,
				[{ role: 'user', content: 'Reply with the single word OK.' }],
				{
					temperature: 0,
					maxOutputTokens: 16,
					...(cfg.extraBody === undefined ? {} : { extraBody: cfg.extraBody }),
				},
			);
			const rttMs = Math.round(performance.now() - t0);
			if (r.text.trim().length === 0 && r.finishReason === null) {
				lastError = `empty response (${model})`;
				continue;
			}
			const tunedCfg: ProviderConfig = { ...cfg, defaultModel: model };
			return {
				probe: {
					id: cfg.id,
					baseUrl: cfg.baseUrl,
					hasKey: true,
					ok: true,
					modelsStatus,
					modelsCount: listedModels.length,
					selectedModel: model,
					rttMs,
					error: null,
				},
				entry: { config: tunedCfg, client },
			};
		} catch (e) {
			lastError =
				`${model}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 140);
		}
	}

	return {
		probe: {
			id: cfg.id,
			baseUrl: cfg.baseUrl,
			hasKey: true,
			ok: false,
			modelsStatus,
			modelsCount: listedModels.length,
			selectedModel: candidateModels[0] ?? cfg.defaultModel,
			rttMs: null,
			error: lastError,
		},
	};
}

interface RowTimings {
	key: string;
	path: string;
	ok: boolean;
	provider: string;
	parseDecodeMs: number;
	fastPathMs: number;
	cacheMs: number;
	buildPromptMs: number;
	llmExpandMs: number;
	postProcessMs: number;
	validateMs: number;
	repairMs: number;
	wrapMs: number;
	totalMs: number;
	error: string | null;
}

function summarizeStage(values: number[]): {
	p50: number;
	p95: number;
	mean: number;
} {
	if (values.length === 0) {
		return { p50: 0, p95: 0, mean: 0 };
	}
	const sorted = [...values].sort((a, b) => a - b);
	const round2 = (x: number): number => Math.round(x * 100) / 100;
	return {
		p50: round2(percentile(sorted, 0.5)),
		p95: round2(percentile(sorted, 0.95)),
		mean: round2(values.reduce((a, b) => a + b, 0) / values.length),
	};
}

async function runBaselineRow(
	row: { key: string; irCoded: string },
	dict: ReturnType<typeof dictFromJson>,
	markers: Record<string, string>,
	pool: ProviderPool,
): Promise<RowTimings> {
	const totalT0 = performance.now();
	const rec: RowTimings = {
		key: row.key,
		path: 'error',
		ok: false,
		provider: 'none',
		parseDecodeMs: 0,
		fastPathMs: 0,
		cacheMs: 0,
		buildPromptMs: 0,
		llmExpandMs: 0,
		postProcessMs: 0,
		validateMs: 0,
		repairMs: 0,
		wrapMs: 0,
		totalMs: 0,
		error: null,
	};

	try {
		const tParse0 = performance.now();
		const segs = parseV3(row.irCoded, dict, markers);
		const fixed = autofixV3(segs, dict);
		const decoded = decodeV3(fixed.segments, dict);
		rec.parseDecodeMs = performance.now() - tParse0;
		if (!decoded.ok) {
			throw new Error(`decode: ${decoded.error}`);
		}
		const preparedIr = decoded.text;

		const tPrompt0 = performance.now();
		const prompt = buildExpansionPrompt(preparedIr);
		rec.buildPromptMs = performance.now() - tPrompt0;

		const tLlm0 = performance.now();
		const res1 = await pool.generate('auto', prompt, {
			temperature: 0,
			maxOutputTokens: 512,
			extraBody: NO_THINK_EXTRA_BODY,
		});
		rec.llmExpandMs = performance.now() - tLlm0;
		rec.provider = pool.lastProvider ?? 'unknown';

		const tPost0 = performance.now();
		const cleaned1 = normalizeModelBraces(
			stripAnchorParrot(stripThinkBlocks(stripHarmony(res1.text))),
			preparedIr,
		);
		rec.postProcessMs = performance.now() - tPost0;

		const tVal0 = performance.now();
		const v1 = validateExpansion({
			splicedIr: preparedIr,
			slotValues: [],
			output: cleaned1,
			finishReason: res1.finishReason,
		});
		rec.validateMs = performance.now() - tVal0;

		let finalOutput = cleaned1;
		let finalPath = 'direct';
		let finalOk = v1.pass;

		const hasStyleWarn = (v1.warnings ?? []).some((w) =>
			w.startsWith('terse-mirror'),
		);

		if (!v1.pass || hasStyleWarn) {
			const tRep0 = performance.now();
			const hint = !v1.pass
				? buildRepairHint(v1)
				: buildStyleHint(v1.warnings ?? []);
			const repPrompt = buildExpansionPrompt(preparedIr, hint);
			const res2 = await pool.generate('auto', repPrompt, {
				temperature: 0,
				maxOutputTokens: 512,
				extraBody: NO_THINK_EXTRA_BODY,
			});
			const cleaned2 = normalizeModelBraces(
				stripAnchorParrot(stripThinkBlocks(stripHarmony(res2.text))),
				preparedIr,
			);
			const v2 = validateExpansion({
				splicedIr: preparedIr,
				slotValues: [],
				output: cleaned2,
				finishReason: res2.finishReason,
			});
			rec.repairMs = performance.now() - tRep0;

			if (v1.pass) {
				finalOutput =
					v2.pass &&
					!(v2.warnings ?? []).some((w) => w.startsWith('terse-mirror'))
						? cleaned2
						: cleaned1;
				finalPath = finalOutput === cleaned2 ? 'repaired' : 'direct';
				finalOk = true;
			} else if (v2.pass) {
				finalOutput = cleaned2;
				finalPath = 'repaired';
				finalOk = true;
			} else {
				finalOutput = preparedIr.trim();
				finalPath = 'template';
				const vt = validateExpansion({
					splicedIr: preparedIr,
					slotValues: [],
					output: finalOutput,
					finishReason: null,
					source: 'template',
				});
				finalOk = vt.pass;
			}
		}

		const tWrap0 = performance.now();
		wrapReply(finalOutput, {
			greeting: 'Hello,',
			signoff: 'Best regards,\nSupport Team',
		});
		rec.wrapMs = performance.now() - tWrap0;

		rec.path = finalPath;
		rec.ok = finalOk;
	} catch (e) {
		rec.error = e instanceof Error ? e.message : String(e);
	}
	rec.totalMs = performance.now() - totalT0;
	return rec;
}

async function runReshapedRow(
	row: { key: string; irCoded: string },
	dict: ReturnType<typeof dictFromJson>,
	markers: Record<string, string>,
	pool: ProviderPool,
	cache: ExpansionCache,
): Promise<RowTimings> {
	const totalT0 = performance.now();
	const rec: RowTimings = {
		key: row.key,
		path: 'error',
		ok: false,
		provider: 'none',
		parseDecodeMs: 0,
		fastPathMs: 0,
		cacheMs: 0,
		buildPromptMs: 0,
		llmExpandMs: 0,
		postProcessMs: 0,
		validateMs: 0,
		repairMs: 0,
		wrapMs: 0,
		totalMs: 0,
		error: null,
	};

	try {
		const tParse0 = performance.now();
		const segs = parseV3(row.irCoded, dict, markers);
		const fixed = autofixV3(segs, dict);
		const decoded = decodeV3(fixed.segments, dict);
		rec.parseDecodeMs = performance.now() - tParse0;
		if (!decoded.ok) {
			throw new Error(`decode: ${decoded.error}`);
		}
		const preparedIr = decoded.text;

		// Tier 1: Sub-ms deterministic fluent realizer.
		const tFast0 = performance.now();
		const fast = tryFastRealize({
			segments: fixed.segments,
			preparedIr,
			slotValues: [],
			dict,
		});
		rec.fastPathMs = performance.now() - tFast0;
		if (fast.ok) {
			const tWrap0 = performance.now();
			wrapReply(fast.text, {
				greeting: 'Hello,',
				signoff: 'Best regards,\nSupport Team',
			});
			rec.wrapMs = performance.now() - tWrap0;
			rec.path = 'fast-realizer';
			rec.provider = 'deterministic';
			rec.ok = true;
			rec.totalMs = performance.now() - totalT0;
			return rec;
		}

		// Tier 2: Slot-parameterized expansion cache.
		const tCache0 = performance.now();
		const hit = cache.get(preparedIr, []);
		rec.cacheMs = performance.now() - tCache0;
		if (hit !== undefined) {
			const tWrap0 = performance.now();
			wrapReply(hit.text, {
				greeting: 'Hello,',
				signoff: 'Best regards,\nSupport Team',
			});
			rec.wrapMs = performance.now() - tWrap0;
			rec.path = 'cached';
			rec.provider = 'cache';
			rec.ok = true;
			rec.totalMs = performance.now() - totalT0;
			return rec;
		}

		// Tier 3: ProviderPool + prefix-cached messages + tight maxOutputTokens + fastRepair.
		const ladderRes = await runLadder(preparedIr, {
			expandPrepared: async (irText: string, hint?: string) => {
				const r = await expand(pool, 'auto', irText, hint, NO_THINK_EXTRA_BODY);
				return {
					text: r.text,
					finishReason: r.finishReason,
					usage: r.usage ?? null,
				};
			},
			templateRender: (irText: string) => irText.trim(),
			slotValues: [],
			skipStyleRepair: true,
			fastRepair: (output, verdict) => {
				const failed = verdict.checks.filter((c) => !c.pass);
				if (failed.length === 1 && failed[0]?.name === 'no-greeting') {
					const fixedText = stripFramingLeaks(output);
					return fixedText !== output ? fixedText : null;
				}
				return null;
			},
		});

		rec.llmExpandMs = ladderRes.timings?.llmMs ?? 0;
		rec.validateMs = ladderRes.timings?.validateMs ?? 0;
		rec.repairMs = ladderRes.timings?.repairMs ?? 0;
		rec.provider = pool.lastProvider ?? 'unknown';

		if (ladderRes.ok && ladderRes.path === 'direct') {
			cache.set(preparedIr, [], ladderRes.text);
		}

		const tWrap0 = performance.now();
		wrapReply(ladderRes.text, {
			greeting: 'Hello,',
			signoff: 'Best regards,\nSupport Team',
		});
		rec.wrapMs = performance.now() - tWrap0;
		rec.path = ladderRes.path;
		rec.ok = ladderRes.ok;
	} catch (e) {
		rec.error = e instanceof Error ? e.message : String(e);
	}
	rec.totalMs = performance.now() - totalT0;
	return rec;
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const envMap = { ...readEnvFile(join(root, '.dev.vars')), ...process.env };

	console.log(`=== Provider Probe (4 existing + 7 new .dev.vars + local) ===`);
	const configs: ProviderConfig[] = [...ALL_PROVIDER_CONFIGS];

	const probed = await Promise.all(
		configs.map((cfg) => probeProvider(cfg, envMap[cfg.keyName])),
	);

	// Also check local llama.cpp server if active on :9931.
	let localEntry: ProviderEntry | undefined;
	try {
		const t0 = performance.now();
		const res = await fetch('http://127.0.0.1:9931/health', {
			signal: AbortSignal.timeout(1000),
		});
		if (res.ok) {
			const client = new OpenAIChatClient({
				apiKey: 'local',
				baseUrl: 'http://127.0.0.1:9931/v1',
				timeoutMs: 30_000,
			});
			localEntry = {
				config: {
					id: 'local-llama',
					keyName: 'LOCAL',
					baseUrl: 'http://127.0.0.1:9931/v1',
					defaultModel: 'local',
				},
				client,
			};
			console.log(`local-llama: UP (${Math.round(performance.now() - t0)}ms)`);
		}
	} catch {
		console.log('local-llama: DOWN (port 9931 not listening)');
	}

	const probeTable = probed.map((p) => p.probe);
	for (const p of probeTable) {
		const status = p.ok
			? `OK rtt=${p.rttMs}ms model=${p.selectedModel}`
			: `FAIL (${p.error})`;
		console.log(
			`  ${p.id.padEnd(18)} key=${String(p.hasKey).padEnd(5)} models=${String(p.modelsCount).padEnd(4)} ${status}`,
		);
	}

	const liveEntries = probed
		.filter(
			(p): p is { probe: ProbeResult; entry: ProviderEntry } =>
				p.entry !== undefined,
		)
		.sort((a, b) => (a.probe.rttMs ?? 99999) - (b.probe.rttMs ?? 99999))
		.map((p) => p.entry);

	if (localEntry !== undefined) {
		liveEntries.push(localEntry);
	}

	if (probeOnly) {
		writeFileSync(
			join(root, 'data', 'derived', 'provider-probe.json'),
			`${JSON.stringify({ probedAt: new Date().toISOString(), probes: probeTable }, null, 2)}\n`,
		);
		return;
	}

	if (liveEntries.length === 0) {
		throw new Error('No live AI providers or local llama.cpp available.');
	}

	const pool = new ProviderPool(liveEntries, {
		cooldownMs: 30_000,
		hedgeAfterMs: 350,
	});
	for (const p of probeTable) {
		if (p.ok && p.rttMs !== null) {
			pool.recordLatency(p.id, p.rttMs);
		}
	}

	const dict = dictFromJson(
		JSON.parse(
			readFileSync(join(root, 'data', 'derived', 'dict-ir-v3.json'), 'utf8'),
		),
	);
	const markers = (
		JSON.parse(
			readFileSync(join(root, 'data', 'derived', 'marker-v3.json'), 'utf8'),
		) as { aliases: Record<string, string> }
	).aliases;
	const rows = readFileSync(
		join(root, 'data', 'derived', 'emit-v3gem100.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.slice(0, n)
		.map((l) => JSON.parse(l) as { key: string; irCoded: string });

	console.log(
		`\n=== Stage Latency Measurement (${mode}, n=${rows.length}) ===`,
	);
	const cache = new ExpansionCache(512);
	const results: RowTimings[] = [];
	for (const row of rows) {
		if (mode === 'baseline') {
			results.push(await runBaselineRow(row, dict, markers, pool));
		} else {
			results.push(await runReshapedRow(row, dict, markers, pool, cache));
		}
	}

	const stages = [
		'parseDecodeMs',
		'fastPathMs',
		'cacheMs',
		'buildPromptMs',
		'llmExpandMs',
		'postProcessMs',
		'validateMs',
		'repairMs',
		'wrapMs',
		'totalMs',
	] as const;

	const summary: Record<string, { p50: number; p95: number; mean: number }> =
		{};
	for (const st of stages) {
		summary[st] = summarizeStage(results.map((r) => r[st]));
	}
	const totalMean = summary.totalMs?.mean || 1;
	for (const st of stages) {
		const s = summary[st];
		if (s === undefined) continue;
		const pct = ((s.mean / totalMean) * 100).toFixed(1);
		console.log(
			`  ${st.padEnd(16)} p50=${String(s.p50).padStart(8)}ms  p95=${String(s.p95).padStart(8)}ms  mean=${String(s.mean).padStart(8)}ms (${pct}%)`,
		);
	}

	const okCount = results.filter((r) => r.ok).length;
	const errCount = results.filter((r) => r.error !== null).length;
	const byPath: Record<string, number> = {};
	const byProvider: Record<string, number> = {};
	for (const r of results) {
		byPath[r.path] = (byPath[r.path] ?? 0) + 1;
		byProvider[r.provider] = (byProvider[r.provider] ?? 0) + 1;
	}
	console.log(
		`  passed=${okCount}/${results.length} errors=${errCount} paths=${JSON.stringify(byPath)} providers=${JSON.stringify(byProvider)}`,
	);

	const outFile = join(root, 'data', 'derived', `stage-latency-${mode}.json`);
	writeFileSync(
		outFile,
		`${JSON.stringify(
			{
				mode,
				at: new Date().toISOString(),
				n: results.length,
				probes: probeTable,
				summary,
				byPath,
				byProvider,
				okCount,
				errCount,
				rows: results,
			},
			null,
			2,
		)}\n`,
	);
	console.log(`Saved ${outFile}`);
}

await main();
