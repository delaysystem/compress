// Worker entry (production wiring). Secrets via env bindings (owner:
// `wrangler secret put`). Dict: bundled versioned snapshot (v0; KV migration
// is follow-up). Spans: SPAN_KV binding (unprovisioned until owner step ->
// explicit 501 path, tested).
import dictJson from '../../data/derived/dict-v0.json';
import { type AppDeps, routeRequest } from './app.ts';
import { NIM_BASE_URL } from './config.ts';
import { type Dictionary, dictFromJson } from './dict.ts';
import type { Env } from './env.ts';
import { OpenAIChatClient } from './openai.ts';
import { spanStoreFromJson } from './spanref.ts';

let cachedDict: Dictionary | undefined;

function getDict(): Dictionary {
	if (cachedDict === undefined) {
		cachedDict = dictFromJson(dictJson);
	}
	return cachedDict;
}

function buildDeps(env: Env): AppDeps {
	const apiKey = env.NIM_API_KEY;
	return {
		dict: getDict(),
		llm:
			apiKey === undefined || apiKey.length === 0
				? undefined
				: new OpenAIChatClient({ apiKey, baseUrl: NIM_BASE_URL }),
		loadSpans: async (kbVersion: string) => {
			if (env.SPAN_KV === undefined) {
				return { ok: false as const, reason: 'not-configured' as const };
			}
			let raw: unknown;
			try {
				raw = await env.SPAN_KV.get(`spans/${kbVersion}`, 'json');
			} catch (e) {
				console.error(
					'span store read failed:',
					e instanceof Error ? e.message : String(e),
				);
				return { ok: false as const, reason: 'unavailable' as const };
			}
			if (raw === null) {
				return { ok: false, reason: 'unknown-version' as const };
			}
			try {
				return { ok: true, store: spanStoreFromJson(kbVersion, raw) };
			} catch (e) {
				console.error(
					'span store corrupt:',
					e instanceof Error ? e.message : String(e),
				);
				return { ok: false, reason: 'unavailable' as const };
			}
		},
	};
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		let deps: AppDeps;
		try {
			deps = buildDeps(env);
		} catch (e) {
			console.error(
				'misconfigured worker:',
				e instanceof Error ? e.message : String(e),
			);
			return Response.json({ error: 'server misconfigured' }, { status: 500 });
		}
		return routeRequest(deps, request);
	},
} satisfies ExportedHandler<Env>;
