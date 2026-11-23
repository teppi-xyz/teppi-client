# teppi-client

Ask the Teppi record about an x402 endpoint before your agent pays it. Zero dependencies.

```ts
import { beforeYouPay, check, publishedKeys, teppiHook, verify } from 'teppi-client';

// One GET. Unrated means not enough observed yet; it is never a low grade.
const answer = await check('https://seller.example/v1/extract');

// With the official client: abort payload creation when the record says not to pay.
client.onBeforePaymentCreation(teppiHook({ minBand: 'C' }));

// With any client that wraps fetch: a refused 402 becomes a 403 that names why.
const fetchWithPayment = wrapFetchWithPayment(beforeYouPay(fetch), client);

// Show a principal what Teppi said: every answer is signed by a published check key.
const keys = await publishedKeys();
const proof = await verify(answer, keys); // { ok: true, keyId } or { ok: false, why }

// Or have Teppi buy it for you, charged only if the answer passes its checks.
const fetchOnDelivery = wrapFetchWithPayment(beforeYouPay(fetch, { payOnDelivery: true }), client);
```

With `payOnDelivery`, a 402 from an endpoint the record will buy is answered with Teppi's own
402 instead: the seller's price plus a fee (10%, at least $0.002), settled only if the answer
came back whole and matching the seller's published schema. The x402 client pays it as usual and
the wrapper sends its paid retry to Teppi, never to the seller. Where Teppi cannot quote the call,
the seller's own terms stand. `answer.buy` says the same thing for a caller that decides itself.
Add `publish: true` and the call you bought goes into the public record under one opaque name for
your wallet, where it can pull a seller's figures down and never push them up; left off, nothing
you sent is published.

A purchase answers with `x-teppi-order`, a `Link` to its signed receipt, and `x-teppi-salt`.
`verifyReceipt(receipt, keys)` checks the receipt against a key published for receipts and
nothing else, and `commitmentOf(salt, bytes)` shows anyone that the bytes you got are the ones
the receipt is bound to, without the record ever holding them in public.

`verifyScorecard(card, keys)` checks a grade card from `/v1/trust/{id}` against the key that signs
cards. To rerun the grade itself from public evidence, use `npx teppi-check verify <cap_id>`.

When Teppi chooses the seller for you (`/v1/chat/completions`, `/v1/figures/company`), the plan
receipt carries what the rule saw as `plan.routing`: each seller's price, calls and lower bound, who
was short of evidence and who was left out. `explainOrder(orderId)` reads that receipt and
`/v1/market/records` as of its instant, recounts every figure with the same rule the router runs
(`rankSellers`, `triesFrom`, held to the router's own by a property test), and says `same` or
`DIFF` for each, so the choice rests on the public file and not on Teppi's word.

`teppiHook` reads the resource url and the payee off the 402 the client is about to pay and
returns `{ abort: true, reason }` when the policy refuses. `beforeYouPay` does the same for a
client that only knows fetch. The default policy refuses a listing the record says is broken and
one graded D or F, and pays everything else, unrated included. Pass `{ unrated: 'refuse' }` to pay
only what has been graded, `{ minBand: 'B' }` to raise the line, or your own
`policy(answer, request)`. When the record cannot be reached the payment goes ahead unless you
pass `{ whenUnreachable: 'refuse' }`.

A seller can name any amount in a 402, and a client signs what it is asked. Both also refuse a
402 asking more than five times what the endpoint's own last 402 asked, in the same token,
compared in its smallest unit: a spending cap limits a loss, this stops the spike. Set
`{ maxOverUsual: 2 }` to tighten it or `{ maxOverUsual: false }` to turn it off. `beforeYouPay`
refuses only when every option in the 402 is over, since the client picks among them later.

`checkTool()` is the same check as one tool for an agent framework, with a name, a JSON schema and
`execute({ url, method })`; snippets for the Vercel AI SDK, the OpenAI Agents SDK and LangChain are
at https://api.teppi.xyz/docs/integrations.

`teppiConfirm()` is the confirmation callback Cloudflare's Agents SDK asks before `withX402Client`
pays an MCP tool. The SDK hands it the payment terms and no url, so it refuses a payee whose paid
calls settled with nothing usable back, and checks the server's own url when you pass `{ server }`.
`refusedPayouts()` is that list on its own, read once and kept for ten minutes. For Python and
Amazon Bedrock AgentCore, `pip install teppi-client` gives the same rules as AgentCore's
`pre_sign_policy`.

`payeeWatch()` tells you when someone your agent already paid lands on that list later. Pass it
as `watch` to `teppiHook` or `teppiConfirm` and every payee they let through is remembered; it reads
`/v1/policy/payouts` every fifteen minutes and calls `onChange` only when a payee joins or leaves,
with why (`kept` money for nothing, or mostly `wrong` answers) and the evidence. No server, webhook
or account is needed.

```ts
import { payeeWatch, teppiHook } from 'teppi-client';

const watch = payeeWatch({ onChange: (c) => console.warn('payee changed', c) });
client.onBeforePaymentCreation(teppiHook({ watch }));
```

A url the record has never seen is put in line for a free handshake by the asking, so the second
answer carries what it said. Every answer names `npx teppi-check <url>`, which runs the same
handshake from your own machine, and `payee` says what the record knows about whoever gets paid
when the url itself says nothing.

To be told when a card you depend on falls, register a receiver at `POST /v1/watchers` and serve
`noticeReceiver(onNotice)` there: it echoes the challenge the registration sends, and passes on
only a notice that `verifyNotice` holds to the key that signs the cards.

A seller that signs its paid responses under RFC 9421 gives you proof of what it sent that holds
without trusting anyone in between. `verifySellerSignature({ request, response, body })` reads a
signature tagged `x402-delivery`, refuses one that leaves out the status, the body's
`content-digest`, the content type, the request's method, authority, path and
`request-commitment`, or the payment, fetches the key only from the seller's own
`/.well-known/http-message-signatures-directory`, and checks the body and the signature. It is held
to RFC 9421's own test vectors.

The record: https://api.teppi.xyz/docs/verification-method

Where this goes in the official x402 client, any fetch, Python or an MCP config:
https://api.teppi.xyz/docs/integrations
