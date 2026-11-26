// Fallback ladder (PLAN.md Step 3): expand -> repair expand -> deterministic
// template render. Single-call invariant: the ladder never spends a flagship
// call (no regen path exists); repairs are SLM calls, which are unbounded.
// Every fallback records its validator verdicts as structured diagnosis
// (agents2.md Rule 2).

import { REPAIR_ATTEMPTS } from './config.ts';
import type { SupportedLang } from './i18n.ts';
import {
	type ExpansionCheckInput,
	type ValidatorVerdict,
	validateExpansion,
} from './validator.ts';

export interface AttemptUsage {
	promptTokens: number;
	candidatesTokens: number;
	totalTokens: number;
}

export interface ExpansionAttempt {
	text: string;
	finishReason: string | null;
	usage: AttemptUsage | null;
}

export interface LadderDeps {
	expandPrepared: (
		preparedIr: string,
		repairHint?: string,
	) => Promise<ExpansionAttempt>;
	templateRender: (preparedIr: string) => string;
	slotValues: string[];
	/** SLM repair attempts. Default REPAIR_ATTEMPTS. 0 skips repair
	 * (base LFM3 repair is 0/10 live: pure latency, pass 0 for base
	 * callers; finetuned v12 follows REPAIR hints at 4/12, so keep
	 * the default for finetuned callers). */
	repairAttempts?: number;
	/** Skip the 2nd SLM call when v1 passes all 8 blocking checks and only
	 * carries a non-blocking terse-mirror style warning. Default false. */
	skipStyleRepair?: boolean;
	/** Deterministic pre-repair (e.g. stripping greeting/signoff leaks) run
	 * before spending a 2nd LLM call. Returning null skips deterministic repair. */
	fastRepair?: (output: string, verdict: ValidatorVerdict) => string | null;
	/** Target language for validation heuristics. Default 'en'. */
	lang?: SupportedLang;
}

export type LadderPath = 'direct' | 'repaired' | 'template';

export interface LadderTimings {
	llmMs: number;
	validateMs: number;
	repairMs: number;
}

export interface LadderResult {
	/** Caller must check: false means serve-with-caution/escalate, never silent ship. */
	ok: boolean;
	text: string;
	path: LadderPath;
	verdicts: ValidatorVerdict[];
	usage: AttemptUsage | null;
	timings?: LadderTimings;
}

export function buildRepairHint(verdict: ValidatorVerdict): string {
	const failed = verdict.checks
		.filter((c) => !c.pass)
		.map((c) => `${c.name}: ${c.detail}`);
	return `Previous attempt failed validation. Fix exactly these problems, change nothing else: ${failed.join(' / ')}`;
}

// Pure instruction, no narrative: weak models parrot "previous attempt failed
// validation" into the output (run 036 probes), tripping repair-parrot.
export function buildStyleHint(warnings: string[]): string {
	return (
		`Style fix (${warnings.join('; ')}): join related draft lines into ` +
		'flowing sentences with varied structure; never mirror the draft line ' +
		'by line. Output only the reply.'
	);
}

function hasStyleWarning(verdict: ValidatorVerdict): boolean {
	return (verdict.warnings ?? []).some((w) => w.startsWith('terse-mirror'));
}

function check(
	preparedIr: string,
	slotValues: string[],
	attempt: ExpansionAttempt,
	source?: 'model' | 'template',
	lang?: SupportedLang,
): ValidatorVerdict {
	const input: ExpansionCheckInput = {
		splicedIr: preparedIr,
		slotValues,
		output: attempt.text,
		finishReason: attempt.finishReason,
		...(source === undefined ? {} : { source }),
		...(lang === undefined ? {} : { lang }),
	};
	return validateExpansion(input);
}

export async function runLadder(
	preparedIr: string,
	deps: LadderDeps,
): Promise<LadderResult> {
	const verdicts: ValidatorVerdict[] = [];
	const usages: AttemptUsage[] = [];
	let llmMs = 0;
	let validateMs = 0;
	let repairMs = 0;
	const observe = (attempt: ExpansionAttempt): void => {
		if (attempt.usage !== null) {
			usages.push(attempt.usage);
		}
	};
	const summed = (): AttemptUsage | null =>
		usages.length === 0
			? null
			: {
					promptTokens: usages.reduce((s, u) => s + u.promptTokens, 0),
					candidatesTokens: usages.reduce((s, u) => s + u.candidatesTokens, 0),
					totalTokens: usages.reduce((s, u) => s + u.totalTokens, 0),
				};
	const timings = (): LadderTimings => ({ llmMs, validateMs, repairMs });

	const tLlm0 = performance.now();
	const first = await deps.expandPrepared(preparedIr);
	llmMs += performance.now() - tLlm0;
	observe(first);

	const tVal0 = performance.now();
	const v1 = check(preparedIr, deps.slotValues, first, undefined, deps.lang);
	validateMs += performance.now() - tVal0;
	verdicts.push(v1);
	if (v1.pass && (!hasStyleWarning(v1) || deps.skipStyleRepair === true)) {
		return {
			ok: true,
			text: first.text,
			path: 'direct',
			verdicts,
			usage: summed(),
			timings: timings(),
		};
	}
	if (v1.pass) {
		// Style path: all checks pass but the serve is terse. One free SLM
		// repair; on failure serve the passing original (the template serves
		// terser text, so it is never used here).
		const attempts = deps.repairAttempts ?? REPAIR_ATTEMPTS;
		if (attempts > 0) {
			const tRep0 = performance.now();
			const repair = await deps.expandPrepared(
				preparedIr,
				buildStyleHint(v1.warnings ?? []),
			);
			observe(repair);
			const vRepair = check(
				preparedIr,
				deps.slotValues,
				repair,
				undefined,
				deps.lang,
			);
			repairMs += performance.now() - tRep0;
			verdicts.push(vRepair);
			if (vRepair.pass && !hasStyleWarning(vRepair)) {
				return {
					ok: true,
					text: repair.text,
					path: 'repaired',
					verdicts,
					usage: summed(),
					timings: timings(),
				};
			}
		}
		return {
			ok: true,
			text: first.text,
			path: 'direct',
			verdicts,
			usage: summed(),
			timings: timings(),
		};
	}

	// Deterministic pre-repair (e.g. greeting/signoff leak strip) before spending
	// a 2nd LLM call: zero network latency when it resolves the failing check.
	if (deps.fastRepair !== undefined) {
		const tFastRep0 = performance.now();
		const fixedText = deps.fastRepair(first.text, v1);
		if (fixedText !== null && fixedText !== first.text) {
			const vFast = check(
				preparedIr,
				deps.slotValues,
				{
					text: fixedText,
					finishReason: first.finishReason,
					usage: null,
				},
				undefined,
				deps.lang,
			);
			repairMs += performance.now() - tFastRep0;
			verdicts.push(vFast);
			if (vFast.pass) {
				return {
					ok: true,
					text: fixedText,
					path: 'repaired',
					verdicts,
					usage: summed(),
					timings: timings(),
				};
			}
		}
	}

	let last = v1;
	const attempts = deps.repairAttempts ?? REPAIR_ATTEMPTS;
	for (let i = 0; i < attempts; i++) {
		const tRep0 = performance.now();
		const attempt = await deps.expandPrepared(
			preparedIr,
			buildRepairHint(last),
		);
		observe(attempt);
		last = check(preparedIr, deps.slotValues, attempt, undefined, deps.lang);
		repairMs += performance.now() - tRep0;
		verdicts.push(last);
		if (last.pass) {
			return {
				ok: true,
				text: attempt.text,
				path: 'repaired',
				verdicts,
				usage: summed(),
				timings: timings(),
			};
		}
	}

	// Template render involves no model: null finish reason (text heuristics only).
	// It is verbatim by design, so the model-only checks are skipped.
	const tTmpl0 = performance.now();
	const rendered = deps.templateRender(preparedIr);
	const vTemplate = check(
		preparedIr,
		deps.slotValues,
		{
			text: rendered,
			finishReason: null,
			usage: null,
		},
		'template',
		deps.lang,
	);
	validateMs += performance.now() - tTmpl0;
	verdicts.push(vTemplate);
	if (vTemplate.pass) {
		return {
			ok: true,
			text: rendered,
			path: 'template',
			verdicts,
			usage: summed(),
			timings: timings(),
		};
	}
	return {
		ok: false,
		text: rendered,
		path: 'template',
		verdicts,
		usage: summed(),
		timings: timings(),
	};
}
