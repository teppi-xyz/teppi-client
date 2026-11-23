// A signed order receipt turned into the text a dispute form takes, with every claim checkable.

import {
	commitmentOf,
	DEFAULT_ORIGIN,
	type PublishedKeys,
	type Receipt,
	verifyReceipt,
} from './index.ts';

export type DisputeBytes = {
	// The x-teppi-salt the buyer was handed with the answer.
	readonly salt: string;
	// The answer exactly as received.
	readonly response: string;
};

export type DisputeEvidence = {
	readonly order_id: string;
	readonly verified: boolean;
	readonly why_not_verified: string | null;
	// Whether the bytes the buyer holds are the ones the receipt names; null when none were given.
	readonly bytes_match: boolean | null;
	readonly outcome: 'billed after its checks passed' | 'not billed' | 'open';
	readonly payment: Record<string, unknown> | null;
	readonly checks: unknown;
	// Plain text for a form's free text field, each sentence a fact a reader can rerun.
	readonly text: string;
};

type Leg = { network?: string; settled?: string | null; transaction?: string | null };

const legOf = (v: unknown): Leg | null => (v !== null && typeof v === 'object' ? (v as Leg) : null);

export async function disputeEvidence(
	receipt: Receipt,
	keys: PublishedKeys,
	bytes?: DisputeBytes,
	origin = DEFAULT_ORIGIN,
): Promise<DisputeEvidence> {
	const verified = await verifyReceipt(receipt, keys);
	const matches =
		bytes === undefined || receipt.response_commitment === null
			? null
			: (await commitmentOf(bytes.salt, bytes.response)) === receipt.response_commitment;
	const paid = legOf(receipt.paid);
	const outcome =
		receipt.status === 'passed'
			? 'billed after its checks passed'
			: receipt.status === 'open'
				? 'open'
				: 'not billed';
	const lines = [
		`Order ${receipt.order_id}, receipt signed by key ${receipt.signing_key_id ?? 'none'} at ${receipt.issued_at}.`,
		verified.ok
			? `The signature verifies against ${origin}/.well-known/teppi-keys.json.`
			: `The signature does not verify: ${verified.why}.`,
		`Status: ${receipt.status}, ${outcome}.`,
		paid?.transaction
			? `The buyer's payment settled ${paid.settled ?? 'an unread amount'} USDC on ${paid.network} in transaction ${paid.transaction}.`
			: 'No payment from the buyer settled for this order.',
		matches === null
			? 'The buyer holds the answer and the salt that open the response commitment on the receipt.'
			: matches
				? 'The answer the buyer holds hashes, with its salt, to the response commitment on the receipt.'
				: 'The answer the buyer holds does not hash to the response commitment on the receipt.',
		`Receipt: ${origin}/v1/orders/${receipt.order_id}. Method: ${origin}/docs/verification-method.`,
	];
	return {
		order_id: receipt.order_id,
		verified: verified.ok,
		why_not_verified: verified.ok ? null : verified.why,
		bytes_match: matches,
		outcome,
		payment: paid as Record<string, unknown> | null,
		checks: receipt.checks ?? null,
		text: lines.join(' '),
	};
}
