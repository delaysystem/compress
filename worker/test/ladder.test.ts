import { describe, expect, it } from 'vitest';
import {
	buildRepairHint,
	buildStyleHint,
	type ExpansionAttempt,
	type LadderDeps,
	runLadder,
} from '../src/ladder.ts';

const IR = 'plain telegraphic line';
const GOOD: ExpansionAttempt = {
	text: 'A clean fluent reply with no entities at all.',
	finishReason: 'STOP',
	usage: null,
};
const BAD: ExpansionAttempt = { text: '', finishReason: 'STOP', usage: null };

function deps(
	over: Partial<LadderDeps> & { expands: ExpansionAttempt[] },
): LadderDeps & { hints: Array<string | undefined> } {
	const hints: Array<string | undefined> = [];
	let i = 0;
	return {
		hints,
		slotValues: [],
		templateRender: () => GOOD.text,
		...over,
		expandPrepared: (preparedIr: string, hint?: string) => {
			hints.push(hint);
			expect(preparedIr).toBe(IR);
			const next = over.expands[Math.min(i, over.expands.length - 1)] ?? BAD;
			i += 1;
			return Promise.resolve(next);
		},
	};
}

describe('runLadder', () => {
	it('ships the direct path on first-pass validation', async () => {
		const d = deps({ expands: [GOOD] });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'direct', text: GOOD.text });
		expect(r.verdicts).toHaveLength(1);
		expect(d.hints).toEqual([undefined]);
	});

	it('repairs once with the diagnosis as hint, then ships', async () => {
		const d = deps({ expands: [BAD, GOOD] });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'repaired' });
		expect(r.verdicts).toHaveLength(2);
		expect(d.hints[1]).toContain('completeness');
	});

	it('falls back to template render when repair fails', async () => {
		const d = deps({ expands: [BAD, BAD] });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'template', text: GOOD.text });
	});

	it('skips safety repair entirely when repairAttempts is 0 (run 038)', async () => {
		// LFM3 repair is 0/10 live: the attempt is pure latency. Zero skips it.
		const d = deps({ expands: [BAD, GOOD], repairAttempts: 0 });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'template', text: GOOD.text });
		expect(r.verdicts).toHaveLength(2);
		expect(d.hints).toEqual([undefined]);
	});

	it('honors repairAttempts above the default', async () => {
		const d = deps({ expands: [BAD, BAD, GOOD], repairAttempts: 2 });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'repaired' });
		expect(d.hints).toHaveLength(3);
	});

	it('serves the verbatim template render without echo-cascade (run 034)', async () => {
		// The deterministic template IS the draft: the echo check must skip it.
		const echo: ExpansionAttempt = {
			text: IR,
			finishReason: 'STOP',
			usage: null,
		};
		const d = deps({ expands: [echo, echo], templateRender: () => IR });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'template', text: IR });
		expect(r.verdicts).toHaveLength(3);
		const noEcho = r.verdicts[2]?.checks.find((c) => c.name === 'no-echo');
		expect(noEcho).toMatchObject({ pass: true });
		expect(noEcho?.detail).toContain('skipped');
	});

	it('serves template with ok=false when the template also fails', async () => {
		const d = deps({ expands: [BAD, BAD], templateRender: () => BAD.text });
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: false, path: 'template' });
	});

	it('sums usage across attempts', async () => {
		const u = (n: number) => ({
			promptTokens: n,
			candidatesTokens: n,
			totalTokens: n * 2,
		});
		const d = deps({
			expands: [
				{ ...BAD, usage: u(10) },
				{ ...GOOD, usage: u(20) },
			],
		});
		const r = await runLadder(IR, d);
		expect(r).toMatchObject({ ok: true, path: 'repaired' });
		expect(r.usage).toEqual({
			promptTokens: 30,
			candidatesTokens: 30,
			totalTokens: 60,
		});
	});

	it('reports null usage when no attempt carries any', async () => {
		const d = deps({ expands: [GOOD] });
		const r = await runLadder(IR, d);
		expect(r.usage).toBeNull();
	});
});

describe('buildStyleHint', () => {
	it('carries the warning without parrot-bait words', () => {
		const hint = buildStyleHint(['terse-mirror: runCov=0.78 novel=0.09']);
		expect(hint).toContain('terse-mirror');
		expect(hint).not.toMatch(/previous|validation/i);
	});
});

describe('runLadder style path (run 034 bitext-24168 banked pair)', () => {
	const TIR =
		'Sign in with currentcredentials\n' +
		'Open {{Settings}} or {{Profile}}\n' +
		'Find {{Account Change}}, {{Upgrade Account}}\n' +
		'Select {{Account Type}}\n' +
		'Follow prompts to confirm account switch';
	const TERSE: ExpansionAttempt = {
		text:
			'Sign in with current credentials. Open {{Settings}} or {{Profile}}. ' +
			'Find {{Account Change}}, {{Upgrade Account}}. Select {{Account Type}}. ' +
			'Follow prompts to confirm account switch.',
		finishReason: 'STOP',
		usage: null,
	};
	const FLUENT: ExpansionAttempt = {
		text:
			'Sign in with your current credentials and open {{Settings}} or {{Profile}}. ' +
			'Find {{Account Change}} or {{Upgrade Account}}, select {{Account Type}}, ' +
			'then follow the prompts to confirm the account switch.',
		finishReason: 'STOP',
		usage: null,
	};

	function styleDeps(
		over: Partial<LadderDeps> & { expands: ExpansionAttempt[] },
	): LadderDeps & {
		hints: Array<string | undefined>;
	} {
		const hints: Array<string | undefined> = [];
		let i = 0;
		return {
			hints,
			slotValues: [],
			templateRender: (s: string) => s.trim(),
			...over,
			expandPrepared: (_preparedIr: string, hint?: string) => {
				hints.push(hint);
				const next =
					over.expands[Math.min(i, over.expands.length - 1)] ?? TERSE;
				i += 1;
				return Promise.resolve(next);
			},
		};
	}

	it('ships the repair when it clears the warning', async () => {
		const d = styleDeps({ expands: [TERSE, FLUENT] });
		const r = await runLadder(TIR, d);
		expect(r).toMatchObject({ ok: true, path: 'repaired', text: FLUENT.text });
		expect(d.hints).toHaveLength(2);
		expect(d.hints[1]).toContain('terse-mirror');
	});

	it('ships the original terse text when style repair stays terse', async () => {
		// No regen exists: single-call invariant. The passing original serves.
		const d = styleDeps({ expands: [TERSE, TERSE] });
		const r = await runLadder(TIR, d);
		expect(r).toMatchObject({ ok: true, path: 'direct', text: TERSE.text });
		expect(r.verdicts).toHaveLength(2);
	});

	it('never attempts style repair without a warning', async () => {
		const d = styleDeps({ expands: [FLUENT] });
		const r = await runLadder(TIR, d);
		expect(r).toMatchObject({ ok: true, path: 'direct' });
		expect(d.hints).toEqual([undefined]);
	});

	it('serves warned original directly when repairAttempts is 0', async () => {
		const d = styleDeps({ expands: [TERSE], repairAttempts: 0 });
		const r = await runLadder(TIR, d);
		expect(r).toMatchObject({ ok: true, path: 'direct', text: TERSE.text });
		expect(d.hints).toEqual([undefined]);
		expect(r.verdicts).toHaveLength(1);
	});
});

describe('buildRepairHint', () => {
	it('names failed checks with details', () => {
		const hint = buildRepairHint({
			pass: false,
			checks: [
				{ name: 'completeness', pass: true, detail: 'ok' },
				{ name: 'slot-coverage', pass: false, detail: 'missing slots: Mar 12' },
			],
		});
		expect(hint).toContain('slot-coverage');
		expect(hint).toContain('Mar 12');
		expect(hint).not.toContain('completeness: ok');
	});
});
