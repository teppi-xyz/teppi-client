// A dispute packet says only what the signed receipt and the buyer's own bytes can show.
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonical, disputeEvidence, type Receipt } from '../src/index.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const der = publicKey.export({ format: 'der', type: 'spki' });
const keys = {
	keys: [
		{
			id: 'r1',
			public_key: Buffer.from(der.subarray(der.length - 32)).toString('base64'),
			purpose: 'receipt',
		},
	],
};
const SALT = 'ab'.repeat(32);
const ANSWER = '{"price":"64000.5"}';
const commit = (bytes: string) =>
	`salted-sha256:${createHash('sha256').update(Buffer.from(SALT, 'hex')).update(bytes).digest('hex')}`;

function signed(over: Record<string, unknown> = {}): Receipt {
	const doc = {
		schema: 'teppi.order.v1',
		order_id: 'ord_1',
		status: 'passed',
		request_commitment: commit('{}'),
		response_commitment: commit(ANSWER),
		paid: { network: 'eip155:8453', settled: '0.003000', transaction: `0x${'cd'.repeat(32)}` },
		checks: [{ name: 'answered', pass: true }],
		issued_at: '2026-11-23T00:00:00.000Z',
		signing_key_id: 'r1',
		canonicalization: 'RFC8785',
		...over,
	};
	const signature = `ed25519:${sign(null, Buffer.from(canonical(doc)), privateKey).toString('base64')}`;
	return { ...doc, signature } as unknown as Receipt;
}

describe('dispute evidence from a receipt', () => {
	it('says the receipt verifies, what settled, and that the bytes held are the ones named', async () => {
		const e = await disputeEvidence(signed(), keys, { salt: SALT, response: ANSWER });
		expect(e.verified).toBe(true);
		expect(e.bytes_match).toBe(true);
		expect(e.outcome).toBe('billed after its checks passed');
		expect(e.text).toContain(`transaction 0x${'cd'.repeat(32)}`);
	});

	it('says plainly when the bytes the buyer holds are not the ones the receipt names', async () => {
		const e = await disputeEvidence(signed(), keys, { salt: SALT, response: '{"price":"1"}' });
		expect(e.bytes_match).toBe(false);
		expect(e.text).toContain('does not hash');
	});

	it('refuses to call an edited receipt verified', async () => {
		const edited = { ...signed(), status: 'failed' } as Receipt;
		const e = await disputeEvidence(edited, keys);
		expect(e.verified).toBe(false);
		expect(e.text).toContain('does not verify');
	});
});
