import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	describeResolution,
	readEnvFile,
	resolveSecret,
} from '../src/secrets.ts';

const FIXTURE = fileURLToPath(
	new URL('./fixtures/test-vars.env', import.meta.url),
);

describe('readEnvFile', () => {
	it('parses values, quotes, and comments', () => {
		const vars = readEnvFile(FIXTURE);
		expect(vars).toMatchObject({
			FAKE_API_KEY: 'test-only-fake-key-123',
			QUOTED_HASH: 'abc#def',
		});
		expect(vars).not.toHaveProperty('COMMENTED_KEY');
	});

	it('returns {} for a missing file', () => {
		expect(readEnvFile('/nonexistent-xyz-123.env')).toEqual({});
	});
});

describe('resolveSecret', () => {
	it('prefers env over file', () => {
		const r = resolveSecret({
			name: 'FAKE_API_KEY',
			env: { FAKE_API_KEY: 'from-env' },
			filePath: FIXTURE,
		});
		expect(r).toEqual({
			value: 'from-env',
			resolution: { source: 'env', name: 'FAKE_API_KEY' },
		});
	});

	it('falls back to the file', () => {
		const r = resolveSecret({
			name: 'FAKE_API_KEY',
			env: {},
			filePath: FIXTURE,
		});
		expect(r).toEqual({
			value: 'test-only-fake-key-123',
			resolution: { source: 'file', name: 'FAKE_API_KEY' },
		});
	});

	it('treats empty values as missing', () => {
		expect(() =>
			resolveSecret({ name: 'EMPTY_KEY', env: {}, filePath: FIXTURE }),
		).toThrow('missing secret: EMPTY_KEY');
	});

	it('throws naming only the key, never any value', () => {
		let message = '';
		try {
			resolveSecret({
				name: 'MISSING_KEY',
				env: { OTHER: 'canary-value-zzz' },
				filePath: FIXTURE,
			});
		} catch (e) {
			message = (e as Error).message;
		}
		expect(message).toBe(
			`missing secret: MISSING_KEY (checked env, then ${FIXTURE})`,
		);
		expect(message).not.toContain('canary');
	});
});

describe('describeResolution', () => {
	it('formats source:name', () => {
		expect(describeResolution({ source: 'file', name: 'K' })).toBe('file:K');
	});
});
