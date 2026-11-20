// Live smoke probe (PLAN.md Step 2b): resolves the key, lists models, and
// optionally countTokens fixed samples for a given model.
// Run from worker/: node --experimental-strip-types scripts/gemini-smoke.ts [model]
// Prints names/counts ONLY. Values never logged.
// Cost: ListModels + countTokens (free APIs). No generation here.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_API_KEY_NAME } from '../src/config.ts';
import { GeminiClient } from '../src/gemini.ts';
import { describeResolution, resolveSecret } from '../src/secrets.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { value: apiKey, resolution } = resolveSecret({
	name: GEMINI_API_KEY_NAME,
	env: process.env,
	filePath: join(here, '..', '..', '.dev.vars'),
});
console.log(`key: ${describeResolution(resolution)} present=true`);

const client = new GeminiClient({ apiKey });
const models = await client.listModels();
for (const m of models) {
	console.log(`model: ${m}`);
}

const target = process.argv[2];
if (target !== undefined) {
	const samples = [
		'Hello world',
		'Your refund of $49.99 for order #84721 was approved on March 12.',
		'refund #84721 done $49.99',
	];
	for (const s of samples) {
		const r = await client.countTokens(target, s);
		console.log(`countTokens chars=${s.length} totalTokens=${r.totalTokens}`);
	}
}
