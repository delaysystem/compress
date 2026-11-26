// Worker entry (production wiring). Secrets via env bindings (owner:
// `wrangler secret put`). Dicts: bundled versioned snapshots (v0 + ir-v3)
// plus marker-v3 alias table. LLM: multi-provider failover pool across
// existing + 7 .dev.vars OpenAI-compatible providers. Spans: SPAN_KV binding
// (unprovisioned until owner step -> explicit 501 path, tested).
import dictV3Json from '../../data/derived/dict-ir-v3.json';
import dictJson from '../../data/derived/dict-v0.json';
import markerV3Json from '../../data/derived/marker-v3.json';
import { type AppDeps, routeRequest } from './app.ts';
import { ExpansionCache } from './cache.ts';
import { type Dictionary, dictFromJson } from './dict.ts';
import type { Env } from './env.ts';
import { buildProviderPoolFromEnv } from './providers.ts';
import { spanStoreFromJson } from './spanref.ts';

let cachedDicts:
	| {
			v0: Dictionary;
			v3: Dictionary;
			byVersion: Record<string, Dictionary>;
			markers: Record<string, string>;
	  }
	| undefined;

const isolateCache = new ExpansionCache(512);

function getDicts() {
	if (cachedDicts === undefined) {
		const v0 = dictFromJson(dictJson);
		const v3 = dictFromJson(dictV3Json);
		const markers = (markerV3Json as { aliases?: Record<string, string> })
			.aliases;
		cachedDicts = {
			v0,
			v3,
			byVersion: {
				[v0.version]: v0,
				[v3.version]: v3,
			},
			markers: markers ?? {},
		};
	}
	return cachedDicts;
}

function buildDeps(env: Env): AppDeps {
	const dicts = getDicts();
	return {
		dict: dicts.v0,
		dicts: dicts.byVersion,
		markers: dicts.markers,
		cache: isolateCache,
		llm: buildProviderPoolFromEnv(env, { hedgeAfterMs: 350 }),
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
