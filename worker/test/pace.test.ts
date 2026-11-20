import { describe, expect, it } from 'vitest';
import { Pacer } from '../src/pace.ts';

describe('Pacer', () => {
	it('passes immediately the first time', async () => {
		const sleeps: number[] = [];
		const p = new Pacer(
			1000,
			() => 5000,
			(ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		);
		await p.wait();
		expect(sleeps).toEqual([]);
	});

	it('sleeps the remaining interval on immediate reuse', async () => {
		const sleeps: number[] = [];
		let now = 5000;
		const p = new Pacer(
			1000,
			() => now,
			(ms) => {
				sleeps.push(ms);
				return Promise.resolve();
			},
		);
		await p.wait();
		await p.wait();
		expect(sleeps).toEqual([1000]);
		now += 1500;
		await p.wait();
		expect(sleeps).toEqual([1000]);
	});

	it('instances pace independently', async () => {
		const sleeps: number[] = [];
		const sleep = (ms: number) => {
			sleeps.push(ms);
			return Promise.resolve();
		};
		const a = new Pacer(1000, () => 0, sleep);
		const b = new Pacer(1000, () => 0, sleep);
		await a.wait();
		await b.wait();
		expect(sleeps).toEqual([]);
	});
});
