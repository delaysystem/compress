// Span expansion end-to-end (10x drive): expand span-arm IRs through the
// real product path (prepareExpansion WITH the per-row request store,
// Gemini v0 expansion, validator). Proves resolved span text validates.
// Run from worker/: node --experimental-strip-types scripts/span-expand.ts [limit] [--force] [--resume] [--provider gemini]
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	GEMINI_API_KEY_NAME,
	GROQ_API_KEY_NAME,
	GROQ_BASE_URL,
} from '../src/config.ts';
import {
	buildExpansionPrompt,
	prepareExpansion,
	stripHarmony,
	stripThinkBlocks,
} from '../src/expander.ts';
import { GeminiClient } from '../src/gemini.ts';
import { OpenAIChatClient } from '../src/openai.ts';
import { Pacer } from '../src/pace.ts';
import {
	BACKPRESSURE_BUDGET,
	BackpressureTrip,
	backoffMs,
	CALL_TIME_TRIP_MS,
	DEFAULT_BUDGET,
	isBackpressure,
	isRetryable,
} from '../src/retry.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';
import { validateExpansion } from '../src/validator.ts';

const GROQ_MODEL = 'qwen/qwen3.8-27b';
const GEMINI_MODEL = 'gemini-3.5-flash-lite';
const TEMPERATURE = 0;
const MAX_REPLY_TOKENS = 512;
const GROQ_EXTRA_BODY = { reasoning_effort: 'none' };
const MIN_INTERVAL_MS = 5000;
const CONCURRENCY = 4;
const MAX_ERROR_RATE = 0.1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function flagValue(flag: string, def: string): string {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? (process.argv[i + 1] ?? def) : def;
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const emitRows = readFileSync(
		join(root, 'data', 'derived', 'span-emit.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')
		.filter((l) => l.length > 0)
		.map(
			(l) =>
				JSON.parse(l) as {
					key: string;
					arm: string;
					ir: string;
					error: string | null;
					punt: boolean;
				},
		);
	const samples = new Map<string, string[]>();
	for (const l of readFileSync(
		join(root, 'data', 'derived', 'span-sample.jsonl'),
		'utf8',
	)
		.trim()
		.split('\n')) {
		if (!l) continue;
		const r = JSON.parse(l) as { key: string; spans: string[] };
		samples.set(r.key, r.spans);
	}
	const jobs = emitRows.filter(
		(r) => r.arm === 'span' && r.error === null && !r.punt,
	);
	const limitArg = Number(process.argv[2]);
	const limit = Number.isInteger(limitArg) && limitArg > 0 ? limitArg : null;
	const picked = jobs.slice(0, limit ?? jobs.length);
	const provider = flagValue('--provider', 'groq');
	if (provider !== 'groq' && provider !== 'gemini') {
		throw new Error(`--provider must be groq or gemini, got ${provider}`);
	}
	const model = provider === 'gemini' ? GEMINI_MODEL : GROQ_MODEL;
	const resume = process.argv.includes('--resume');
	const jsonlPath = join(root, 'data', 'derived', 'span-expand.jsonl');
	if (!resume && !process.argv.includes('--force')) {
		let existing = 0;
		try {
			existing = statSync(jsonlPath).size;
		} catch {
			existing = 0;
		}
		if (existing > 0) {
			throw new Error(`refusing to overwrite ${jsonlPath} without --force`);
		}
	}
	if (!resume) {
		writeFileSync(jsonlPath, '');
	}
	const resolved = resolveSecret({
		name: provider === 'gemini' ? GEMINI_API_KEY_NAME : GROQ_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolved.resolution)} present=true`);
	console.log(`provider: ${provider} model: ${model} jobs: ${picked.length}`);
	const groq =
		provider === 'gemini'
			? null
			: new OpenAIChatClient({
					apiKey: resolved.value,
					baseUrl: GROQ_BASE_URL,
					timeoutMs: 120_000,
				});
	const gemini =
		provider === 'gemini' ? new GeminiClient({ apiKey: resolved.value }) : null;
	const pacer = new Pacer(MIN_INTERVAL_MS);
	const trip = new BackpressureTrip();
	mkdirSync(join(root, 'data', 'derived'), { recursive: true });
	const done = new Set<string>(
		resume
			? readFileSync(jsonlPath, 'utf8')
					.trim()
					.split('\n')
					.filter((l) => l.length > 0)
					.map((l) => (JSON.parse(l) as { key: string }).key)
			: [],
	);
	const pending = picked.filter((r) => !done.has(r.key));
	let cursor = 0;
	let errors = 0;
	let pass = 0;
	const workers = Array.from({ length: CONCURRENCY }, async () => {
		for (;;) {
			const my = cursor;
			cursor += 1;
			if (my >= pending.length) {
				return;
			}
			const job = pending[my];
			if (job === undefined) {
				return;
			}
			const spans = samples.get(job.key) ?? [];
			const store = {
				version: 'spanreq',
				documents: new Map([
					['q', new Map(spans.map((t, i) => [String(i + 1), t] as const))],
				]),
			};
			const fail = (error: string) => ({
				key: job.key,
				pass: false as const,
				error,
			});
			{
				const prep = prepareExpansion(job.ir, {
					dict: { version: 'span-empty', entries: [] },
					dictVersion: 'span-empty',
					store,
					kbVersion: 'spanreq',
				});
				if (!prep.ok) {
					appendFileSync(
						jsonlPath,
						`${JSON.stringify(fail(`prepare: ${prep.error.message}`))}\n`,
					);
					errors += 1;
					continue;
				}
				const prompt = buildExpansionPrompt(prep.value.expandedIr);
				let attempt = 0;
				const callStart = Date.now();
				for (;;) {
					await pacer.wait();
					try {
						const gen =
							gemini !== null
								? await gemini.generate(model, prompt, {
										temperature: TEMPERATURE,
										maxOutputTokens: MAX_REPLY_TOKENS,
									})
								: await (groq as OpenAIChatClient).generate(model, prompt, {
										temperature: TEMPERATURE,
										maxOutputTokens: MAX_REPLY_TOKENS,
										extraBody: GROQ_EXTRA_BODY,
									});
						trip.recordSuccess();
						const clean = stripThinkBlocks(stripHarmony(gen.text));
						const v = validateExpansion({
							splicedIr: prep.value.expandedIr,
							slotValues: [],
							output: clean,
							finishReason: gen.finishReason === 'STOP' ? 'STOP' : 'MAX_TOKENS',
						});
						if (v.pass) pass += 1;
						appendFileSync(
							jsonlPath,
							`${JSON.stringify({ key: job.key, pass: v.pass, checks: v.checks.map((c) => ({ name: c.name, pass: c.pass })), reply: clean.slice(0, 400), error: null })}\n`,
						);
						break;
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						if (!isRetryable(e)) {
							appendFileSync(
								jsonlPath,
								`${JSON.stringify(fail(msg.slice(0, 160)))}\n`,
							);
							errors += 1;
							break;
						}
						if (isBackpressure(e) && trip.recordBackpressure()) {
							throw new Error('quota wall — resume later');
						}
						if (Date.now() - callStart > CALL_TIME_TRIP_MS) {
							throw new Error('call burning past trip — aborting');
						}
						const budget = isBackpressure(e)
							? BACKPRESSURE_BUDGET
							: DEFAULT_BUDGET;
						if (attempt >= budget.maxAttempts) {
							appendFileSync(
								jsonlPath,
								`${JSON.stringify(fail(`${msg} (exhausted)`.slice(0, 160)))}\n`,
							);
							errors += 1;
							break;
						}
						await sleep(backoffMs(attempt, budget.baseMs));
						attempt += 1;
					}
				}
			}
			if (errors > pending.length * MAX_ERROR_RATE) {
				throw new Error(`error budget exceeded (${errors} failures)`);
			}
		}
	});
	await Promise.all(workers);
	console.log(`pass=${pass}/${pending.length} errors=${errors}`);
}

await main();
