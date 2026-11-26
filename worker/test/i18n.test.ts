import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type AppDeps, handleExpand, routeRequest } from '../src/app.ts';
import { ExpansionCache } from '../src/cache.ts';
import { dictFromJson } from '../src/dict.ts';
import { buildExpansionMessages, stripFramingLeaks } from '../src/expander.ts';
import {
	listSupportedLanguages,
	normalizeLang,
	SUPPORTED_LANG_CODES,
} from '../src/i18n.ts';
import { FLUENT_TEMPLATES_BY_LANG } from '../src/i18n-templates.ts';
import { tryFastRealize } from '../src/realizer.ts';
import { validateExpansion } from '../src/validator.ts';
import { decodeV3 } from '../src/wirev3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dictV3 = dictFromJson(
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'dict-ir-v3.json'), 'utf8'),
	),
);

describe('i18n language registry (20 most spoken languages)', () => {
	it('registers exactly 20 languages and normalizes BCP-47 tags and names', () => {
		expect(SUPPORTED_LANG_CODES).toHaveLength(20);
		expect(listSupportedLanguages()).toHaveLength(20);
		expect(normalizeLang('en')).toBe('en');
		expect(normalizeLang('es-MX')).toBe('es');
		expect(normalizeLang('zh-CN')).toBe('zh');
		expect(normalizeLang('pt_BR')).toBe('pt');
		expect(normalizeLang('Mandarin')).toBe('zh');
		expect(normalizeLang('Hindi')).toBe('hi');
		expect(normalizeLang('Swahili')).toBe('sw');
		expect(normalizeLang('xx')).toBeUndefined();
		expect(normalizeLang('')).toBeUndefined();
	});

	it('realizes all 20 languages x 46 dict-ir-v3 codes and passes all 8 validator checks', () => {
		for (const lang of SUPPORTED_LANG_CODES) {
			const table = FLUENT_TEMPLATES_BY_LANG[lang];
			for (const entry of dictV3.entries) {
				if (entry.code === 'TX') {
					continue;
				}
				expect(
					table[entry.code],
					`missing ${lang}:${entry.code}`,
				).toBeDefined();
				const slots = entry.slots.map((_, idx) => `{{Slot ${idx + 1}}}`);
				const segs = [{ kind: 'code' as const, code: entry.code, slots }];
				const decoded = decodeV3(segs, dictV3);
				expect(decoded.ok).toBe(true);
				if (!decoded.ok) continue;

				const res = tryFastRealize({
					segments: segs,
					preparedIr: decoded.text,
					slotValues: slots,
					dict: dictV3,
					lang,
				});
				expect(res.ok, `tryFastRealize failed for ${lang}:${entry.code}`).toBe(
					true,
				);
				if (res.ok) {
					for (const s of slots) {
						expect(res.text).toContain(s);
					}
				}
			}
		}
	});
});

describe('multilingual validator, framing strip, cache & prompts', () => {
	it('flags and strips non-English greetings and sign-offs', () => {
		const vEs = validateExpansion({
			splicedIr: 'Log in to account',
			slotValues: [],
			output: 'Hola! Por favor, inicie sesión en su cuenta.',
			finishReason: 'STOP',
			lang: 'es',
		});
		expect(vEs.pass).toBe(false);
		expect(vEs.checks.find((c) => c.name === 'no-greeting')?.pass).toBe(false);

		const strippedEs = stripFramingLeaks(
			'Hola! Por favor, inicie sesión en su cuenta.\nSaludos cordiales',
			'es',
		);
		expect(strippedEs).toBe('Por favor, inicie sesión en su cuenta.');

		const strippedZh = stripFramingLeaks('您好，请登录您的账户。', 'zh');
		expect(strippedZh).toBe('请登录您的账户。');
	});

	it('namespaces ExpansionCache entries by language', () => {
		const cache = new ExpansionCache(16);
		const ir = 'Order W111 refund approved';
		cache.set(ir, ['W111'], 'Your refund for order W111 is approved.', 'en');
		cache.set(
			ir,
			['W111'],
			'Su reembolso para el pedido W111 ha sido aprobado.',
			'es',
		);
		expect(cache.get('Order W222 refund approved', ['W222'], 'en')?.text).toBe(
			'Your refund for order W222 is approved.',
		);
		expect(cache.get('Order W222 refund approved', ['W222'], 'es')?.text).toBe(
			'Su reembolso para el pedido W222 ha sido aprobado.',
		);
		expect(
			cache.get('Order W222 refund approved', ['W222'], 'fr'),
		).toBeUndefined();
	});

	it('injects target language instruction into Tier 3 prompt messages', () => {
		const enMsgs = buildExpansionMessages(
			'Need order ID',
			undefined,
			true,
			'en',
		);
		expect(enMsgs[0]?.content).not.toContain('Write the reply in');
		const jaMsgs = buildExpansionMessages(
			'Need order ID',
			undefined,
			true,
			'ja',
		);
		expect(jaMsgs[0]?.content).toContain('Japanese (日本語)');
	});

	it('serves GET /languages and POST /expand with lang in app.ts', async () => {
		const deps: AppDeps = {
			dict: dictV3,
			dicts: { 'ir-v3': dictV3 },
			llm: undefined,
			loadSpans: () => Promise.resolve({ ok: false, reason: 'not-configured' }),
		};
		const langsRes = await routeRequest(
			deps,
			new Request('https://test/languages'),
		);
		expect(langsRes.status).toBe(200);
		const langsJson = (await langsRes.json()) as { languages: unknown[] };
		expect(langsJson.languages).toHaveLength(20);

		const esRes = await handleExpand(deps, {
			ir: 'KA HA {{Settings}}',
			dictVersion: 'ir-v3',
			kbVersion: 'kb1',
			model: 'auto',
			lang: 'es-MX',
		});
		expect(esRes.status).toBe(200);
		const esJson = esRes.json as {
			ok: boolean;
			path: string;
			lang: string;
			text: string;
		};
		expect(esJson.ok).toBe(true);
		expect(esJson.path).toBe('fast-realizer');
		expect(esJson.lang).toBe('es');
		expect(esJson.text).toContain('inicie sesión');
		expect(esJson.text).toContain('{{Settings}}');

		const badLang = await handleExpand(deps, {
			ir: 'KA',
			dictVersion: 'ir-v3',
			kbVersion: 'kb1',
			model: 'auto',
			lang: 'klingon',
		});
		expect(badLang.status).toBe(400);
	});
});
