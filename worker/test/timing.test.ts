import { describe, expect, it } from 'vitest';
import { formatServerTiming, type StageTimings } from '../src/timing.ts';

describe('timing helpers', () => {
	it('formats non-zero stages and total into Server-Timing header', () => {
		const t: StageTimings = {
			parseBodyMs: 0.1234,
			loadSpansMs: 0,
			decodeIrMs: 0.4567,
			fastPathMs: 0.25,
			cacheMs: 0,
			buildPromptMs: 0,
			llmExpandMs: 0,
			postProcessMs: 0,
			validateMs: 0.25,
			repairMs: 0,
			wrapMs: 0.01,
			totalMs: 1.09,
			tier: 'fast-realizer',
		};
		const header = formatServerTiming(t);
		expect(header).toContain('parse;dur=0.123');
		expect(header).toContain('decode;dur=0.457');
		expect(header).toContain('fast;dur=0.25');
		expect(header).toContain('total;dur=1.09');
		expect(header).not.toContain('llm;dur=');
	});
});
