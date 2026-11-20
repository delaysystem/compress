import { describe, expect, it } from 'vitest';
import { extractEntities } from '../src/entities.ts';
import { checkEntityGrounding } from '../src/grounding.ts';

describe('checkEntityGrounding', () => {
	it('passes grounded entities', () => {
		const v = checkEntityGrounding(
			extractEntities('call 877-424-3838 anytime'),
			extractEntities('Call Center at 877-424-3838 for help'),
		);
		expect(v).toEqual({ pass: true, checked: 3, ungrounded: [] });
	});

	it('fails ungrounded entities (the v3 hotline case)', () => {
		const v = checkEntityGrounding(
			extractEntities('help desk 877-327-0022'),
			extractEntities('Call Center at 877-424-3838 for help'),
		);
		expect(v.pass).toBe(false);
		// 877 is shared (toll prefix), so only the invented segments fail.
		expect(v.ungrounded).toEqual(['number:327', 'number:0022']);
	});

	it('uses set semantics: repetition is not fabrication', () => {
		const v = checkEntityGrounding(
			extractEntities('pay $5 now, $5 later'),
			extractEntities('the bill is $5'),
		);
		expect(v).toEqual({ pass: true, checked: 1, ungrounded: [] });
	});

	it('passes vacuously when the IR claims no entities', () => {
		const v = checkEntityGrounding(
			extractEntities('provide complete information'),
			extractEntities('anything at all 123'),
		);
		expect(v).toEqual({ pass: true, checked: 0, ungrounded: [] });
	});

	it('scopes keys by class', () => {
		const v = checkEntityGrounding(
			extractEntities('due Mar 3'),
			extractEntities('room 03-03 is booked'),
		);
		// date:03-03 must not match number:03 / number:03.
		expect(v.pass).toBe(false);
		expect(v.ungrounded).toEqual(['date:03-03']);
	});
});
