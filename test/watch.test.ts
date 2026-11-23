// The watch only reports a change, never the same state twice, and only for payees it was given.

import { describe, expect, it } from 'vitest';
import { type PayeeChange, payeeWatch, teppiHook } from '../src/index.ts';

const SNIPERX = 'Bd2xS189uhhnxUeBeVF3JFXrg8zQgrvqZtpqh8hgkCEQ';
const CLEAN = '0x2a462db85807f0ff497ddd15f5978317d079a3a1';

const listOf = (entries: unknown[]) =>
	(async () => new Response(JSON.stringify({ entries }))) as unknown as typeof fetch;

const listed = { payout: SNIPERX, why: ['wrong'], evidence: ['/v1/evidence/sha256:aa'] };

describe('watching payees', () => {
	it('reports a payee the moment it lands on the list, with why', async () => {
		const seen: PayeeChange[] = [];
		const watch = payeeWatch({
			intervalMs: 0,
			fetchImpl: listOf([listed]),
			onChange: (c) => seen.push(c),
		});
		watch.add(SNIPERX);
		watch.add(CLEAN);
		await watch.check();
		expect(seen).toEqual([
			{
				payee: SNIPERX,
				listed: true,
				why: ['wrong'],
				evidence: ['/v1/evidence/sha256:aa'],
			},
		]);
	});

	it('says nothing the second time when nothing moved', async () => {
		const watch = payeeWatch({ intervalMs: 0, fetchImpl: listOf([listed]) });
		watch.add(SNIPERX);
		await watch.check();
		expect(await watch.check()).toEqual([]);
	});

	it('reports a payee leaving the list too', async () => {
		let entries: unknown[] = [listed];
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ entries }))) as unknown as typeof fetch;
		const watch = payeeWatch({ intervalMs: 0, fetchImpl });
		watch.add(SNIPERX);
		await watch.check();
		entries = [];
		expect((await watch.check()).map((c) => c.listed)).toEqual([false]);
	});

	it('asks nothing of the network before it has a payee', async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			return new Response('{}');
		}) as unknown as typeof fetch;
		await payeeWatch({ intervalMs: 0, fetchImpl }).check();
		expect(calls).toBe(0);
	});

	it('remembers the payee the x402 hook lets through', async () => {
		const watch = payeeWatch({ intervalMs: 0, fetchImpl: listOf([]) });
		const record = {
			band: 'B',
			tier: 'OUTCOME_VERIFIED',
			composite: 0.8,
			why: 'graded',
			defects: [],
			matched: 'exact',
			reproduce: 'npx teppi-check https://seller.example/x',
		};
		const check = (async () => Response.json(record)) as unknown as typeof fetch;
		const hook = teppiHook({ watch, fetchImpl: check, maxOverUsual: false });
		await hook({
			paymentRequired: { resource: { url: 'https://seller.example/x' } },
			selectedRequirements: { payTo: CLEAN, amount: '1000' },
		});
		expect(watch.payees()).toEqual([CLEAN]);
	});
});
