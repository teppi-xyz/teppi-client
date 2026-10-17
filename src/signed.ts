// RFC 9421 signatures a seller puts on a paid response, read without trusting whoever relays them.

export type SignedMessage = {
	readonly method?: string;
	readonly url?: string;
	readonly status?: number;
	readonly headers: Headers;
};

export type Jwk = {
	readonly kty: string;
	readonly crv?: string;
	readonly kid?: string;
	readonly x?: string;
	readonly y?: string;
	readonly nbf?: number;
	readonly exp?: number;
};

type Item = { readonly name: string; readonly req: boolean };

export type SignatureInput = {
	readonly label: string;
	readonly items: readonly Item[];
	readonly params: Readonly<Record<string, string | number>>;
	// The inner list exactly as sent, which is what the signature base ends with.
	readonly raw: string;
};

// Members of a structured dictionary, split on commas outside quotes and parentheses.
function members(field: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quoted = false;
	let start = 0;
	for (let i = 0; i < field.length; i++) {
		const ch = field[i];
		if (quoted) {
			if (ch === '\\') i++;
			else if (ch === '"') quoted = false;
		} else if (ch === '"') quoted = true;
		else if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === ',' && depth === 0) {
			out.push(field.slice(start, i).trim());
			start = i + 1;
		}
	}
	out.push(field.slice(start).trim());
	return out.filter((m) => m.length > 0);
}

function paramsOf(text: string): Record<string, string | number> {
	const out: Record<string, string | number> = {};
	for (const m of text.matchAll(
		/;\s*([a-z*][a-z0-9_.*-]*)(?:=("(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z*][^;\s]*))?/g,
	)) {
		const [, key, value] = m;
		if (key === undefined) continue;
		if (value === undefined) out[key] = 1;
		else if (value.startsWith('"')) out[key] = value.slice(1, -1).replace(/\\(.)/g, '$1');
		else if (/^-?\d+$/.test(value)) out[key] = Number(value);
		else out[key] = value;
	}
	return out;
}

export function parseSignatureInput(field: string): SignatureInput[] {
	const out: SignatureInput[] = [];
	for (const member of members(field)) {
		const eq = member.indexOf('=');
		if (eq < 1) continue;
		const label = member.slice(0, eq).trim();
		const raw = member.slice(eq + 1).trim();
		const close = raw.indexOf(')');
		if (!raw.startsWith('(') || close === -1) continue;
		const items: Item[] = [];
		for (const m of raw.slice(1, close).matchAll(/"([^"]*)"((?:;[a-z]+(?:=[^\s;]+)?)*)/g)) {
			const [, name, rest] = m;
			if (name === undefined) continue;
			items.push({ name: name.toLowerCase(), req: /;req\b/.test(rest ?? '') });
		}
		out.push({ label, items, params: paramsOf(raw.slice(close + 1)), raw });
	}
	return out;
}

export function parseSignatures(field: string): Map<string, Uint8Array> {
	const out = new Map<string, Uint8Array>();
	for (const member of members(field)) {
		const m = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/=]*):$/.exec(member);
		if (m?.[1] && m[2] !== undefined) out.set(m[1], new Uint8Array(Buffer.from(m[2], 'base64')));
	}
	return out;
}

// RFC 9421 section 2: a derived component from the message, or a field's combined value.
function componentValue(
	item: Item,
	message: SignedMessage,
	request: SignedMessage | undefined,
): string {
	const from = item.req ? request : message;
	if (from === undefined) throw new Error(`"${item.name}";req names a request nobody kept`);
	const url = from.url === undefined ? null : new URL(from.url);
	switch (item.name) {
		case '@method':
			if (!from.method) throw new Error('@method on a message with no method');
			return from.method.toUpperCase();
		case '@authority':
			if (!url) throw new Error('@authority on a message with no url');
			return url.host.toLowerCase();
		case '@path':
			if (!url) throw new Error('@path on a message with no url');
			return url.pathname === '' ? '/' : url.pathname;
		case '@query':
			if (!url) throw new Error('@query on a message with no url');
			return url.search === '' ? '?' : url.search;
		case '@target-uri':
			if (!url) throw new Error('@target-uri on a message with no url');
			return url.href;
		case '@scheme':
			if (!url) throw new Error('@scheme on a message with no url');
			return url.protocol.replace(/:$/, '');
		case '@status':
			if (from.status === undefined) throw new Error('@status on a message with no status');
			return String(from.status);
		default: {
			if (item.name.startsWith('@')) throw new Error(`${item.name} is not a component this reads`);
			const value = from.headers.get(item.name);
			if (value === null) throw new Error(`${item.name} is covered and absent`);
			return value.trim();
		}
	}
}

// The exact bytes the seller signed, rebuilt from the messages as they were kept.
export function signatureBase(
	input: SignatureInput,
	message: SignedMessage,
	request?: SignedMessage,
): string {
	const lines = input.items.map(
		(item) => `"${item.name}"${item.req ? ';req' : ''}: ${componentValue(item, message, request)}`,
	);
	lines.push(`"@signature-params": ${input.raw}`);
	return lines.join('\n');
}

export type Algorithm = 'ed25519' | 'ecdsa-p256-sha256';

const algorithmOf = (key: Jwk): Algorithm | null =>
	key.kty === 'OKP' && key.crv === 'Ed25519'
		? 'ed25519'
		: key.kty === 'EC' && key.crv === 'P-256'
			? 'ecdsa-p256-sha256'
			: null;

export async function verifyBase(base: string, signature: Uint8Array, key: Jwk): Promise<boolean> {
	const alg = algorithmOf(key);
	if (alg === null) return false;
	const { createPublicKey, verify } = await import('node:crypto');
	const publicKey = createPublicKey({ key: key as never, format: 'jwk' });
	const data = Buffer.from(base, 'utf8');
	try {
		return alg === 'ed25519'
			? verify(null, data, publicKey, signature)
			: verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
	} catch {
		return false;
	}
}

// RFC 9530: the body hashed the way the header says, sha-256 or sha-512, at least one matching.
export async function digestMatches(field: string | null, body: Uint8Array): Promise<boolean> {
	if (field === null) return false;
	const { createHash } = await import('node:crypto');
	let any = false;
	for (const member of members(field)) {
		const m = /^(sha-256|sha-512)=:([A-Za-z0-9+/=]+):$/.exec(member);
		if (!m?.[1] || !m[2]) continue;
		const got = createHash(m[1] === 'sha-256' ? 'sha256' : 'sha512')
			.update(body)
			.digest('base64');
		if (got !== m[2]) return false;
		any = true;
	}
	return any;
}

export const DELIVERY_TAG = 'x402-delivery';
export const KEY_DIRECTORY = '/.well-known/http-message-signatures-directory';
const MAX_LIFETIME_SECONDS = 3600;

// The least a delivery signature covers; anything less binds less than a stranger needs.
const MUST_COVER: readonly Item[] = [
	{ name: '@status', req: false },
	{ name: 'content-digest', req: false },
	{ name: 'content-type', req: false },
	{ name: '@method', req: true },
	{ name: '@authority', req: true },
	{ name: '@path', req: true },
	{ name: 'request-commitment', req: true },
];

export type SellerSigned =
	| {
			readonly ok: true;
			readonly keyid: string;
			readonly alg: Algorithm;
			readonly created: number;
			// The key directory as fetched, hashed, so the entry can name exactly what was read.
			readonly directorySha256: string;
	  }
	| { readonly ok: false; readonly why: string };

export type SellerSignedInput = {
	readonly request: SignedMessage & { readonly method: string; readonly url: string };
	readonly response: SignedMessage & { readonly status: number };
	readonly body: Uint8Array;
	readonly fetchImpl?: typeof fetch;
};

const covers = (input: SignatureInput, want: Item) =>
	input.items.some((i) => i.name === want.name && i.req === want.req);

// A seller-signed delivery, read by rules any stranger holding the same bytes applies alike.
export async function verifySellerSignature(input: SellerSignedInput): Promise<SellerSigned> {
	const { request, response, body } = input;
	const inputs = parseSignatureInput(response.headers.get('signature-input') ?? '').filter(
		(i) => i.params.tag === DELIVERY_TAG,
	);
	const sig = input.response.headers.get('signature');
	if (inputs.length === 0 || sig === null) return { ok: false, why: 'no delivery signature' };
	const chosen = inputs[0] as SignatureInput;
	const missing = MUST_COVER.filter((m) => !covers(chosen, m));
	const paid =
		covers(chosen, { name: 'payment-signature', req: true }) ||
		covers(chosen, { name: 'payment-response', req: false });
	if (missing.length > 0 || !paid) {
		const names = missing.map((m) => `${m.name}${m.req ? ';req' : ''}`);
		if (!paid) names.push('payment-signature;req or payment-response');
		return { ok: false, why: `the signature leaves out ${names.join(', ')}` };
	}
	const { created, expires, keyid, alg } = chosen.params;
	if (typeof created !== 'number' || typeof expires !== 'number' || typeof keyid !== 'string') {
		return { ok: false, why: 'the signature names no created, expires and keyid' };
	}
	if (expires - created > MAX_LIFETIME_SECONDS || expires < created) {
		return { ok: false, why: 'the signature claims to live longer than an hour' };
	}
	const signature = parseSignatures(sig).get(chosen.label);
	if (!signature) return { ok: false, why: `no signature under the label ${chosen.label}` };
	if (!(await digestMatches(response.headers.get('content-digest'), body))) {
		return { ok: false, why: 'the body does not match its content-digest' };
	}

	// The seller's own host, and no other, says which keys are the seller's.
	const host = new URL(request.url).host;
	const where = `https://${host}${KEY_DIRECTORY}`;
	let text: string;
	try {
		const got = await (input.fetchImpl ?? fetch)(where, {
			headers: { accept: 'application/json' },
		});
		if (!got.ok) return { ok: false, why: `${where} answered ${got.status}` };
		text = await got.text();
	} catch (err) {
		return { ok: false, why: `${where} could not be read: ${(err as Error).message}` };
	}
	let keys: Jwk[];
	try {
		keys = ((JSON.parse(text) as { keys?: Jwk[] }).keys ?? []).filter((k) => k.kid === keyid);
	} catch {
		return { ok: false, why: `${where} is not json` };
	}
	const key = keys[0];
	if (!key) return { ok: false, why: `${where} names no key ${keyid}` };
	if (
		(key.nbf !== undefined && created < key.nbf) ||
		(key.exp !== undefined && created > key.exp)
	) {
		return { ok: false, why: `key ${keyid} was not in force when the response was signed` };
	}
	const keyAlg = algorithmOf(key);
	if (keyAlg === null || (typeof alg === 'string' && alg !== keyAlg)) {
		return { ok: false, why: `key ${keyid} does not sign ${String(alg ?? 'this way')}` };
	}
	let base: string;
	try {
		base = signatureBase(chosen, response, request);
	} catch (err) {
		return { ok: false, why: (err as Error).message };
	}
	if (!(await verifyBase(base, signature, key))) {
		return { ok: false, why: 'the signature does not match the messages kept' };
	}
	const { createHash } = await import('node:crypto');
	return {
		ok: true,
		keyid,
		alg: keyAlg,
		created,
		directorySha256: createHash('sha256').update(text, 'utf8').digest('hex'),
	};
}
