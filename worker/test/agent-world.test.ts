import { describe, expect, it } from 'vitest';
import { renderTemplateFallback } from '../src/expander.ts';
import type { ExpansionAttempt, LadderDeps } from '../src/ladder.ts';
import { runLadder } from '../src/ladder.ts';

// Real-world customer-agent scenarios (run 051): the expansion evals all
// run with slotValues=[] (placeholders, no tool results). These pin the
// ladder end to end on tool-result-heavy turns — order IDs, amounts,
// addresses — where slot-coverage, not just entity-parity, decides.

function deps(
	preparedIr: string,
	slotValues: string[],
	expands: ExpansionAttempt[],
): LadderDeps {
	let i = 0;
	return {
		slotValues,
		templateRender: renderTemplateFallback,
		expandPrepared: (prep: string) => {
			expect(prep).toBe(preparedIr);
			const next = expands[Math.min(i, expands.length - 1)] ?? {
				text: '',
				finishReason: 'STOP',
				usage: null,
			};
			i += 1;
			return Promise.resolve(next);
		},
	};
}

const ATTEMPT = (text: string): ExpansionAttempt => ({
	text,
	finishReason: 'STOP',
	usage: null,
});

describe('agent-world refund with tool slots', () => {
	const IR = 'Refund approved\nOrder W2378156\nAmount $49.99\nDate Mar 12';
	const SLOTS = ['W2378156', '$49.99', 'Mar 12'];

	it('ships direct when all slot values render verbatim', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT(
					'Your refund of $49.99 for order W2378156 was approved Mar 12.',
				),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'direct' });
	});

	it('templates when the model drops a slot value', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT('Your refund of $49.99 was approved Mar 12.'),
				ATTEMPT('Your refund was approved, order on its way.'),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'template' });
		expect(r.text).toContain('W2378156');
	});

	it('repairs when the retry restores the dropped slot', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT('Your refund of $49.99 was approved Mar 12.'),
				ATTEMPT(
					'Your refund of $49.99 for order W2378156 was approved Mar 12.',
				),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'repaired' });
	});
});

describe('agent-world address change', () => {
	const IR =
		'Address updated\nShip to 123 Main Street, Anytown, USA 12345\nEffective immediately';
	const SLOTS = ['123 Main Street, Anytown, USA 12345'];

	it('ships direct when the full address renders verbatim', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT(
					'Your address is updated. We will ship to 123 Main Street, Anytown, USA 12345 effective immediately.',
				),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'direct' });
	});

	it('templates when the model shortens the address', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT('Your address is updated to 123 Main Street.'),
				ATTEMPT('Address updated effective immediately.'),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'template' });
		expect(r.text).toContain('12345');
	});
});

describe('agent-world tracking with identifier and link', () => {
	const IR =
		'Order shipped\nTracking 1Z999AA10123456784\nTrack at https://example.com/track/1Z999AA10123456784';
	const SLOTS = [
		'1Z999AA10123456784',
		'https://example.com/track/1Z999AA10123456784',
	];

	it('ships direct when identifier and link render verbatim', async () => {
		const r = await runLadder(
			IR,
			deps(IR, SLOTS, [
				ATTEMPT(
					'Your order shipped. Tracking number 1Z999AA10123456784: track it at https://example.com/track/1Z999AA10123456784.',
				),
			]),
		);
		expect(r).toMatchObject({ ok: true, path: 'direct' });
	});

	it('fails loud when even the template cannot cover slots', async () => {
		// Template renders the IR verbatim, so this only happens when the
		// IR itself lost a slot upstream: ok=false, never silent ship.
		const r = await runLadder(
			'Order shipped\nTracking number sent separately',
			deps('Order shipped\nTracking number sent separately', SLOTS, [
				ATTEMPT('Your order shipped.'),
				ATTEMPT('Your order shipped today.'),
			]),
		);
		expect(r.ok).toBe(false);
		expect(r.path).toBe('template');
	});
});

describe('agent-world voice and echo faults', () => {
	const IR = 'Reset link sent\nLink valid 24 hours';

	it('repairs a greeting leak on retry', async () => {
		const r = await runLadder(
			IR,
			deps(
				IR,
				[],
				[
					ATTEMPT('Hi there! Your reset link is sent, valid 24 hours.'),
					ATTEMPT('Your reset link is sent and valid 24 hours.'),
				],
			),
		);
		expect(r).toMatchObject({ ok: true, path: 'repaired' });
	});

	it('templates a verbatim echo the model cannot de-terse', async () => {
		const r = await runLadder(
			IR,
			deps(
				IR,
				[],
				[
					ATTEMPT('Reset link sent Link valid 24 hours'),
					ATTEMPT('Reset link sent Link valid 24 hours'),
				],
			),
		);
		expect(r).toMatchObject({ ok: true, path: 'template' });
	});
});
