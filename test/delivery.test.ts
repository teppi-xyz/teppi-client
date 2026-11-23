// The shared delivery id, held to bytes a Python stdlib run produced, so any language reruns it.
import { describe, expect, it } from 'vitest';
import { deliveryCore, deliveryCoreId } from '../src/index.ts';

const body = new TextEncoder().encode(
	'{"results":[{"url":"https://www.rfc-editor.org/rfc/rfc9110"}]}',
);
const input = {
	network: 'eip155:8453',
	transaction: `0x${'AB'.repeat(32)}`,
	payer: `0x${'11'.repeat(20)}`,
	payTo: '0x2A462Db85807F0Ff497ddD15f5978317d079a3A1',
	asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
	amount: '3000',
	resourceUrl: 'https://api.teppi.xyz/v1/facts/price',
	method: 'post',
	responseStatus: 200,
	body,
	issuedAt: '2026-11-23T00:00:00Z',
};

describe('the delivery core', () => {
	it('names the body by its sha-256 and the whole by the sha-256 of its RFC 8785 form', async () => {
		const core = await deliveryCore(input);
		expect(core.responseSha256).toBe(
			'0e10c4bd04e6a163c5474538a6b2631c18f349cd20f25d1cd22096ac880441dd',
		);
		expect(await deliveryCoreId(core)).toBe(
			'aa0e1da8632aa2f1f28131f349b3215dd2b5073351157d9add0b9200896f63a0',
		);
	});

	it('changes its id when one byte of the body changes', async () => {
		const other = new Uint8Array(body);
		other[0] = 0x20;
		const a = await deliveryCoreId(await deliveryCore(input));
		const b = await deliveryCoreId(await deliveryCore({ ...input, body: other }));
		expect(a).not.toBe(b);
	});

	it('refuses an amount written as a decimal, since atomic units are what settled', async () => {
		await expect(deliveryCore({ ...input, amount: '0.003' })).rejects.toThrow();
	});
});
