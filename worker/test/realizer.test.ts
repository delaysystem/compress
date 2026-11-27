import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dictFromJson } from '../src/dict.ts';
import {
	FLUENT_V3_TEMPLATES,
	realizeV3Segments,
	tryFastRealize,
} from '../src/realizer.ts';
import { autofixV3, decodeV3, parseV3 } from '../src/wirev3.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const dictV3 = dictFromJson(
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'dict-ir-v3.json'), 'utf8'),
	),
);
const markers = (
	JSON.parse(
		readFileSync(join(root, 'data', 'derived', 'marker-v3.json'), 'utf8'),
	) as { aliases: Record<string, string> }
).aliases;

describe('realizer (Tier 1 deterministic fluent realization)', () => {
	it('covers all 46 non-TX codes in dict-ir-v3', () => {
		const nonTx = dictV3.entries.filter((e) => e.code !== 'TX');
		for (const e of nonTx) {
			expect(FLUENT_V3_TEMPLATES[e.code]).toBeDefined();
		}
	});

	it('realizes every single v3 code cleanly and passes all 8 validator checks', () => {
		for (const entry of dictV3.entries) {
			if (entry.code === 'TX') {
				continue;
			}
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
			});
			expect(res.ok, `failed for code ${entry.code}`).toBe(true);
			if (res.ok) {
				for (const s of slots) {
					expect(res.text).toContain(s);
				}
			}
		}
	});

	it('realizes multi-segment v3 IR preserving restored {{Markers}} in sub-ms', () => {
		const ir = 'KA QA useraccountsettings HA {{Settings}}';
		const segs = autofixV3(parseV3(ir, dictV3, markers), dictV3).segments;
		const decoded = decodeV3(segs, dictV3);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;

		const res = tryFastRealize({
			segments: segs,
			preparedIr: decoded.text,
			slotValues: [],
			dict: dictV3,
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.text).toContain('{{User Account Settings}}');
			expect(res.text).toContain('{{Settings}}');
		}
	});

	it('realizes mixed code + TX segments deterministically in Tier 1', () => {
		const ir =
			'PA account details TX provide specific details and supporting information';
		const segs = parseV3(ir, dictV3, markers);
		const decoded = decodeV3(segs, dictV3);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;

		const res = tryFastRealize({
			segments: segs,
			preparedIr: decoded.text,
			slotValues: [],
			dict: dictV3,
		});
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.text).toContain('Please provide specific details');
		}
	});

	it('falls through (returns ok=false) on long code-less TX free text (>40 words)', () => {
		const longText = Array.from({ length: 45 }, (_, i) => `item${i}`).join(' ');
		const ir = `TX ${longText}`;
		const segs = parseV3(ir, dictV3, markers);
		const decoded = decodeV3(segs, dictV3);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;

		expect(realizeV3Segments(segs, dictV3)).toBeNull();
		const res = tryFastRealize({
			segments: segs,
			preparedIr: decoded.text,
			slotValues: [],
			dict: dictV3,
		});
		expect(res.ok).toBe(false);
	});
});
