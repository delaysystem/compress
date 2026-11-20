// First live generation pilot (PLAN.md Step 5 prep): one tiny completion with
// the raw response recorded for fixtures. Prints text/finishReason/usage only.
// Run from worker/: node --experimental-strip-types scripts/gemini-pilot.ts <model> [prompt]
// Cost: a handful of tokens. Values never logged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { GeminiClient } from '../src/gemini.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';

const target = process.argv[2];
if (target === undefined) {
	console.error(
		'usage: node --experimental-strip-types scripts/gemini-pilot.ts <model> [prompt]',
	);
	process.exitCode = 1;
} else {
	await run(target, process.argv[3] ?? 'Reply with exactly: ok');
}

async function run(model: string, prompt: string): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = join(here, '..', '..');
	const { value: apiKey, resolution } = resolveSecret({
		name: GEMINI_API_KEY_NAME,
		env: process.env,
		filePath: join(root, '.dev.vars'),
	});
	console.log(`key: ${describeResolution(resolution)} present=true`);
	const client = new GeminiClient({ apiKey });
	const raw = await client.generateRaw(model, prompt);
	const parsed = await client.generate(model, prompt);
	console.log(
		`text=${JSON.stringify(parsed.text)} finishReason=${parsed.finishReason}`,
	);
	console.log(`usage=${JSON.stringify(parsed.usage ?? null)}`);
	const outDir = join(root, 'data', 'derived');
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, 'generate-sample.json'),
		`${JSON.stringify({ generatedAt: new Date().toISOString(), model, prompt, response: raw }, null, 2)}\n`,
	);
}
