// LFM3-as-expander for v3x IR (run 034): decode emit-v3xling25b rows through
// the deterministic wire-v3 path, expand each prepared draft with a local
// LFM3 SLM into a friendly agent reply, and record reply + usage + latency.
// New outputs: data/derived/lfm3-v3x-expand.jsonl + lfm3-v3x-expand-summary.json.
// Run from worker/: node --experimental-strip-types scripts/lfm3-expand-v3x.ts [--force]
// Requires: OpenAI-compatible server on 127.0.0.1:9931 (llama.cpp / llama-cpp-python).
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dictFromJson } from '../src/dict.ts';
import {
	buildExpansionPrompt,
	normalizeModelBraces,
	stripAnchorParrot,
} from '../src/expander.ts';
import { percentile } from '../src/ireval.ts';
import { decodeV3, parseV3 } from '../src/wirev3.ts';

const LFM3_BASE = 'http://127.0.0.1:9931';
const CONCURRENCY = 2;
const TEMPERATURE = 0;
const MAX_REPLY_TOKENS = 512;
const FETCH_RETRIES = 2;

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

interface ExpandRow {
	key: string;
	prepared: string;
	reply: string;
	finish: string;
	promptTokens: number;
	completionTokens: number;
	wallMs: number;
	error: string | null;
}

/** LFM3-1.7B quirks (probed 2026-11-16): it echoes the draft block, then
 * a blank line, then the real reply (echo may join lines or polish
 * spacing); and it prefixes replies with a REPLY: label. Drop the echo
 * paragraph only when its words match a draft prefix (backslash- and
 * punctuation-tolerant); never strip a paragraph that diverges. If
 * nothing remains, keep the original for the validator. */
export function stripDraftEcho(reply: string, draft: string): string {
	const words = (s: string): string[] =>
		s
			.toLowerCase()
			.split(/\s+/)
			.map((w) => w.replace(/^[.,:;\\]+|[.,:;\\]+$/g, ''))
			.filter((w) => w.length > 0);
	const draftWords = words(draft);
	let t = reply.trim();
	const paras = t.split(/\n\s*\n/);
	// Drop consecutive leading echo paragraphs: each must fully match
	// the draft word run continuing where the previous para left off
	// (echo blocks with blank lines between draft lines). A paragraph
	// that diverges ends the echo block.
	let offset = 0;
	let cut = 0;
	let firstMatched = 0;
	while (cut < paras.length - 1) {
		const first = words(paras[cut] ?? '');
		if (first.length < 2) {
			break;
		}
		let matched = 0;
		while (
			matched < first.length &&
			offset + matched < draftWords.length &&
			first[matched] === draftWords[offset + matched]
		) {
			matched++;
		}
		if (cut === 0) {
			firstMatched = matched;
		}
		if (matched !== first.length) {
			break;
		}
		offset += matched;
		cut++;
	}
	// Long verbatim run with trailing polish (single-block echoes).
	if (cut === 0 && firstMatched >= 10) {
		cut = 1;
	}
	if (cut > 0) {
		t = paras.slice(cut).join('\n\n').trim();
	}
	t = t.replace(/^(REPLY|Reply|reply)\s*:\s*/, '').trim();
	return t.length > 0 ? t : reply.trim();
}

async function postChat(prompt: string): Promise<{
	text: string;
	finish: string;
	promptTokens: number;
	completionTokens: number;
}> {
	let last = '';
	for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
		try {
			const res = await fetch(`${LFM3_BASE}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: prompt }],
					temperature: TEMPERATURE,
					max_tokens: MAX_REPLY_TOKENS,
				}),
			});
			if (!res.ok) {
				throw new Error(`http ${res.status}`);
			}
			const d = (await res.json()) as {
				choices?: Array<{
					finish_reason?: unknown;
					message?: { content?: unknown };
				}>;
				usage?: {
					prompt_tokens?: unknown;
					completion_tokens?: unknown;
				};
			};
			const c = d.choices?.[0];
			return {
				text: typeof c?.message?.content === 'string' ? c.message.content : '',
				finish: typeof c?.finish_reason === 'string' ? c.finish_reason : '',
				promptTokens:
					typeof d.usage?.prompt_tokens === 'number'
						? d.usage.prompt_tokens
						: 0,
				completionTokens:
					typeof d.usage?.completion_tokens === 'number'
						? d.usage.completion_tokens
						: 0,
			};
		} catch (e) {
			last = e instanceof Error ? e.message : String(e);
			await sleep(1000);
		}
	}
	throw new Error(`lfm3 chat failed: ${last}`);
}

async function main(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const force = process.argv.includes('--force');
	const flagAfter = (flag: string): string | null => {
		const i = process.argv.indexOf(flag);
		return i >= 0 ? (process.argv[i + 1] ?? null) : null;
	};
	const rowsName = flagAfter('--input') ?? 'emit-v3xling25b.jsonl';
	const outName = flagAfter('--out') ?? 'lfm3-v3x-expand.jsonl';
	if (rowsName.includes('/') || outName.includes('/')) {
		throw new Error('--input/--out must be bare file names');
	}
	const rowsPath = join(root, 'data', 'derived', rowsName);
	const outPath = join(root, 'data', 'derived', outName);
	const summaryPath = join(
		root,
		'data',
		'derived',
		outName.replace(/\.jsonl$/, '-summary.json'),
	);
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
	const inputs = readFileSync(rowsPath, 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as { key: string; irCoded: string });
	const done = new Set<string>();
	if (!force) {
		try {
			for (const line of readFileSync(outPath, 'utf8').split('\n')) {
				if (line.trim().length === 0) continue;
				done.add((JSON.parse(line) as { key: string }).key);
			}
		} catch {
			// No partial output yet.
		}
	} else {
		try {
			writeFileSync(outPath, '');
		} catch {
			mkdirSync(dirname(outPath), { recursive: true });
			writeFileSync(outPath, '');
		}
	}
	const pending = inputs.filter((r) => !done.has(r.key));
	console.log(
		`lfm3-v3x-expand: ${pending.length} pending (${done.size} banked)`,
	);
	let cursor = 0;
	const workers: Array<Promise<void>> = [];
	for (let w = 0; w < CONCURRENCY; w++) {
		workers.push(
			(async () => {
				while (cursor < pending.length) {
					const row = pending[cursor++] as { key: string; irCoded: string };
					const t0 = Date.now();
					const out: ExpandRow = {
						key: row.key,
						prepared: '',
						reply: '',
						finish: '',
						promptTokens: 0,
						completionTokens: 0,
						wallMs: 0,
						error: null,
					};
					try {
						const d = decodeV3(parseV3(row.irCoded, dict, markers), dict);
						if (!d.ok) {
							throw new Error(`decode: ${d.error}`);
						}
						out.prepared = d.text;
						const r = await postChat(buildExpansionPrompt(d.text));
						out.reply = normalizeModelBraces(
							stripAnchorParrot(stripDraftEcho(r.text, d.text)),
							d.text,
						);
						out.finish = r.finish;
						out.promptTokens = r.promptTokens;
						out.completionTokens = r.completionTokens;
					} catch (e) {
						out.error = e instanceof Error ? e.message : String(e);
					}
					out.wallMs = Date.now() - t0;
					appendFileSync(outPath, `${JSON.stringify(out)}\n`);
					try {
						const n = statSync(outPath).size;
						if (n % 1 === 0) {
							console.log(
								`banked ${row.key} err=${out.error ?? 'none'} ms=${out.wallMs}`,
							);
						}
					} catch {
						// Banked; progress line is best-effort.
					}
				}
			})(),
		);
	}
	await Promise.all(workers);
	const rows: ExpandRow[] = readFileSync(outPath, 'utf8')
		.split('\n')
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as ExpandRow);
	const ok = rows.filter((r) => r.error === null);
	const summary = {
		n: rows.length,
		ok: ok.length,
		errors: rows.length - ok.length,
		latencyMsP50: percentile(
			ok.map((r) => r.wallMs),
			50,
		),
		promptTokensTotal: ok.reduce((a, r) => a + r.promptTokens, 0),
		completionTokensTotal: ok.reduce((a, r) => a + r.completionTokens, 0),
	};
	writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
	console.log(
		`done: n=${summary.n} ok=${summary.ok} p50ms=${summary.latencyMsP50} tok=${summary.promptTokensTotal}+${summary.completionTokensTotal}`,
	);
}

await main();
