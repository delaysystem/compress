// Tokenizer re-measurement (PLAN.md Step 2b): recounts the research IR samples
// with the production tokenizer (Gemini countTokens), replacing tiktoken proxies.
// Run from worker/: node --experimental-strip-types scripts/recount-ir.ts <model>
// (list models via scripts/gemini-smoke.ts). Writes data/derived/ir-recount.json.
// Cost: 2 free countTokens calls per sample. Values never logged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { GeminiClient } from '../src/gemini.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';

interface IrSample {
	name: string;
	full: string;
	ir: string;
}

interface RawSample {
	name?: unknown;
	full?: unknown;
	ir?: unknown;
	ir_min?: unknown;
}

function toSample(raw: RawSample, file: string, index: number): IrSample {
	if (typeof raw.name !== 'string' || typeof raw.full !== 'string') {
		throw new Error(`bad sample ${file}#${index}: name/full`);
	}
	const ir = raw.ir ?? raw.ir_min;
	if (typeof ir !== 'string') {
		throw new Error(`bad sample ${file}#${index}: ir`);
	}
	return { name: raw.name, full: raw.full, ir };
}

const target = process.argv[2];
if (target === undefined) {
	console.error(
		'usage: node --experimental-strip-types scripts/recount-ir.ts <model>',
	);
	console.error(
		'(list models: node --experimental-strip-types scripts/gemini-smoke.ts)',
	);
	process.exitCode = 1;
} else {
	await run(target);
}

async function run(model: string): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const { value: apiKey, resolution } = resolveSecret({
		name: GEMINI_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolution)} present=true`);
	const data = JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'ir-samples.json'), 'utf8'),
	) as Record<string, RawSample[]>;
	const client = new GeminiClient({ apiKey });
	const samples: Array<{
		file: string;
		name: string;
		fullChars: number;
		fullTokens: number;
		irTokens: number;
	}> = [];
	for (const [file, raws] of Object.entries(data)) {
		raws.forEach((raw, i) => {
			const s = toSample(raw, file, i);
			samples.push({
				file,
				name: s.name,
				fullChars: 0,
				fullTokens: 0,
				irTokens: 0,
			});
		});
	}
	for (const s of samples) {
		const raw = (data[s.file] ?? []) as RawSample[];
		const src = raw.find((r) => r.name === s.name);
		if (src === undefined) {
			throw new Error(`sample vanished: ${s.file} ${s.name}`);
		}
		const full = src.full as string;
		const ir = (src.ir ?? src.ir_min) as string;
		const [f, r] = await Promise.all([
			client.countTokens(model, full),
			client.countTokens(model, ir),
		]);
		s.fullChars = full.length;
		s.fullTokens = f.totalTokens;
		s.irTokens = r.totalTokens;
		console.log(
			`${s.name}: full=${f.totalTokens} ir=${r.totalTokens} ratio=${(f.totalTokens / r.totalTokens).toFixed(2)}x`,
		);
	}
	const outDir = join(root, 'data', 'derived');
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, 'ir-recount.json'),
		`${JSON.stringify({ generatedAt: new Date().toISOString(), model, samples }, null, 2)}\n`,
	);
}
