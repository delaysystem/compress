// Records one tiny live SSE stream for chunk fixtures (run 008).
// Run from worker/: node --experimental-strip-types scripts/record-stream.ts <model>
// Writes data/derived/stream-sample.json {frames: parsed payloads}. Prints counts only.
// Cost: one short generation. Values never logged.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { GeminiClient } from '../src/gemini.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';

const target = process.argv[2];
if (target === undefined) {
	console.error(
		'usage: node --experimental-strip-types scripts/record-stream.ts <model>',
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
	const client = new GeminiClient({ apiKey });
	const payloads: unknown[] = [];
	for await (const p of client.streamJson(
		model,
		'Reply with exactly: one two three',
	)) {
		payloads.push(p);
	}
	console.log(`frames=${payloads.length}`);
	const outDir = join(root, 'data', 'derived');
	mkdirSync(outDir, { recursive: true });
	writeFileSync(
		join(outDir, 'stream-sample.json'),
		`${JSON.stringify({ generatedAt: new Date().toISOString(), model, payloads }, null, 2)}\n`,
	);
}
