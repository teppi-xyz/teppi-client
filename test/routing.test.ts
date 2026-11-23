// A receipt's routing reruns from records alone, and one edited figure on either side shows.

import { describe, expect, it } from 'vitest';
import { rerunRouting as explain, type RoutingSnapshot as Snapshot } from '../src/routing.ts';

const AS_OF = '2026-11-03T12:00:00.000Z';
const DAY = 86_400_000;

const records = (capability: string, n: number, heldOut: number) =>
	Array.from({ length: n }, (_, i) => ({
		capability_id: capability,
		source: 'probe',
		observed_at: new Date(Date.parse(AS_OF) - i * DAY).toISOString(),
		liveness: 1,
		correctness: i < heldOut ? 1 : null,
		latency_ms: 1000,
		corrected: false,
	}));

const ROUTING: Snapshot = {
	version: 1,
	as_of: AS_OF,
	ranked: [
		{
			capability_id: 'cap_a',
			price: '0.003000',
			group: 'a.example',
			calls: 10,
			lower: 0.722467,
			median_latency_ms: 1000,
		},
	],
	unranked: [{ capability_id: 'cap_b', why: '2 calls over 1.0 days, 2 held out' }],
	refused: ['c: no index lists this endpoint any more'],
};

const LINES = [...records('cap_a', 10, 5), ...records('cap_b', 2, 2)];

describe('explain', () => {
	it('gives the same choice from the records as the receipt names', () => {
		const r = explain(ROUTING, 'cap_a', LINES);
		expect(r.lines.filter((l) => l.includes('DIFF'))).toEqual([]);
		expect(r.agrees).toBe(true);
	});

	it('says so when a figure on the receipt was edited', () => {
		const edited = { ...ROUTING, ranked: [{ ...ROUTING.ranked[0], calls: 11 }] } as Snapshot;
		expect(explain(edited, 'cap_a', LINES).agrees).toBe(false);
	});

	it('says so when the records hold a record the receipt never counted', () => {
		const more = [
			...LINES,
			...records('cap_b', 10, 5).map((l, i) => ({
				...l,
				observed_at: new Date(Date.parse(AS_OF) - (i + 2) * DAY).toISOString(),
			})),
		];
		expect(explain(ROUTING, 'cap_a', more).agrees).toBe(false);
	});

	it('leaves a corrected record out, the way the router did', () => {
		const corrected = [...LINES, { ...records('cap_a', 1, 0)[0], corrected: true }] as typeof LINES;
		expect(explain(ROUTING, 'cap_a', corrected).agrees).toBe(true);
	});

	it('says so when another seller was tried first', () => {
		expect(explain(ROUTING, 'cap_b', LINES).agrees).toBe(false);
	});

	it('refuses a rule version it does not rerun', () => {
		expect(explain({ ...ROUTING, version: 2 }, 'cap_a', LINES).agrees).toBe(false);
	});
});
