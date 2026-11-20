import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function postJson(
	path: string,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await SELF.fetch(`https://test${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

async function dictVersion(): Promise<string> {
	const res = await SELF.fetch('https://test/health');
	const body = (await res.json()) as { dictVersion?: unknown };
	if (typeof body.dictVersion !== 'string') {
		throw new Error('health did not report a dict version');
	}
	return body.dictVersion;
}

describe('entry routing (workerd)', () => {
	it('serves health with the bundled dict version', async () => {
		const res = await SELF.fetch('https://test/health');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok?: unknown; dictVersion?: unknown };
		expect(body.ok).toBe(true);
		expect(typeof body.dictVersion).toBe('string');
	});

	it('404s unknown routes and 405s wrong methods', async () => {
		expect((await SELF.fetch('https://test/nope')).status).toBe(404);
		expect((await SELF.fetch('https://test/expand')).status).toBe(405);
	});

	it('400s malformed JSON and missing fields without touching the model', async () => {
		const bad = await SELF.fetch('https://test/expand', {
			method: 'POST',
			body: '{oops',
		});
		expect(bad.status).toBe(400);
		const missing = await postJson('/expand', { ir: 'x' });
		expect(missing.status).toBe(400);
	});

	it('422s dict version mismatch against the bundled dict', async () => {
		const v = await dictVersion();
		const r = await postJson('/expand', {
			ir: 'plain line',
			dictVersion: `${v}-definitely-not-real`,
			kbVersion: 'kb1',
			model: 'm',
		});
		expect(r.status).toBe(422);
	});

	it('422s unknown codes and 400s malformed IR without model calls', async () => {
		const v = await dictVersion();
		const base = { dictVersion: v, kbVersion: 'kb1', model: 'm' };
		expect((await postJson('/expand', { ...base, ir: ':zz' })).status).toBe(
			422,
		);
		expect(
			(await postJson('/expand', { ...base, ir: '@bogus line' })).status,
		).toBe(400);
	});

	it('501s span requests while the store is unprovisioned', async () => {
		const v = await dictVersion();
		const r = await postJson('/expand', {
			ir: '@span:{"d":"D","s":"1"}',
			dictVersion: v,
			kbVersion: 'kb1',
			model: 'm',
		});
		expect(r.status).toBe(501);
		expect(r.json.error).toContain('not configured');
	});
});
