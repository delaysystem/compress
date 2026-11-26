// Per-stage decompression latency instrumentation and HTTP Server-Timing formatting.

export type DecompressionTier = 'fast-realizer' | 'cache' | 'llm' | 'template';

export interface StageTimings {
	parseBodyMs: number;
	loadSpansMs: number;
	decodeIrMs: number;
	fastPathMs: number;
	cacheMs: number;
	buildPromptMs: number;
	llmExpandMs: number;
	postProcessMs: number;
	validateMs: number;
	repairMs: number;
	wrapMs: number;
	totalMs: number;
	tier: DecompressionTier;
	provider?: string;
}

export function roundMs(ms: number): number {
	return Math.round(ms * 1000) / 1000;
}

export function formatServerTiming(t: StageTimings): string {
	const entries: Array<[string, number]> = [
		['parse', t.parseBodyMs],
		['spans', t.loadSpansMs],
		['decode', t.decodeIrMs],
		['fast', t.fastPathMs],
		['cache', t.cacheMs],
		['prompt', t.buildPromptMs],
		['llm', t.llmExpandMs],
		['post', t.postProcessMs],
		['validate', t.validateMs],
		['repair', t.repairMs],
		['wrap', t.wrapMs],
		['total', t.totalMs],
	];
	return entries
		.filter(([, v]) => v > 0 || entries[entries.length - 1]?.[1] === v)
		.map(([k, v]) => `${k};dur=${roundMs(v)}`)
		.join(', ');
}
