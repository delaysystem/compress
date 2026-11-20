import { describe, expect, it } from 'vitest';
import { validateExpansion } from '../src/validator.ts';

const IR = 'Refund $49.99 approved Mar 12';
const SLOTS = ['$49.99', 'Mar 12'];

describe('validateExpansion', () => {
	it('passes a faithful expansion', () => {
		const v = validateExpansion({
			splicedIr: IR,
			slotValues: SLOTS,
			output: 'Your refund of $49.99 was approved Mar 12.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(true);
		expect(v.checks.map((c) => c.name)).toEqual([
			'completeness',
			'slot-coverage',
			'entity-parity',
			'well-formedness',
			'no-echo',
			'no-meta',
			'no-role-reversal',
			'no-greeting',
		]);
	});

	it('fails truncated output', () => {
		const v = validateExpansion({
			splicedIr: IR,
			slotValues: SLOTS,
			output: 'Your refund of $49.99 was approved',
			finishReason: 'MAX_TOKENS',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[0]).toMatchObject({ name: 'completeness', pass: false });
	});

	it('fails dropped slot values even when entities reword equivalently', () => {
		// 'March 12' canonicalizes like 'Mar 12' (parity holds) but the raw tool
		// value 'Mar 12' is gone: slot-coverage must still fail. Strictness is the point.
		const v = validateExpansion({
			splicedIr: IR,
			slotValues: SLOTS,
			output: 'Your refund of $49.99 was approved March 12.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[1]).toMatchObject({ name: 'slot-coverage', pass: false });
		expect(v.checks[2]).toMatchObject({ name: 'entity-parity', pass: true });
	});

	it('fails dropped entities', () => {
		const v = validateExpansion({
			splicedIr: IR,
			slotValues: [],
			output: 'Your refund was approved Mar 12.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[2]?.detail).toContain('missing=');
	});

	it('fails added entities', () => {
		const v = validateExpansion({
			splicedIr: IR,
			slotValues: [],
			output:
				'Your refund of $49.99 was approved Mar 12. Track it at https://example.com/t/9.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[2]?.detail).toContain('extra=');
	});

	it('passes entity-parity when expansion re-adds list numerals', () => {
		const v = validateExpansion({
			splicedIr: 'open newsletter, click unsubscribe link',
			slotValues: [],
			output: '1. Open the newsletter.\n2. Click the unsubscribe link.',
			finishReason: 'STOP',
		});
		expect(v.checks[2]).toMatchObject({ name: 'entity-parity', pass: true });
	});

	it('passes benign placeholder merges (mentions are set-scoped)', () => {
		const v = validateExpansion({
			splicedIr: 'order from {{Delivery City}}; we ship to {{Delivery City}}',
			slotValues: [],
			output: 'You can order from {{Delivery City}}; we ship right to you.',
			finishReason: 'STOP',
		});
		expect(v.checks[2]).toMatchObject({ name: 'entity-parity', pass: true });
	});

	it('still fails money-amount merges (numbers stay multiset)', () => {
		const v = validateExpansion({
			splicedIr: '$5 fee and $5 tax',
			slotValues: [],
			output: 'Your $5 fee is due.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[2]).toMatchObject({ name: 'entity-parity', pass: false });
	});

	it('fails unbalanced double braces', () => {
		const v = validateExpansion({
			splicedIr: 'order from {{Delivery City}} here',
			slotValues: [],
			output: 'order from {{Delivery City)} here',
			finishReason: 'STOP',
		});
		expect(v.checks[3]).toMatchObject({
			name: 'well-formedness',
			pass: false,
		});
		expect(v.checks[3]?.detail).toContain('unbalanced-double-braces');
	});

	it('fails ellipsis slugs and rule recitation in no-meta', () => {
		const v = validateExpansion({
			splicedIr: 'do the thing',
			slotValues: [],
			output: 'Do the thing. {{...}} One fact per line, no greeting or filler.',
			finishReason: 'STOP',
		});
		expect(v.checks[3]).toMatchObject({
			name: 'well-formedness',
			pass: true,
		});
		expect(v.checks[5]).toMatchObject({ name: 'no-meta', pass: false });
		expect(v.checks[5]?.detail).toContain('ellipsis-slug');
		expect(v.checks[5]?.detail).toContain('rule-recitation');
		expect(v.checks[5]?.detail).toContain('signoff-recitation');
	});

	it('fails enumerated meta and prompt quotation in no-meta', () => {
		const v = validateExpansion({
			splicedIr: 'do the thing',
			slotValues: [],
			output:
				'Line 1: do the thing, per synthetic-corpus rule, pinned: 2026 note.',
			finishReason: 'STOP',
		});
		expect(v.checks[3]).toMatchObject({
			name: 'well-formedness',
			pass: true,
		});
		expect(v.checks[5]?.detail).toContain('enumerated-meta');
		expect(v.checks[5]?.detail).toContain('prompt-quotation');
		expect(v.checks[5]?.detail).toContain('header-quotation');
	});
});

describe('validateExpansion no-echo (run 034 LFM3 banked pairs)', () => {
	const ECHO_IR = 'order number {{Order Number}}\nSpecify specific changes';
	const ECHO_OUT = 'order number {{Order Number}}\nSpecify specific changes';
	const LIST_IR =
		'Eligible for refund: Product/Service Defect\n' +
		'Eligible for refund: Cancellation within Grace Period\n' +
		'Eligible for refund: Unauthorized Charges\n' +
		'Eligible for refund: Event Cancellation\n' +
		'Eligible for refund: Duplicate Charges\n' +
		'Eligible for refund: Non-receipt of Goods\n' +
		'Policies vary by vendor or service provider\n' +
		'check terms and conditions\n' +
		'provide order number';
	const LIST_OUT =
		'You are eligible for a refund due to Product/Service Defect, ' +
		'Cancellation within Grace Period, Unauthorized Charges, Event ' +
		'Cancellation, Duplicate Charges, Non-receipt of Goods. Policies vary ' +
		'by vendor or service provider. Please check terms and conditions. ' +
		'Provide order number.';

	it('fails a verbatim echo (bitext-1078)', () => {
		const v = validateExpansion({
			splicedIr: ECHO_IR,
			slotValues: [],
			output: ECHO_OUT,
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: false });
	});

	it('passes a faithful list render (bitext-6135)', () => {
		const v = validateExpansion({
			splicedIr: LIST_IR,
			slotValues: [],
			output: LIST_OUT,
			finishReason: 'STOP',
		});
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: true });
		expect(v.pass).toBe(true);
	});

	it('skips a verbatim serve of an already-fluent draft (bitext-7446)', () => {
		// Frontier models return fluent drafts verbatim: nothing to expand,
		// so verbatim is correct and must not fail (run 036 corpus proof).
		const fluent =
			'To lodge a claim, provide specific details of the complaint and any supporting documentation.';
		const v = validateExpansion({
			splicedIr: fluent,
			slotValues: [],
			output: fluent,
			finishReason: 'STOP',
		});
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: true });
		expect(v.checks[4]?.detail).toContain('fluent draft');
		expect(v.pass).toBe(true);
	});

	it('passes a short fluent expansion', () => {
		const v = validateExpansion({
			splicedIr: 'Complaint: complaint\ncontact customer service for steps',
			slotValues: [],
			output:
				'I’m sorry to hear about your experience and want to help resolve it. ' +
				'Please contact customer service for the steps needed to address this issue.',
			finishReason: 'STOP',
		});
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: true });
		expect(v.pass).toBe(true);
	});
});

describe('validateExpansion no-meta (run 034 LFM3 banked pairs)', () => {
	it('fails draft-mention meta-talk (bitext-2482)', () => {
		const v = validateExpansion({
			splicedIr: 'Describe address editing issue',
			slotValues: [],
			output:
				'I’m writing to address the issue you mentioned about editing an ' +
				'address in your support draft. Please review the details below and ' +
				'let me know how I can help resolve it.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[5]).toMatchObject({ name: 'no-meta', pass: false });
		expect(v.checks[5]?.detail).toContain('draft-mention');
	});

	it('passes when draft appears only inside a slot value', () => {
		const v = validateExpansion({
			splicedIr: 'review the attached draft today',
			slotValues: ['review the attached draft'],
			output: 'Please review the attached draft today.',
			finishReason: 'STOP',
		});
		expect(v.checks[5]).toMatchObject({ name: 'no-meta', pass: true });
		expect(v.pass).toBe(true);
	});

	it('fails repair-parrot self-reference but passes bare validation-failed', () => {
		const bad = validateExpansion({
			splicedIr: 'fix login loop',
			slotValues: [],
			output:
				'A previous validation failed on this. To fix the login loop, reset your password.',
			finishReason: 'STOP',
		});
		expect(bad.checks[5]).toMatchObject({ name: 'no-meta', pass: false });
		expect(bad.checks[5]?.detail).toContain('repair-parrot');
		const good = validateExpansion({
			splicedIr: 'code validation failed retry',
			slotValues: [],
			output: 'Code validation failed, please retry your code.',
			finishReason: 'STOP',
		});
		expect(good.checks[5]).toMatchObject({ name: 'no-meta', pass: true });
		expect(good.pass).toBe(true);
	});

	it('fails a REPLY: label but passes Reply without colon', () => {
		const bad = validateExpansion({
			splicedIr: 'Visit site',
			slotValues: [],
			output: 'REPLY: Visit the site today.',
			finishReason: 'STOP',
		});
		expect(bad.checks[5]).toMatchObject({ name: 'no-meta', pass: false });
		expect(bad.checks[5]?.detail).toContain('reply-label');
		const good = validateExpansion({
			splicedIr: 'reply newsletter emails word unsubscribe',
			slotValues: [],
			output: 'Reply to this email to unsubscribe from the newsletter.',
			finishReason: 'STOP',
		});
		expect(good.checks[5]).toMatchObject({ name: 'no-meta', pass: true });
	});
});

describe('validateExpansion template source', () => {
	const ECHO_IR = 'order number {{Order Number}}\nSpecify specific changes';

	it('fails echo and meta as a model output', () => {
		const v = validateExpansion({
			splicedIr: ECHO_IR,
			slotValues: [],
			output: ECHO_IR,
			finishReason: 'STOP',
		});
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: false });
	});

	it('passes the verbatim template render (echo skipped)', () => {
		const v = validateExpansion({
			splicedIr: ECHO_IR,
			slotValues: [],
			output: ECHO_IR,
			finishReason: null,
			source: 'template',
		});
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: true });
		expect(v.checks[4]?.detail).toContain('skipped');
		expect(v.pass).toBe(true);
	});

	it('passes slot-contained meta words in the template render', () => {
		const v = validateExpansion({
			splicedIr: 'review the attached draft',
			slotValues: ['review the attached draft'],
			output: 'review the attached draft',
			finishReason: null,
			source: 'template',
		});
		expect(v.checks[5]).toMatchObject({ name: 'no-meta', pass: true });
		expect(v.pass).toBe(true);
	});
});

describe('validateExpansion no-role-reversal (run 034 LFM3 bitext-22080)', () => {
	// Real banked output with the meta word removed: without the role check,
	// every other check passes and the reversal ships.
	const DRAFT = 'service feedback request\nshare specific experience details';
	const REVERSED =
		'I’m writing to share my specific experience details regarding your ' +
		'service feedback request. Please let me know how I can provide more ' +
		'information or address any concerns you have about our support case.';

	it('fails customer-voice my+experience the model introduced', () => {
		const v = validateExpansion({
			splicedIr: DRAFT,
			slotValues: [],
			output: REVERSED,
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
		expect(v.checks[6]?.detail).toContain('my specific');
		for (const i of [0, 1, 2, 3, 4, 5]) {
			expect(v.checks[i]?.pass).toBe(true);
		}
	});

	it('passes agent idioms without customer nouns', () => {
		const v = validateExpansion({
			splicedIr: 'help customer today',
			slotValues: [],
			output: 'I’ll do my best to help you today.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
		expect(v.pass).toBe(true);
	});

	it('passes quoted and slot-contained customer voice', () => {
		const quoted = validateExpansion({
			splicedIr: 'customer says urgent',
			slotValues: [],
			output: 'You said "my issue is urgent" — let me help.',
			finishReason: 'STOP',
		});
		expect(quoted.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
		const slotted = validateExpansion({
			splicedIr: 'my issue is the login loop',
			slotValues: ['my issue is the login loop'],
			output: 'I understand my issue is the login loop and will fix it.',
			finishReason: 'STOP',
		});
		expect(slotted.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
	});

	it('fails beneficiary-me reversals without my (run 037)', () => {
		const v = validateExpansion({
			splicedIr: 'reset password link',
			slotValues: [],
			output: 'I cannot log in, please help me reset it today.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(false);
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
		expect(v.checks[6]?.detail).toContain('help me');
	});

	it('passes agent let-me-help (me before the verb)', () => {
		const v = validateExpansion({
			splicedIr: 'reset password link',
			slotValues: [],
			output: 'Let me help you reset it today.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
		expect(v.pass).toBe(true);
	});

	it('passes beneficiary-me the draft itself introduced', () => {
		const v = validateExpansion({
			splicedIr: 'help me reset password',
			slotValues: [],
			output: 'To help me reset password, click the link.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
	});

	it('passes my+noun the draft itself introduced', () => {
		const v = validateExpansion({
			splicedIr: 'my problem continues',
			slotValues: [],
			output: 'I see my problem continues, let me escalate it for you.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
	});

	it('fails my+account with novel continuation past a UI label (bitext-23043)', () => {
		// Draft UI label "Open My Account" inoculates the bigram; the trigram
		// (my account yesterday) is novel, so the customer-voice claim fails.
		const v = validateExpansion({
			splicedIr: 'Open My Account settings',
			slotValues: [],
			output: 'I added it to my account yesterday.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
	});

	it('passes UI-label echoes with draft-identical continuation', () => {
		const v = validateExpansion({
			splicedIr: 'Open My Account settings',
			slotValues: [],
			output: 'Open My Account settings now.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
	});

	it('passes single-quoted UI labels (v12 bitext-23043)', () => {
		// Same class as double-quoted spans: the model quotes a draft label,
		// it does not claim the account as its own.
		const v = validateExpansion({
			splicedIr: "Log in to account | 'My Account' 'Profile'",
			slotValues: [],
			output:
				"To log in to your account, go to the 'My Account' or " +
				"'Profile' section and continue.",
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
	});

	it('does not treat contractions as quote pairs', () => {
		const v = validateExpansion({
			splicedIr: 'reset password link',
			slotValues: [],
			output: "I can't fix my issue today, but I'll escalate it for you.",
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
	});

	it('fails my+sign-up customer claims (bitext-21810)', () => {
		const v = validateExpansion({
			splicedIr: 'Describe sign-up problem',
			slotValues: [],
			output: 'I completed my sign-up today without issues.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
		expect(v.checks[6]?.detail).toContain('my sign-up');
	});

	it('fails guide-me receiving frames (bitext-23043)', () => {
		const v = validateExpansion({
			splicedIr: 'add shipping address',
			slotValues: [],
			output: 'Please guide me through the reset steps.',
			finishReason: 'STOP',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: false,
		});
		expect(v.checks[6]?.detail).toContain('guide me');
	});

	it('skips the check for the template render', () => {
		const v = validateExpansion({
			splicedIr: 'my issue persists',
			slotValues: [],
			output: 'my issue persists',
			finishReason: null,
			source: 'template',
		});
		expect(v.checks[6]).toMatchObject({
			name: 'no-role-reversal',
			pass: true,
		});
		expect(v.checks[6]?.detail).toContain('skipped');
		expect(v.pass).toBe(true);
	});
});

describe('validateExpansion terse-mirror warnings (run 034 LFM3 bitext-24168)', () => {
	const DRAFT =
		'Sign in with currentcredentials\n' +
		'Open {{Settings}} or {{Profile}}\n' +
		'Find {{Account Change}}, {{Upgrade Account}}\n' +
		'Select {{Account Type}}\n' +
		'Follow prompts to confirm account switch';
	const TERSE =
		'Sign in with current credentials. Open {{Settings}} or {{Profile}}. ' +
		'Find {{Account Change}}, {{Upgrade Account}}. Select {{Account Type}}. ' +
		'Follow prompts to confirm account switch.';
	const JOINED =
		'You are eligible for a refund due to Product/Service Defect, ' +
		'Cancellation within Grace Period and Unauthorized Charges.';

	it('warns on a line-by-line polish without blocking it', () => {
		const v = validateExpansion({
			splicedIr: DRAFT,
			slotValues: [],
			output: TERSE,
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(true);
		expect(v.warnings).toHaveLength(1);
		expect(v.warnings?.[0]).toContain('terse-mirror');
	});

	it('stays silent on a fluent-verbatim serve', () => {
		const fluent =
			'To lodge a claim, provide specific details of the complaint and any supporting documentation.';
		const v = validateExpansion({
			splicedIr: fluent,
			slotValues: [],
			output: fluent,
			finishReason: 'STOP',
		});
		expect(v.warnings).toEqual([]);
	});

	it('stays silent on joined and normal expansions', () => {
		const joined = validateExpansion({
			splicedIr:
				'Eligible for refund: Product/Service Defect\n' +
				'Eligible for refund: Cancellation within Grace Period\n' +
				'Eligible for refund: Unauthorized Charges',
			slotValues: [],
			output: JOINED,
			finishReason: 'STOP',
		});
		expect(joined.warnings).toEqual([]);
		const normal = validateExpansion({
			splicedIr: 'Complaint: complaint\ncontact customer service for steps',
			slotValues: [],
			output:
				'I’m sorry to hear about your experience and want to help resolve it. ' +
				'Please contact customer service for the steps needed to address this issue.',
			finishReason: 'STOP',
		});
		expect(normal.warnings).toEqual([]);
	});
});

describe('validateExpansion no-greeting (run 041 Qwen-minimal banked rows)', () => {
	it('fails greeting openers (bitext-17856, bitext-3178)', () => {
		for (const output of [
			'Thank you for your request to unsubscribe from our newsletter.',
			'Hi there! To help you find the withdrawal penalties, follow these steps.',
		]) {
			const v = validateExpansion({
				splicedIr: 'unsubscribe request',
				slotValues: [],
				output,
				finishReason: 'STOP',
			});
			expect(v.checks[7]).toMatchObject({
				name: 'no-greeting',
				pass: false,
			});
			expect(v.checks[7]?.detail).toContain('greeting-open');
		}
	});

	it('fails thanks and sign-off closes', () => {
		const thanks = validateExpansion({
			splicedIr: 'review complaint',
			slotValues: [],
			output: 'We reviewed it. Thank you for bringing it to our attention.',
			finishReason: 'STOP',
		});
		expect(thanks.checks[7]).toMatchObject({
			name: 'no-greeting',
			pass: false,
		});
		expect(thanks.checks[7]?.detail).toContain('thanks-close');
		const signoff = validateExpansion({
			splicedIr: 'specify changes',
			slotValues: [],
			output:
				'Please specify the changes.\n\nBest regards,\nCustomer Support Team',
			finishReason: 'STOP',
		});
		expect(signoff.checks[7]).toMatchObject({
			name: 'no-greeting',
			pass: false,
		});
		expect(signoff.checks[7]?.detail).toContain('signoff-close');
	});

	it('passes mid-text thanks and clean replies', () => {
		const mid = validateExpansion({
			splicedIr: 'review case',
			slotValues: [],
			output:
				'We reviewed your case. Thank you for the details; we will proceed now. The refund is approved.',
			finishReason: 'STOP',
		});
		expect(mid.checks[7]).toMatchObject({ name: 'no-greeting', pass: true });
		const clean = validateExpansion({
			splicedIr: 'contact customer service for steps',
			slotValues: [],
			output: 'Please contact customer service for the steps.',
			finishReason: 'STOP',
		});
		expect(clean.checks[7]).toMatchObject({ name: 'no-greeting', pass: true });
		expect(clean.pass).toBe(true);
	});

	it('skips the check for the template render', () => {
		const v = validateExpansion({
			splicedIr: 'Hello world program',
			slotValues: [],
			output: 'Hello world program',
			finishReason: null,
			source: 'template',
		});
		expect(v.checks[7]).toMatchObject({ name: 'no-greeting', pass: true });
		expect(v.checks[7]?.detail).toContain('skipped');
	});
});

describe('validateExpansion anchor-parrot strip (run 046)', () => {
	it('fails echo hidden behind parroted prompt words', () => {
		const v = validateExpansion({
			splicedIr: 'Provide {{Tracking Number}} {{Order Number}}',
			slotValues: ['{{Tracking Number}}', '{{Order Number}}'],
			output:
				'Provide {{Tracking Number}} {{Order Number}}\n' +
				'Must include these exact values: {{Tracking Number}}, {{Order Number}}.',
			finishReason: 'STOP',
		});
		// Parrot words would inflate novelty past the echo floor; stripped,
		// the verbatim echo fails loud.
		expect(v.checks[4]).toMatchObject({ name: 'no-echo', pass: false });
		expect(v.pass).toBe(false);
	});

	it('fails entities present only in the parrot line', () => {
		const v = validateExpansion({
			splicedIr: 'Serve {{Delivery City}}',
			slotValues: ['{{Delivery City}}'],
			output:
				'We serve your area.\n' +
				'Must include these exact values: {{Delivery City}}.',
			finishReason: 'STOP',
		});
		expect(v.checks[1]).toMatchObject({ name: 'slot-coverage', pass: false });
		expect(v.checks[2]).toMatchObject({ name: 'entity-parity', pass: false });
	});

	it('leaves mid-line must-include prose untouched', () => {
		const v = validateExpansion({
			splicedIr: 'contact customer service for steps',
			slotValues: [],
			output: 'You must include these exact values in your form.',
			finishReason: 'STOP',
		});
		expect(v.pass).toBe(true);
	});
});
