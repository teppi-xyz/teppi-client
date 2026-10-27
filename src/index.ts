// What an agent asks before it pays, and a fetch that asks it for the agent at the 402.

export const DEFAULT_ORIGIN = 'https://api.teppi.xyz';

export type Defect = { readonly defect: string; readonly says: string };

// The answer at /v1/check. Unrated means not enough observed, and is never a low grade.
export type Payee = {
	readonly address: string;
	readonly origins: readonly string[];
	readonly listed: number;
	readonly graded: number;
	readonly bestBand: string | null;
	readonly withDefects: number;
};

// Where and at what price Teppi buys the call for you, settled only once the answer passed.
export type Buy = {
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly seller_price: string;
	readonly fee: string;
	readonly total: string;
	readonly asset: string;
	readonly guarantee: string;
	readonly publish?: string;
};

export type Answer = {
	readonly band: 'A' | 'B' | 'C' | 'D' | 'F' | 'UNRATED';
	readonly tier: string | null;
	readonly composite: number | null;
	readonly why: string;
	readonly defects: readonly Defect[];
	readonly matched: 'exact' | 'path' | 'none';
	readonly queued?: boolean;
	readonly next?: string;
	readonly reproduce: string | null;
	readonly payee?: Payee | null;
	// Present when the record will buy it for you, charging only if the answer passes its checks.
	readonly buy?: Buy;
	// When it was answered and by which key at /.well-known/teppi-keys.json, or null if unsigned.
	readonly answered_at?: string;
	readonly signing_key_id?: string | null;
	readonly signature?: string | null;
	readonly [key: string]: unknown;
};

export type CheckOptions = {
	readonly origin?: string;
	readonly method?: 'GET' | 'POST';
	// Who the 402 says gets paid. One address stands behind many origins the url never names.
	readonly payTo?: string;
	readonly fetchImpl?: typeof fetch;
	readonly timeoutMs?: number;
};

export class TeppiUnreachable extends Error {}

// Named so the record can count checks that came through this client apart from its own gates.
export const CLIENT_VERSION = '0.6.0';
const USER_AGENT = `teppi-client/${CLIENT_VERSION}`;

// One GET. A url the record has never seen is put in line for a free handshake by the asking.
export async function check(url: string, options: CheckOptions = {}): Promise<Answer> {
	const origin = options.origin ?? DEFAULT_ORIGIN;
	const query = new URLSearchParams({
		url,
		...(options.method ? { method: options.method } : {}),
		...(options.payTo ? { pay_to: options.payTo } : {}),
	});
	let response: Response;
	try {
		response = await (options.fetchImpl ?? fetch)(`${origin}/v1/check?${query}`, {
			headers: { accept: 'application/json', 'user-agent': USER_AGENT },
			signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
		});
	} catch (err) {
		throw new TeppiUnreachable((err as Error).message);
	}
	if (!response.ok) throw new TeppiUnreachable(`the record answered ${response.status}`);
	return (await response.json()) as Answer;
}

export type Decision =
	| { readonly allow: true }
	| { readonly allow: false; readonly because: string };

export type Policy = (answer: Answer, request: { url: string; method: string }) => Decision;

export type PolicyOptions = {
	// What to do with a listing nothing has been verified about yet. Unknown is not bad.
	readonly unrated?: 'allow' | 'refuse';
	// The lowest letter to pay. D and F are refused by default; C and up are paid.
	readonly minBand?: 'A' | 'B' | 'C' | 'D';
};

const ORDER = ['A', 'B', 'C', 'D', 'F'] as const;

// Refuses a listing the record says is broken, or graded below the line. Everything else pays.
export function defaultPolicy(options: PolicyOptions = {}): Policy {
	const floor = ORDER.indexOf(options.minBand ?? 'C');
	return (answer) => {
		const defect = answer.defects[0];
		if (defect) return { allow: false, because: `${defect.defect}: ${defect.says}` };
		if (answer.band === 'UNRATED') {
			return options.unrated === 'refuse'
				? { allow: false, because: `unrated: ${answer.why}` }
				: { allow: true };
		}
		if (ORDER.indexOf(answer.band) > floor) {
			return { allow: false, because: `graded ${answer.band}: ${answer.why}` };
		}
		return { allow: true };
	};
}

export type GuardOptions = CheckOptions &
	PolicyOptions & {
		readonly policy?: Policy;
		// When the record cannot be reached. Allow by default: one outage should not stop every buy.
		readonly whenUnreachable?: 'allow' | 'refuse';
		// How long one answer is reused, since a client retries the same url within seconds.
		readonly cacheMs?: number;
		// Buy through Teppi where the record offers it: charged only if the answer passes its checks.
		readonly payOnDelivery?: boolean;
		// Put a call bought through Teppi in the public record, bytes and all. Off unless asked for.
		readonly publish?: boolean;
		// Refuse a 402 asking more than this many times what the endpoint's last 402 asked, or false.
		readonly maxOverUsual?: number | false;
	};

// A seller can name any amount in a 402 and a client signs it, so a spike past this is refused.
export const MAX_OVER_USUAL = 5;

export type Requirement = {
	readonly amount?: string;
	readonly maxAmountRequired?: string;
	readonly asset?: string;
};

type Advertised = { readonly atomic?: string | null; readonly asset?: string };

// The asked and usual amounts in one token's smallest unit, or null when they cannot be compared.
function comparable(answer: Answer, requirement: Requirement): [bigint, bigint] | null {
	const seen = (answer.observed as { advertised?: Advertised | null } | undefined)?.advertised;
	const asked = requirement.amount ?? requirement.maxAmountRequired;
	if (!seen?.atomic || !seen.asset || asked === undefined || !/^\d+$/.test(asked)) return null;
	// Decimals differ by token, so two amounts are compared only when they name the same one.
	if (requirement.asset?.toLowerCase() !== seen.asset.toLowerCase()) return null;
	const usual = BigInt(seen.atomic);
	return usual === 0n ? null : [BigInt(asked), usual];
}

// Why a requirement asks too much against the record's last price, or null when it does not.
export function overUsual(
	answer: Answer,
	requirement: Requirement,
	times = MAX_OVER_USUAL,
): string | null {
	const pair = comparable(answer, requirement);
	if (pair === null) return null;
	const [asked, usual] = pair;
	if (asked * 100n <= usual * BigInt(Math.round(times * 100))) return null;
	return `asks ${asked}, more than ${times} times the ${usual} its last 402 asked`;
}

export const PUBLISH_HEADER = 'x-teppi-publish';

export const REFUSED_STATUS = 403;

// The url and verb a fetch was given, whichever of the three shapes it was given them in.
function asked(
	input: Parameters<typeof fetch>[0],
	init?: RequestInit,
): { url: string; method: string } {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
	const fallback = input instanceof Request ? input.method : 'GET';
	return { url, method: (init?.method ?? fallback).toUpperCase() };
}

// A payment rides in one of two header names, and an x402 client retries with it attached.
function carriesPayment(input: Parameters<typeof fetch>[0], init?: RequestInit): boolean {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
	return headers.has('payment-signature') || headers.has('x-payment');
}

// The same request sent somewhere else: its verb, its headers and its body, only the url changed.
function sentTo(url: string, input: Parameters<typeof fetch>[0]) {
	return input instanceof Request ? new Request(url, input) : url;
}

// The paid request carries the buyer's choice to publish, since that is the one Teppi reads.
function publishing(input: Parameters<typeof fetch>[0], init?: RequestInit): RequestInit {
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
	headers.set(PUBLISH_HEADER, 'transcript');
	return { ...init, headers };
}

// Wraps the fetch handed to an x402 client: a 402 the policy refuses becomes a 403 that says why.
export function beforeYouPay(inner: typeof fetch, options: GuardOptions = {}): typeof fetch {
	const policy = options.policy ?? defaultPolicy(options);
	const cache = new Map<string, { at: number; answer: Answer }>();
	const cacheMs = options.cacheMs ?? 60_000;
	// Where a 402 was answered with Teppi's own terms, so the paid retry goes where they came from.
	const relayed = new Map<string, string>();

	const lookup = async (url: string, method: string): Promise<Answer> => {
		const cached = cache.get(url);
		if (cached && Date.now() - cached.at < cacheMs) return cached.answer;
		const answer = await check(url, { ...options, method: method === 'POST' ? 'POST' : 'GET' });
		cache.set(url, { at: Date.now(), answer });
		return answer;
	};

	// Teppi's own 402 for the same call, or null when it cannot quote it and the seller's stands.
	const quoteFrom = async (
		buy: Buy,
		input: Parameters<typeof fetch>[0],
		init: RequestInit | undefined,
		key: string,
	): Promise<Response | null> => {
		const quote = await inner(sentTo(buy.url, input), init).catch(() => null);
		if (quote === null || quote.status !== 402) return null;
		relayed.set(key, buy.url);
		return quote;
	};

	// The record's word on a 402: refused, paid as the seller asked, or bought through Teppi.
	const judge = async (
		response: Response,
		input: Parameters<typeof fetch>[0],
		init: RequestInit | undefined,
	): Promise<Response> => {
		const request = asked(input, init);
		let answer: Answer;
		try {
			answer = await lookup(request.url, request.method);
		} catch (err) {
			// One outage at the record should not stop every buy, unless the caller said it should.
			if (options.whenUnreachable !== 'refuse') return response;
			return refused(request.url, (err as Error).message, null);
		}
		const decision = policy(answer, request);
		if (!decision.allow) return refused(request.url, decision.because, answer);
		const spike = await everyOptionOver(response, answer, options.maxOverUsual);
		if (spike !== null) return refused(request.url, spike, answer);
		if (options.payOnDelivery !== true || answer.buy === undefined) return response;
		const key = `${request.method} ${request.url}`;
		return (await quoteFrom(answer.buy, input, init, key)) ?? response;
	};

	return async (input, init) => {
		const request = asked(input, init);
		const via = relayed.get(`${request.method} ${request.url}`);
		// The payment was signed for Teppi's terms, so it is sent to Teppi and never to the seller.
		if (via !== undefined && carriesPayment(input, init)) {
			return inner(sentTo(via, input), options.publish === true ? publishing(input, init) : init);
		}
		const response = await inner(input, init);
		return response.status === 402 ? judge(response, input, init) : response;
	};
}

// The client picks among a 402's options later, so the fetch refuses only when every one is over.
async function everyOptionOver(
	response: Response,
	answer: Answer,
	times: number | false = MAX_OVER_USUAL,
): Promise<string | null> {
	if (times === false) return null;
	const header = response.headers.get('payment-required');
	let terms: { accepts?: Requirement[] } | null = null;
	try {
		terms = header === null ? await response.clone().json() : JSON.parse(atob(header));
	} catch {
		return null;
	}
	const options = terms?.accepts ?? [];
	if (options.length === 0) return null;
	const reasons = options.map((o) => overUsual(answer, o, times));
	return reasons.every((r) => r !== null) ? (reasons[0] as string) : null;
}

function refused(url: string, because: string, answer: Answer | null): Response {
	return new Response(
		JSON.stringify({ error: 'refused_before_paying', url, because, record: answer }),
		{
			status: REFUSED_STATUS,
			headers: { 'content-type': 'application/json', 'x-teppi-refused': because.slice(0, 200) },
		},
	);
}

// The official client picks paying after the fact over escrow, so this keeps escrow alone.
export function preferEscrow<R extends { readonly scheme?: string }>(
	_version: number,
	accepts: R[],
): R[] {
	const held = accepts.filter((a) => a.scheme === 'auth-capture');
	return held.length === 0 ? accepts : held;
}

// The abort hook the official client takes: x402Client.onBeforePaymentCreation(teppiHook()).
export function teppiHook(options: GuardOptions = {}) {
	const policy = options.policy ?? defaultPolicy(options);
	return async (context: {
		paymentRequired: { resource: { url: string } };
		selectedRequirements: { payTo: string } & Requirement;
	}): Promise<undefined | { abort: true; reason: string }> => {
		const url = context.paymentRequired.resource.url;
		let answer: Answer;
		try {
			answer = await check(url, { ...options, payTo: context.selectedRequirements.payTo });
		} catch (err) {
			if (options.whenUnreachable !== 'refuse') return undefined;
			return { abort: true, reason: `the record could not be reached: ${(err as Error).message}` };
		}
		const decision = policy(answer, { url, method: options.method ?? 'GET' });
		if (!decision.allow) return { abort: true, reason: decision.because };
		const spike =
			options.maxOverUsual === false
				? null
				: overUsual(answer, context.selectedRequirements, options.maxOverUsual ?? MAX_OVER_USUAL);
		return spike === null ? undefined : { abort: true, reason: spike };
	};
}

// One tool an agent framework can register: a name, a JSON schema and the call behind it.
export type CheckTool = {
	readonly name: 'check_before_paying';
	readonly description: string;
	readonly parameters: {
		readonly type: 'object';
		readonly properties: Record<string, unknown>;
		required: string[];
		readonly additionalProperties: false;
	};
	readonly execute: (args: { url: string; method: 'GET' | 'POST' }) => Promise<ToolAnswer>;
};

export type ToolAnswer = {
	readonly pay: boolean;
	readonly because: string;
	readonly band: Answer['band'];
	readonly why: string;
	readonly defects: readonly Defect[];
	readonly buy: Buy | null;
	readonly reproduce: string | null;
};

// Written for the model reading it: when to call it, and what the answer means.
const TOOL_DESCRIPTION =
	'Call before paying any HTTP 402 endpoint. Returns whether to pay it, why, its grade from paid ' +
	'calls (UNRATED means not enough is known, never bad), what is wrong with its listing, and a way ' +
	'to buy it charged only if the answer passes.';

export function checkTool(options: GuardOptions = {}): CheckTool {
	const policy = options.policy ?? defaultPolicy(options);
	return {
		name: 'check_before_paying',
		description: TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'the url that answered 402' },
				method: { type: 'string', enum: ['GET', 'POST'], description: 'the verb you will pay for' },
			},
			required: ['url', 'method'],
			additionalProperties: false,
		},
		execute: async ({ url, method }) => {
			const answer = await check(url, { ...options, method });
			const decision = policy(answer, { url, method });
			return {
				pay: decision.allow,
				because: decision.allow ? 'nothing on record against it' : decision.because,
				band: answer.band,
				why: answer.why,
				defects: answer.defects,
				buy: answer.buy ?? null,
				reproduce: answer.reproduce,
			};
		},
	};
}

export type PublishedKeys = {
	readonly keys: readonly { id: string; public_key: string; purpose?: string }[];
};

// Fetches /.well-known/teppi-keys.json, which names every key an answer may carry.
export async function publishedKeys(options: CheckOptions = {}): Promise<PublishedKeys> {
	const origin = options.origin ?? DEFAULT_ORIGIN;
	const response = await (options.fetchImpl ?? fetch)(`${origin}/.well-known/teppi-keys.json`, {
		signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
	});
	if (!response.ok) throw new TeppiUnreachable(`the key document answered ${response.status}`);
	return (await response.json()) as PublishedKeys;
}

// RFC 8785, enough of it for what an answer carries: sorted keys, JSON number and string forms.
export function canonical(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${value} has no canonical form`);
		return JSON.stringify(value === 0 ? 0 : value);
	}
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record)
			.filter((k) => record[k] !== undefined)
			.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`).join(',')}}`;
	}
	throw new Error(`${typeof value} has no canonical form`);
}

export type Verified =
	| { readonly ok: true; readonly keyId: string }
	| { readonly ok: false; readonly why: string };

type Signed = {
	readonly signature?: unknown;
	readonly signing_key_id?: unknown;
	readonly [key: string]: unknown;
};

// One check for every signed document, held to the one purpose its kind is signed with.
async function verifySigned(
	doc: Signed,
	keys: PublishedKeys,
	// Null for the scorecard key, which names no purpose and signs cards and notices.
	purpose: 'check' | 'receipt' | null,
	what: string,
): Promise<Verified> {
	const { signature, ...rest } = doc;
	if (typeof signature !== 'string' || typeof rest.signing_key_id !== 'string') {
		return { ok: false, why: `the ${what} is not signed` };
	}
	if (!signature.startsWith('ed25519:')) return { ok: false, why: 'not an ed25519 signature' };
	const key = keys.keys.find((k) => k.id === rest.signing_key_id);
	if (!key) return { ok: false, why: `no published key named ${rest.signing_key_id}` };
	if ((key.purpose ?? null) !== purpose) {
		return { ok: false, why: `key ${key.id} does not sign ${what}s` };
	}

	const { createPublicKey, verify: verifyBytes } = await import('node:crypto');
	const raw = Buffer.from(key.public_key, 'base64');
	if (raw.length !== 32) return { ok: false, why: `key ${key.id} is not 32 bytes` };
	const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
	const publicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
	const bytes = Buffer.from(canonical(rest), 'utf8');
	const sig = Buffer.from(signature.slice('ed25519:'.length), 'base64');
	try {
		return verifyBytes(null, bytes, publicKey, sig)
			? { ok: true, keyId: key.id }
			: { ok: false, why: `the signature does not match the ${what}` };
	} catch {
		return { ok: false, why: 'the signature could not be read' };
	}
}

// Checks an answer against the published keys, so what Teppi said can be shown to a principal.
export async function verify(answer: Answer, keys: PublishedKeys): Promise<Verified> {
	return verifySigned(answer, keys, 'check', 'answer');
}

// The receipt at /v1/orders/{id}: what was quoted, paid, bought and checked, and never the bytes.
export type Receipt = {
	readonly schema: 'teppi.order.v1';
	readonly order_id: string;
	readonly status: 'open' | 'passed' | 'failed' | 'refused';
	readonly request_commitment: string;
	readonly response_commitment: string | null;
	readonly issued_at: string;
	readonly signing_key_id: string | null;
	readonly signature: string | null;
	readonly [key: string]: unknown;
};

// Checks a receipt against the published keys, held to a key that signs receipts and nothing else.
export async function verifyReceipt(receipt: Receipt, keys: PublishedKeys): Promise<Verified> {
	return verifySigned(receipt, keys, 'receipt', 'receipt');
}

// What a watcher is posted when a card it follows falls, signed by the key that signs the cards.
export type Notice = {
	readonly schema: 'teppi.notice.v1';
	readonly notice_id: string;
	readonly watcher_id: string;
	readonly capability_id: string;
	readonly tier: string;
	readonly change: string;
	readonly from: string;
	readonly to: string;
	readonly observed_at: string;
	readonly scorecard: string;
	readonly signing_key_id: string;
	readonly signature: string;
	readonly [key: string]: unknown;
};

export async function verifyNotice(notice: Notice, keys: PublishedKeys): Promise<Verified> {
	return verifySigned(notice, keys, null, 'notice');
}

export const CHALLENGE_SCHEMA = 'teppi.watch.challenge.v1';

// The handler at a watcher's url: echoes the challenge, passes on only a notice that verifies.
export function noticeReceiver(
	onNotice: (notice: Notice) => unknown,
	options: CheckOptions = {},
): (request: Request) => Promise<Response> {
	return async (request) => {
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return new Response('not json', { status: 400 });
		}
		if (body.schema === CHALLENGE_SCHEMA && typeof body.challenge === 'string') {
			return Response.json({ challenge: body.challenge });
		}
		const verified = await verifyNotice(body as Notice, await publishedKeys(options));
		if (!verified.ok) return new Response(verified.why, { status: 401 });
		await onNotice(body as Notice);
		return new Response(null, { status: 204 });
	};
}

// What a request is named by: RFC 8785 of its url, verb and body, exactly as it was sent on.
export function requestBytes(url: string, method: string, body: unknown): string {
	return canonical({ url, method, body: body === undefined ? null : body });
}

// sha256 over the salt from x-teppi-salt, then the bytes, as a receipt's commitments are built.
export async function commitmentOf(saltHex: string, bytes: string): Promise<string> {
	if (!/^[0-9a-f]{64}$/.test(saltHex)) throw new Error('a salt is thirty two bytes of hex');
	const { createHash } = await import('node:crypto');
	const digest = createHash('sha256')
		.update(Buffer.from(saltHex, 'hex'))
		.update(Buffer.from(bytes, 'utf8'))
		.digest('hex');
	return `salted-sha256:${digest}`;
}

// What Teppi signs for a payment it captured or voided: the delivery the seller declared, checked.
export type DeliveryStatement = {
	readonly schema: 'teppi.delivery.v1';
	readonly payment_info_hash: string;
	readonly delivery: { readonly passed: boolean; readonly response_hash: string } | null;
	readonly signing_key_id: string | null;
	readonly signature: string | null;
	readonly [key: string]: unknown;
};

// The statement is Teppi's, and the bytes are the buyer's: a mismatch between them is a dispute.
export async function verifyDelivery(
	statement: DeliveryStatement,
	body: string,
	keys: PublishedKeys,
): Promise<Verified> {
	const signed = await verifySigned(statement, keys, 'receipt', 'delivery statement');
	if (!signed.ok) return signed;
	if (statement.delivery === null) return { ok: false, why: 'no delivery was checked for it' };
	const { createHash } = await import('node:crypto');
	const received = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
	return received === statement.delivery.response_hash
		? signed
		: {
				ok: false,
				why: `the bytes received hash to ${received}, not the ${statement.delivery.response_hash} declared`,
			};
}

// What a payer signs, with its own wallet, to say it received other bytes than were declared.
export const disputeMessage = (paymentInfoHash: string, receivedHash: string): string =>
	`Teppi dispute ${paymentInfoHash.toLowerCase()} received ${receivedHash}`;

// What /v1/facilitator/supported advertises, copied into a seller's own 402.
export type FacilitatorKind = {
	readonly extra: {
		readonly captureAuthorizer: string;
		readonly feeRecipient: string;
		readonly minFeeBps: number;
		readonly maxFeeBps: number;
		readonly authCaptureEscrow: string;
	};
};

// A seller's escrow terms naming Teppi to capture, released only for a checked delivery.
export function teppiEscrowTerms(o: {
	readonly kind: FacilitatorKind;
	readonly payTo: string;
	// Atomic USDC, six decimals: a dollar is 1000000.
	readonly amount: string;
	// The seller's own key, which signs each capture it asks Teppi for.
	readonly receiverAuthorizer: string;
	readonly resource: string;
	readonly outputSchema?: unknown;
	readonly holdSeconds?: number;
	readonly nowS?: number;
}) {
	const nowS = o.nowS ?? Math.floor(Date.now() / 1000);
	const deadline = nowS + (o.holdSeconds ?? 1800);
	return {
		scheme: 'auth-capture',
		network: 'eip155:8453',
		amount: o.amount,
		asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		payTo: o.payTo,
		maxTimeoutSeconds: 120,
		resource: o.resource,
		...(o.outputSchema === undefined ? {} : { outputSchema: o.outputSchema }),
		extra: {
			name: 'USD Coin',
			version: '2',
			authCaptureEscrow: o.kind.extra.authCaptureEscrow,
			captureAuthorizer: o.kind.extra.captureAuthorizer,
			operatorType: 'delegated',
			paymentFlow: 'escrow',
			captureMode: 'sync',
			receiverAuthorizer: o.receiverAuthorizer,
			feeRecipient: o.kind.extra.feeRecipient,
			minFeeBps: o.kind.extra.minFeeBps,
			maxFeeBps: o.kind.extra.maxFeeBps,
			captureDeadline: deadline,
			refundDeadline: deadline,
			assetTransferMethod: 'eip3009',
		},
	};
}

// What /v1/facilitator/settle answered when it locked the money: the fee the capture must name.
export type Locked = {
	readonly paymentInfoHash: string;
	readonly captureFee: string;
	readonly feeReceiver: string;
};

// The typed data a seller's key signs to ask for its capture, as the auth-capture spec names it.
export function captureAsk(operator: string, locked: Locked, amount: string) {
	return {
		domain: {
			name: 'x402 Auth Capture Operator',
			version: '1',
			chainId: 8453,
			verifyingContract: operator,
		},
		types: {
			Capture: [
				{ name: 'paymentInfoHash', type: 'bytes32' },
				{ name: 'amount', type: 'uint256' },
				{ name: 'feeAmount', type: 'uint256' },
				{ name: 'feeReceiver', type: 'address' },
				{ name: 'expectedCapturableAmount', type: 'uint256' },
				{ name: 'expectedRefundableAmount', type: 'uint256' },
			],
		},
		primaryType: 'Capture' as const,
		message: {
			paymentInfoHash: locked.paymentInfoHash,
			amount: BigInt(amount),
			feeAmount: BigInt(locked.captureFee),
			feeReceiver: locked.feeReceiver,
			expectedCapturableAmount: BigInt(amount),
			expectedRefundableAmount: 0n,
		},
	};
}

// The settle body asking for the capture, carrying the bytes served so Teppi checks them first.
export function captureRequest(
	locked: Locked,
	amount: string,
	signature: string,
	delivery: { readonly status: number; readonly contentType: string; readonly body: string },
) {
	return {
		x402Version: 2,
		paymentPayload: {
			x402Version: 2,
			payload: {
				type: 'capture',
				paymentInfoHash: locked.paymentInfoHash,
				amount,
				feeAmount: locked.captureFee,
				feeReceiver: locked.feeReceiver,
				expectedCapturableAmount: amount,
				expectedRefundableAmount: '0',
				authorizerSignature: signature,
				delivery,
			},
		},
		paymentRequirements: {},
	};
}

export {
	DELIVERY_TAG,
	digestMatches,
	type Jwk,
	KEY_DIRECTORY,
	parseSignatureInput,
	parseSignatures,
	type SellerSigned,
	type SellerSignedInput,
	type SignedMessage,
	signatureBase,
	verifyBase,
	verifySellerSignature,
} from './signed.ts';
