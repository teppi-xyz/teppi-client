# teppi-client

[![npm](https://img.shields.io/npm/v/teppi-client.svg)](https://www.npmjs.com/package/teppi-client)
[![license](https://img.shields.io/npm/l/teppi-client.svg)](./LICENSE)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

**Check an x402 endpoint before your agent pays it.**

A transaction hash proves your agent paid. It says nothing about what came back. Teppi pays x402
sellers itself, checks each answer, and publishes the result with the settlement transaction and
the hashes of the request and the response. `teppi-client` reads that record at the moment your
agent is about to sign, and refuses the payment when the record shows the seller is broken,
grades D or F, or is asking far more than usual.

- **Zero dependencies.** Node 22+.
- **Plugs into the official x402 client** as a hook, or wraps any `fetch`.
- **Every answer is signed.** Verify it against the published keys yourself.
- **Fails open by default.** If the record cannot be reached, your agent pays as it would have.

```sh
npm install teppi-client
```

## Quick start

### With the official x402 client

```ts
import { teppiHook } from 'teppi-client';

client.onBeforePaymentCreation(teppiHook({ minBand: 'C' }));
```

The hook sees the resource url and the payee before anything is signed. When the policy refuses,
it returns `{ abort: true, reason }` and no payment payload is created.

### With any client that wraps fetch

```ts
import { beforeYouPay } from 'teppi-client';

const fetchWithPayment = wrapFetchWithPayment(beforeYouPay(fetch), client);
```

A refused 402 comes back as a `403` whose body says why, before your wallet signs anything.

### Just ask

```ts
import { check } from 'teppi-client';

const answer = await check('https://seller.example/v1/extract');
// { band, tier, composite, why, defects, payee, reproduce: 'npx teppi-check ...', ... }
```

`UNRATED` means not enough has been observed yet. It is never a low grade, and the default policy
pays it.

## The default policy

| Situation | Default | Change it with |
|---|---|---|
| Listing the record shows as broken | refuse | your own `policy(answer, request)` |
| Graded D or F | refuse | `{ minBand: 'B' }` to raise the line |
| `UNRATED` | pay | `{ unrated: 'refuse' }` |
| 402 asks more than 5x the endpoint's last price, same token | refuse | `{ maxOverUsual: 2 }` or `false` |
| Record unreachable | pay | `{ whenUnreachable: 'refuse' }` |

The price check compares atomic amounts in the same token. `beforeYouPay` refuses only when every
option in the 402 is over, since the client picks among them afterwards.

## Verify what you were told

```ts
import { publishedKeys, verify } from 'teppi-client';

const keys = await publishedKeys();
const proof = await verify(answer, keys); // { ok: true, keyId } or { ok: false, why }
```

Answers are signed with Ed25519 over RFC 8785 canonical JSON, by a key published at
`/.well-known/teppi-keys.json` for that purpose only. `verifyScorecard(card, keys)` does the same
for a grade card from `/v1/trust/{id}`. To recompute a grade from its public evidence, run
`npx teppi-check verify <cap_id>`.

## Pay only on delivery

```ts
const fetchOnDelivery = wrapFetchWithPayment(beforeYouPay(fetch, { payOnDelivery: true }), client);
```

Where the record can buy the endpoint for you, the seller's 402 is replaced by Teppi's own: the
seller's price plus a fee (10%, at least $0.002). Teppi pays the seller, checks the answer against
the seller's published schema, and settles your payment only if it passed. A failed call costs you
nothing. Where Teppi cannot quote the call, the seller's own terms stand.

Each purchase returns `x-teppi-order`, a `Link` to a signed receipt, and `x-teppi-salt`:

```ts
import { commitmentOf, verifyReceipt } from 'teppi-client';

await verifyReceipt(receipt, keys);                                // signed by a receipt key
(await commitmentOf(salt, bytes)) === receipt.response_commitment; // these are the bytes it covers
```

The record never holds your request or answer in public, only a salted commitment to them. Add
`publish: true` to put the call into the public record under one opaque name for your wallet; it
can lower a seller's figures and never raise them.

## Delivery evidence

```ts
import { deliveryCore, deliveryCoreId, disputeEvidence } from 'teppi-client';

const core = await deliveryCore({
  network: 'eip155:8453', transaction, payer, payTo, asset,
  amount: '3000', resourceUrl, method: 'POST',
  responseStatus: 200, body, issuedAt: new Date().toISOString(),
});
const id = await deliveryCoreId(core); // sha256 of the RFC 8785 form
```

`deliveryCore` holds the 11 fields that every x402 delivery-receipt proposal hashing a body has at
settle time, written one way so that two receipts about the same delivery share one id.
[x402-foundation/x402#4392](https://github.com/x402-foundation/x402/issues/4392) has a test vector
you can rerun with Python's standard library.

`disputeEvidence(receipt, keys, { salt, response })` turns a signed order receipt into plain text
for a dispute form, where each sentence is a fact the reader can check.

## More

| Export | What it does |
|---|---|
| `checkTool()` | The check as one tool (name, JSON schema, `execute`) for the Vercel AI SDK, OpenAI Agents SDK or LangChain |
| `teppiConfirm()` | Confirmation callback for Cloudflare Agents' `withX402Client` when paying MCP tools |
| `refusedPayouts()` | Payout addresses whose paid calls settled with nothing usable back, cached ten minutes |
| `payeeWatch({ onChange })` | Tells you when a payee your agent already paid joins or leaves that list |
| `noticeReceiver(onNotice)` | Receiver for `POST /v1/watchers` notices, verified against the card key |
| `verifySellerSignature()` | Checks a seller's RFC 9421 signature over a paid response, held to the RFC's test vectors |
| `explainOrder(orderId)` | Reruns the router's seller choice for an order from `/v1/market/records` and reports `same` or `DIFF` |

```ts
import { payeeWatch, teppiHook } from 'teppi-client';

const watch = payeeWatch({ onChange: (c) => console.warn('payee changed', c) });
client.onBeforePaymentCreation(teppiHook({ watch }));
```

A url the record has never seen is queued for a free handshake when you ask, so the next answer
covers it. Every answer names `npx teppi-check <url>`, which runs the same handshake from your
machine.

## Python

```sh
pip install teppi-client
```

The same rules, including a `pre_sign_policy` for Amazon Bedrock AgentCore.

## Links

- Integrations (official x402 client, fetch, Python, MCP config): https://api.teppi.xyz/docs/integrations
- How the record is measured: https://api.teppi.xyz/docs/verification-method
- Every paid call, as one file: https://api.teppi.xyz/v1/market/records
- Explorer: https://teppi.xyz

## License

MIT
