// Secret resolution (agents2.md Rules 1, 4): values come from the environment
// (production/CI) or the owner-provided local file (dev). Names are config;
// values are never logged, embedded, or committed. Tests use fixture files
// with fake values only. Node-only module (uses fs): the Workers runtime
// receives secrets as env bindings instead.

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseDotenv } from 'dotenv';

export interface KeyResolution {
	source: 'env' | 'file';
	name: string;
}

export function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) {
		return {};
	}
	return parseDotenv(readFileSync(path, 'utf8'));
}

export function resolveSecret(opts: {
	name: string;
	env?: NodeJS.ProcessEnv;
	filePath?: string;
}): { value: string; resolution: KeyResolution } {
	const fromEnv = opts.env?.[opts.name];
	if (fromEnv !== undefined && fromEnv.length > 0) {
		return { value: fromEnv, resolution: { source: 'env', name: opts.name } };
	}
	if (opts.filePath !== undefined) {
		const fromFile = readEnvFile(opts.filePath)[opts.name];
		if (fromFile !== undefined && fromFile.length > 0) {
			return {
				value: fromFile,
				resolution: { source: 'file', name: opts.name },
			};
		}
	}
	throw new Error(
		`missing secret: ${opts.name} (checked env, then ${opts.filePath ?? 'no file'})`,
	);
}

export function describeResolution(r: KeyResolution): string {
	return `${r.source}:${r.name}`;
}
