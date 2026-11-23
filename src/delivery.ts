// The fields every open x402 delivery proposal holds or derives, hashed to one shared id.

import { canonical } from './index.ts';

export const DELIVERY_CORE = 'delivery-core/0';

export type DeliveryInput = {
	// CAIP-2, as the payment requirements name it.
	readonly network: string;
	readonly transaction: string;
	readonly payer: string;
	readonly payTo: string;
	readonly asset: string;
	// Atomic units of the asset, as a decimal string.
	readonly amount: string;
	readonly resourceUrl: string;
	readonly method: string;
	readonly responseStatus: number;
	// The body as received, after any content encoding is taken off.
	readonly body: Uint8Array;
	// ISO 8601 UTC.
	readonly issuedAt: string;
};

export type DeliveryCore = {
	readonly schema: typeof DELIVERY_CORE;
	readonly network: string;
	readonly transaction: string;
	readonly payer: string;
	readonly payTo: string;
	readonly asset: string;
	readonly amount: string;
	readonly resourceUrl: string;
	readonly method: string;
	readonly responseStatus: number;
	readonly responseSha256: string;
	readonly issuedAt: string;
};

const hex = (bytes: ArrayBuffer) =>
	[...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
	return hex(await crypto.subtle.digest('SHA-256', bytes));
}

// Evm addresses and hashes compare without case, so they are written lower case to hash alike.
const evmLower = (network: string, v: string) =>
	network.startsWith('eip155:') && /^0x[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : v;

export async function deliveryCore(input: DeliveryInput): Promise<DeliveryCore> {
	if (!/^\d+$/.test(input.amount)) throw new Error('amount is atomic units, digits only');
	if (!Number.isInteger(input.responseStatus)) throw new Error('responseStatus is an integer');
	const n = input.network;
	return {
		schema: DELIVERY_CORE,
		network: n,
		transaction: evmLower(n, input.transaction),
		payer: evmLower(n, input.payer),
		payTo: evmLower(n, input.payTo),
		asset: evmLower(n, input.asset),
		amount: input.amount,
		resourceUrl: input.resourceUrl,
		method: input.method.toUpperCase(),
		responseStatus: input.responseStatus,
		responseSha256: await sha256Hex(input.body),
		issuedAt: input.issuedAt,
	};
}

// The id a seller, a buyer or a third party can each sign or point at, over RFC 8785 bytes.
export async function deliveryCoreId(core: DeliveryCore): Promise<string> {
	return sha256Hex(canonical(core));
}
