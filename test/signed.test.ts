// Held to RFC 9421's own test vectors first, then to what a delivery signature must cover.

import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	type Jwk,
	parseSignatureInput,
	parseSignatures,
	signatureBase,
	verifyBase,
	verifySellerSignature,
} from '../src/index.ts';

// RFC 9421 appendix B.1.4 and B.1.3, the public halves only.
const ED25519: Jwk = {
	kty: 'OKP',
	crv: 'Ed25519',
	kid: 'test-key-ed25519',
	x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs',
};
const P256: Jwk = {
	kty: 'EC',
	crv: 'P-256',
	kid: 'test-key-ecc-p256',
	x: 'qIVYZVLCrPZHGHjP17CTW0_-D9Lfw0EkjqF7xB4FivA',
	y: 'Mc4nN9LTDOBhfoUeg8Ye9WedFRhnZXZJA12Qp0zZ6F0',
};

// The test-request and test-response messages of RFC 9421 appendix B.2.
const testRequest = {
	method: 'POST',
	url: 'https://example.com/foo?param=Value&Pet=dog',
	headers: new Headers({
		host: 'example.com',
		date: 'Tue, 20 Apr 2021 02:07:55 GMT',
		'content-type': 'application/json',
		'content-digest':
			'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
		'content-length': '18',
	}),
};
const testResponse = {
	status: 200,
	headers: new Headers({
		date: 'Tue, 20 Apr 2021 02:07:56 GMT',
		'content-type': 'application/json',
		'content-digest':
			'sha-512=:mEWXIS7MaLRuGgxOBdODa3xqM1XdEvxoYhvlCFJ41QJgJc4GTsPp29l5oGX69wWdXymyU0rjJuahq4l5aGgfLQ==:',
		'content-length': '23',
	}),
};

describe('RFC 9421 test vectors', () => {
	it('rebuilds the B.2.6 signature base byte for byte and verifies its ed25519 signature', async () => {
		const [input] = parseSignatureInput(
			'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
		);
		if (!input) throw new Error('no input parsed');
		const base = signatureBase(input, testRequest);
		expect(base).toBe(
			[
				'"date": Tue, 20 Apr 2021 02:07:55 GMT',
				'"@method": POST',
				'"@path": /foo',
				'"@authority": example.com',
				'"content-type": application/json',
				'"content-length": 18',
				'"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
			].join('\n'),
		);
		const sig = parseSignatures(
			'sig-b26=:wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==:',
		).get('sig-b26');
		if (!sig) throw new Error('no signature parsed');
		expect(await verifyBase(base, sig, ED25519)).toBe(true);
		expect(await verifyBase(`${base} `, sig, ED25519)).toBe(false);
	});

	it('verifies the B.2.4 response signed with ecdsa-p256-sha256', async () => {
		const [input] = parseSignatureInput(
			'sig-b24=("@status" "content-type" "content-digest" "content-length");created=1618884473;keyid="test-key-ecc-p256"',
		);
		if (!input) throw new Error('no input parsed');
		const sig = parseSignatures(
			'sig-b24=:wNmSUAhwb5LxtOtOpNa6W5xj067m5hFrj0XQ4fvpaCLx0NKocgPquLgyahnzDnDAUy5eCdlYUEkLIj+32oiasw==:',
		).get('sig-b24');
		if (!sig) throw new Error('no signature parsed');
		expect(await verifyBase(signatureBase(input, testResponse), sig, P256)).toBe(true);
	});
});

// A seller of our own making, signing the way a delivery signature has to.
function seller(covered = DELIVERY_COVER, tag = 'x402-delivery', lifetime = 300) {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const jwk = { ...(publicKey.export({ format: 'jwk' }) as Jwk), kid: 'seller-1' };
	const body = new TextEncoder().encode('{"price":"1.00"}');
	const digest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
	const request = {
		method: 'GET',
		url: 'https://seller.example/v1/price?symbol=BTC',
		headers: new Headers({
			'request-commitment': `salted-sha256:${'a'.repeat(64)}`,
			'payment-signature': 'eyJwYXlsb2FkIjp7fX0=',
		}),
	};
	const headers = new Headers({
		'content-type': 'application/json',
		'content-digest': digest,
		'payment-response': 'eyJ0cmFuc2FjdGlvbiI6IjB4In0=',
	});
	const params = `;created=1790000000;expires=${1790000000 + lifetime};keyid="seller-1";alg="ed25519";tag="${tag}"`;
	const raw = `(${covered})${params}`;
	headers.set('signature-input', `x402=${raw}`);
	const [input] = parseSignatureInput(`x402=${raw}`);
	const response = { status: 200, headers };
	const base = signatureBase(input as never, response, request);
	const signature = sign(
		null,
		Buffer.from(base),
		createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })),
	);
	headers.set('signature', `x402=:${signature.toString('base64')}:`);
	const directory = JSON.stringify({ keys: [jwk] });
	const asked: string[] = [];
	const fetchImpl: typeof fetch = async (url) => {
		asked.push(String(url));
		return new Response(directory, { status: 200 });
	};
	return { request, response, body, fetchImpl, asked, directory };
}

const DELIVERY_COVER =
	'"@status" "content-digest" "content-type" "@method";req "@authority";req "@path";req "request-commitment";req "payment-signature";req';

describe('verifySellerSignature', () => {
	it('holds a delivery signed over everything it must cover, with the key from the seller host', async () => {
		const s = seller();
		const got = await verifySellerSignature(s);
		expect(got).toMatchObject({ ok: true, keyid: 'seller-1', alg: 'ed25519', created: 1790000000 });
		expect(s.asked).toEqual([
			'https://seller.example/.well-known/http-message-signatures-directory',
		]);
		if (got.ok) {
			expect(got.directorySha256).toBe(createHash('sha256').update(s.directory).digest('hex'));
		}
	});

	it('reads a body changed after signing as not the one signed', async () => {
		const s = seller();
		const got = await verifySellerSignature({
			...s,
			body: new TextEncoder().encode('{"price":"9"}'),
		});
		expect(got).toEqual({ ok: false, why: 'the body does not match its content-digest' });
	});

	it('refuses a signature that binds nothing about the request', async () => {
		const s = seller('"@status" "content-digest" "content-type" "payment-response"');
		const got = await verifySellerSignature(s);
		expect(got.ok).toBe(false);
		if (!got.ok) expect(got.why).toContain('@method;req');
	});

	it('refuses a signature made for another purpose', async () => {
		const got = await verifySellerSignature(seller(DELIVERY_COVER, 'something-else'));
		expect(got).toEqual({ ok: false, why: 'no delivery signature' });
	});

	it('refuses a signature claiming to live past an hour', async () => {
		const got = await verifySellerSignature(seller(DELIVERY_COVER, 'x402-delivery', 7200));
		expect(got).toEqual({ ok: false, why: 'the signature claims to live longer than an hour' });
	});

	it('refuses when the request it answered is not the one kept', async () => {
		const s = seller();
		const moved = { ...s.request, url: 'https://seller.example/v1/other' };
		const got = await verifySellerSignature({ ...s, request: moved });
		expect(got).toEqual({ ok: false, why: 'the signature does not match the messages kept' });
	});
});
