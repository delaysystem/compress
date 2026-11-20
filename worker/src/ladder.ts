// Fallback ladder (PLAN.md Step 3): expand -> repair expand -> deterministic
// template render. Single-call invariant: the ladder never spends a flagship
// call (no regen path exists); repairs are SLM calls, which are unbounded.
// Every fallback records its validator verdicts as structured diagnosis
// (agents2.md Rule 2).

import { REPAIR_ATTEMPTS } from './config.ts';
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
}

export type LadderPath = 'direct' | 'repaired' | 'template';

export interface LadderResult {
	/** Caller must check: false means serve-with-caution/escalate, never silent ship. */
	ok: boolean;
	text: string;
	path: LadderPath;
	verdicts: ValidatorVerdict[];
	usage: AttemptUsage | null;
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
): ValidatorVerdict {
	const input: ExpansionCheckInput = {
		splicedIr: preparedIr,
		slotValues,
		output: attempt.text,
		finishReason: attempt.finishReason,
		...(source === undefined ? {} : { source }),
	};
	return validateExpansion(input);
}

export async function runLadder(
	preparedIr: string,
	deps: LadderDeps,
): Promise<LadderResult> {
	const verdicts: ValidatorVerdict[] = [];
	const usages: AttemptUsage[] = [];
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

	const first = await deps.expandPrepared(preparedIr);
	observe(first);
	const v1 = check(preparedIr, deps.slotValues, first);
	verdicts.push(v1);
	if (v1.pass && !hasStyleWarning(v1)) {
		return {
			ok: true,
			text: first.text,
			path: 'direct',
			verdicts,
			usage: summed(),
		};
	}
	if (v1.pass) {
		// Style path: all checks pass but the serve is terse. One free SLM
		// repair; on failure serve the passing original (the template serves
		// terser text, so it is never used here).
		const attempts = deps.repairAttempts ?? REPAIR_ATTEMPTS;
		if (attempts > 0) {
			const repair = await deps.expandPrepared(
				preparedIr,
				buildStyleHint(v1.warnings ?? []),
			);
			observe(repair);
			const vRepair = check(preparedIr, deps.slotValues, repair);
			verdicts.push(vRepair);
			if (vRepair.pass && !hasStyleWarning(vRepair)) {
				return {
					ok: true,
					text: repair.text,
					path: 'repaired',
					verdicts,
					usage: summed(),
				};
			}
		}
		return {
			ok: true,
			text: first.text,
			path: 'direct',
			verdicts,
			usage: summed(),
		};
	}

	let last = v1;
	const attempts = deps.repairAttempts ?? REPAIR_ATTEMPTS;
	for (let i = 0; i < attempts; i++) {
		const attempt = await deps.expandPrepared(
			preparedIr,
			buildRepairHint(last),
		);
		observe(attempt);
		last = check(preparedIr, deps.slotValues, attempt);
		verdicts.push(last);
		if (last.pass) {
			return {
				ok: true,
				text: attempt.text,
				path: 'repaired',
				verdicts,
				usage: summed(),
			};
		}
	}

	// Template render involves no model: null finish reason (text heuristics only).
	// It is verbatim by design, so the model-only checks are skipped.
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
	);
	verdicts.push(vTemplate);
	if (vTemplate.pass) {
		return {
			ok: true,
			text: rendered,
			path: 'template',
			verdicts,
			usage: summed(),
		};
	}
	return {
		ok: false,
		text: rendered,
		path: 'template',
		verdicts,
		usage: summed(),
	};
}
