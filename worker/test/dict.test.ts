import { describe, expect, it } from 'vitest';
import {
	type Dictionary,
	decodeLine,
	dictFromJson,
	dictToPrompt,
	findEntry,
} from '../src/dict.ts';

const DICT: Dictionary = {
	version: 'test-v1',
	entries: [
		{
			code: 's',
			template: 'offer escalate if missing by {date:1}',
			slots: ['date:1'],
		},
		{
			code: 'greet',
			template: 'Hi {name:1}, hi again {name:1}.',
			slots: ['name:1'],
		},
		{ code: 'broken', template: 'Hello {a} and {b}.', slots: ['a'] },
	],
};

describe('decodeLine', () => {
	it('expands templates with verbatim slots', () => {
		expect(decodeLine(DICT, 'test-v1', 's', ['Mar 26'])).toEqual({
			ok: true,
			text: 'offer escalate if missing by Mar 26',
		});
	});

	it('copies slot values byte-exact without trimming', () => {
		const r = decodeLine(DICT, 'test-v1', 's', ['  Mar 26 ']);
		expect(r).toEqual({
			ok: true,
			text: 'offer escalate if missing by   Mar 26 ',
		});
	});

	it('fills repeated placeholders everywhere', () => {
		expect(decodeLine(DICT, 'test-v1', 'greet', ['Jo'])).toEqual({
			ok: true,
			text: 'Hi Jo, hi again Jo.',
		});
	});

	it('rejects unknown codes', () => {
		const r = decodeLine(DICT, 'test-v1', 'zzz', []);
		expect(r.ok).toBe(false);
	});

	it('rejects version mismatch', () => {
		const r = decodeLine(DICT, 'other-v9', 's', ['Mar 26']);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain('version mismatch');
		}
	});

	it('rejects arity mismatch both ways', () => {
		expect(decodeLine(DICT, 'test-v1', 's', []).ok).toBe(false);
		expect(decodeLine(DICT, 'test-v1', 's', ['a', 'b']).ok).toBe(false);
	});

	it('rejects unfilled placeholders', () => {
		const r = decodeLine(DICT, 'test-v1', 'broken', ['x']);
		expect(r.ok).toBe(false);
	});
});

describe('decodeLine destutter (run 038 banked emit rows)', () => {
	const STUTTER: Dictionary = {
		version: 'test-v1',
		entries: [
			{ code: 'AQ', template: 'Describe {problem}', slots: ['problem'] },
			{ code: 'RB', template: 'Complaint: {topic}', slots: ['topic'] },
		],
	};

	it('drops a slot verb duplicating the template verb (bitext-16485)', () => {
		expect(decodeLine(STUTTER, 'test-v1', 'AQ', ['describe problem'])).toEqual({
			ok: true,
			text: 'Describe problem',
		});
	});

	it('keeps degenerate stutter when nothing would remain (bitext-7429)', () => {
		// Collapsing to a dangling "Complaint:" derails the SLM into
		// hallucinating URLs and steps (live old-vs-new A/B); the stutter
		// preserves the only content word, so it stays.
		expect(decodeLine(STUTTER, 'test-v1', 'RB', ['complaint'])).toEqual({
			ok: true,
			text: 'Complaint: complaint',
		});
	});

	it('dedupes across trailing punctuation when content remains', () => {
		expect(
			decodeLine(STUTTER, 'test-v1', 'RB', ['complaint about billing']),
		).toEqual({ ok: true, text: 'Complaint: about billing' });
	});

	it('leaves clean compositions byte-exact', () => {
		expect(decodeLine(STUTTER, 'test-v1', 'AQ', ['login failure'])).toEqual({
			ok: true,
			text: 'Describe login failure',
		});
	});

	it('leaves mid-line duplicates alone (leading pair only)', () => {
		expect(decodeLine(STUTTER, 'test-v1', 'AQ', ['the the issue'])).toEqual({
			ok: true,
			text: 'Describe the the issue',
		});
	});

	it('collapses triple leading repeats', () => {
		expect(
			decodeLine(STUTTER, 'test-v1', 'AQ', ['describe describe x']),
		).toEqual({ ok: true, text: 'Describe x' });
	});
});

describe('findEntry', () => {
	it('finds and misses', () => {
		expect(findEntry(DICT, 's')?.template).toContain('escalate');
		expect(findEntry(DICT, 'nope')).toBeUndefined();
	});
});

describe('dictFromJson', () => {
	it('validates well-formed dictionaries', () => {
		expect(
			dictFromJson({
				version: 'v1',
				entries: [{ code: 's', template: 'hi {x}', slots: ['x'] }],
			}),
		).toEqual({
			version: 'v1',
			entries: [{ code: 's', template: 'hi {x}', slots: ['x'] }],
		});
	});

	it('rejects malformed shapes', () => {
		expect(() => dictFromJson(null)).toThrow('top level');
		expect(() => dictFromJson({ version: '', entries: [] })).toThrow('version');
		expect(() => dictFromJson({ version: 'v', entries: {} })).toThrow(
			'entries',
		);
		expect(() =>
			dictFromJson({
				version: 'v',
				entries: [{ code: '', template: 't', slots: [] }],
			}),
		).toThrow('code');
		expect(() =>
			dictFromJson({
				version: 'v',
				entries: [{ code: 's', template: 7, slots: [] }],
			}),
		).toThrow('template');
		expect(() =>
			dictFromJson({
				version: 'v',
				entries: [{ code: 's', template: 't', slots: [1] }],
			}),
		).toThrow('slots');
	});
});

describe('dictToPrompt', () => {
	const D: Dictionary = {
		version: 't',
		entries: [
			{
				code: 's',
				template: 'offer escalate if missing by {date}',
				slots: ['date'],
			},
			{ code: 'k', template: 'Log in to account', slots: [] },
		],
	};

	it('renders one means-line per entry with slot names', () => {
		const out = dictToPrompt(D);
		expect(out).toContain('s means "offer escalate if missing by {date}"');
		expect(out).toContain('k means "Log in to account"');
	});

	it('states the wire format last', () => {
		const out = dictToPrompt(D);
		expect(out).toContain(':<code>|<slot1>|<slot2>');
		expect(out).toContain(':<code>');
		expect(out).toContain(':a|duplicate charges');
		expect(out).toContain('Never emit a bare code');
	});

	it('renders the bare wire form on request', () => {
		const out = dictToPrompt(D, { wire: 'bare' });
		expect(out).toContain('<code>|<slot1>|<slot2>');
		expect(out).toContain('a|duplicate charges');
		expect(out).toContain('Never add a : prefix');
		expect(out).not.toContain(':<code>');
	});

	it('honors topN', () => {
		const out = dictToPrompt(D, { topN: 1 });
		expect(out).toContain('s means');
		expect(out).not.toContain('k means');
	});

	it('renders header and wire line for an empty dict', () => {
		const out = dictToPrompt({ version: 't', entries: [] });
		expect(out).toContain('Codebook');
		expect(out).toContain(':');
	});

	it('accepts {{...}} markers inside slot values', () => {
		const d: Dictionary = {
			version: 't',
			entries: [
				{ code: 'u', template: 'Locate {doc} {id}', slots: ['doc', 'id'] },
			],
		};
		const r = decodeLine(d, 't', 'u', ['order', '{{Order Number}}']);
		expect(r).toEqual({ ok: true, text: 'Locate order {{Order Number}}' });
	});

	it('still rejects a truly unfilled slot', () => {
		const d: Dictionary = {
			version: 't',
			entries: [{ code: 'u', template: 'Locate {doc} {id}', slots: ['doc'] }],
		};
		// Arity passes (1 value, 1 slot) but {id} survives: leftover must trip.
		const r = decodeLine(d, 't', 'u', ['order']);
		expect(r.ok).toBe(false);
	});

	it('renders the v3 stream wire form on request', () => {
		const out = dictToPrompt(D, { wire: 'v3' });
		expect(out).toContain('ONE line');
		expect(out).toContain('space-separated');
		expect(out).toContain('AX widget WB first | second MC');
		expect(out).toContain('TX some note');
		expect(out).toContain('Backslash-escape');
		expect(out).toContain('Never emit newlines');
		expect(out).not.toContain('<code>|<slot1>');
	});

	it('renders the v3x compact book without means-wrappers', () => {
		const out = dictToPrompt(D, { wire: 'v3x' });
		expect(out).toContain('s:offer escalate if missing by {date}');
		expect(out).toContain('k:Log in to account');
		expect(out).not.toContain('means');
		expect(out).toContain('ONE line');
	});
});
