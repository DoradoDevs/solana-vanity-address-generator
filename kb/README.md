# VanityGrinder knowledge base

Last verified: 2026-11-16 against `e4ea97a` (branch `audit/2026-11-16`; payment, header and key fixes in `07131e5`, payee pin and pre-sign check in `edb18ad`, review fixes in `e4ea97a`).

The code wins over this page. If they disagree, fix the page.

## Index

- [Architecture](#architecture): what runs where.
- [Trust boundaries](#trust-boundaries): what each side may believe.
- [The money path](#the-money-path): prepare, pay, verify, consume.
- [Key generation](#key-generation): how a key is made and why it never leaves the tab.
- [Response headers](#response-headers): the content security policy and where it comes from.
- [Running the gate](#running-the-gate): the checks that must pass before a commit.
- [Findings register](findings.md): what the 2026-11-16 audit found and what became of each finding.
- [DEPLOY.md](../DEPLOY.md): environment variables, Netlify settings, and checks for a live deploy.

## Architecture

| Part | Where | What it does |
|---|---|---|
| Page | `web/index.html`, `web/src/main.js`, `web/src/style.css` | A terminal-style UI. Asks for a pattern, waits for payment, runs the grind, shows the match. |
| Grind worker | `web/src/grind-worker.js` | Dedicated Web Workers, one per core. Generates ed25519 keys and matches their Base58 addresses. Has no network code. |
| Payment UI | `web/src/pay.js` | Wallet Standard discovery, the Connect wallet flow, status lines and notes. Tested with a stand-in document and wallet (`pay-page.test.js`). |
| Payment state | `web/src/pay-flow.js` | The saved claim, prepare → the page's check → the wallet (`pay`), polling, give-up rules, spending the token (`unlock`). No DOM, so it is unit-tested. |
| Functions | `web/netlify/functions/{quote,prepare,verify,consume}.mjs` | Netlify Functions v2 on `/api/<name>`. Shared code in `lib/`. |
| Ledger | Netlify Blobs store `grind-payments` | One record per spent transaction under `spent/<signature>`. |
| Shared | `shared/` | Base58, matching, odds (`grind-math.js`) and price copy, used by the page, the worker and the CLI. `payment.js` (payee, mint, price, program ids) and `pay-copy.js`, used by the page and the functions alike. |
| CLI | `cli/` | Free Node.js grinder on `worker_threads`. No payment, no network. |

The grind runs only in the browser (or the CLI). The server never sees a key, a pattern, or a match.

## Trust boundaries

- **The browser trusts** its own bundle and the wallet, not the server's transaction: it decodes what prepare built and signs nothing but the exact expected transfer (see [The page's check before signing](#the-pages-check-before-signing)). It holds the claim and, once paid, the unlock token. It decides when to start a grind. A modified page can grind without paying. That is accepted: the key never goes to the server, so the server cannot meter the work. The paywall protects paying customers, not revenue.
- **The functions trust** the RPC node in `SOLANA_RPC_URL` for chain data, Netlify Blobs for the ledger, and `UNLOCK_SECRET`. The payee is not configuration: it is `PAY_TO` in `shared/payment.js`, and a `PAY_TO_ADDRESS` that names anything else makes quote, prepare and verify answer 503. That closes this one variable, nothing more: whoever can change the build environment (`NODE_OPTIONS` runs code inside `npm run build`) or deploy code is still trusted with where payments go. DEPLOY.md has the checks. They trust nothing a caller asserts. The claim only selects which reference the caller may speak for. The optional signature only says where to look. Everything that grants a grind is read from the finalized transaction.
- **The RPC URL** carries an API key. It never goes into a response, an error message or a log line. `lib/rpc.js` turns every failure into `RpcError("<method>: <short cause>")`.
- **The worker** is served with its own policy, `default-src 'none'`, so it cannot open a connection even if its code were changed.

## The money path

```
page                          functions                         chain / ledger
----                          ---------                         --------------
claim = 32 random bytes
saved in localStorage
        ── POST /api/prepare {payer, claim} ──▶
                              reference = base58(sha256(claim))
                              getMultipleAccounts, getLatestBlockhash
        ◀── unsigned tx (CreateIdempotent + TransferChecked 1.00 USDC, reference read-only)
page decodes and checks it (transfer-check.js); anything else: refuse, nothing sent
wallet signs and sends ─────────────────────────────────────────▶ transaction lands
signature saved with the claim
        ── POST /api/verify {claim, signature} ──▶  (polled every 3 s)
                              getSignatureStatuses(signature)
                              (or getSignaturesForAddress(reference) without one)
                              getTransaction(finalized), assess, ledger read
        ◀── 202 not_found / 202 pending / 200 token / 400 verdict / 409 reused / 503
token saved with the claim
        ── POST /api/consume {token} ──▶
                              HMAC check, create spent/<signature> if new ──▶ Blobs
        ◀── 200 ok / 409 reused
grind starts
```

### The claim and the reference

The page makes 32 random bytes, the claim, and saves it before it asks the server for anything. The transfer names `reference = base58(sha256(claim))` as a read-only account. The reference is public once the transaction lands. The claim is never sent anywhere except our own functions. Only the browser holding the claim can get a token for that payment. Knowing the reference, or any other account in the transaction, gives a third party nothing: verify looks up the hash of what it is sent, so nobody can choose the reference.

While a claim is saved and unresolved, the page starts no second payment. A reload, a closed tab, or a wallet that never answers leaves the claim saved, and the page picks it up again.

### The page's check before signing

`web/src/transfer-check.js`, `checkPreparedTransfer`. `pay-flow.js`'s `pay` runs it between prepare and the wallet and hands the wallet only bytes that pass, unchanged; `pay.js` starts every payment through `pay`. A check that throws counts as a refusal. The check makes no network call. It decodes the legacy transaction and refuses to sign unless all of the following hold:

- There is exactly one signature slot, and the only signer is the connected wallet. That wallet is the fee payer.
- The accounts are exactly these nine: the wallet, its USDC account, the payee's USDC account, the payee `PAY_TO`, the USDC mint, the reference, and the System, Token and Associated Token programs. Only the wallet and the two USDC accounts are writable.
- There are exactly two instructions:
  - Associated Token `CreateIdempotent` for the payee's USDC account.
  - Token `TransferChecked` of 1,000,000 base units at 6 decimals of the USDC mint, from the wallet's USDC account to the payee's, with the wallet as authority and `sha256(claim)` as a read-only fifth account.

The decoder reads lengths the way the runtime's `short_vec` does: one spelling per value, nothing above u16, anything else unreadable.

The USDC account addresses are derived in the page: SHA-256 for the program address, and a BigInt ed25519 curve test (`isOnCurve`) that follows the runtime's point decompression (curve25519-dalek): it reduces y mod p and ignores the sign bit, the same rule as `@noble/curves` with zip215. `@solana/web3.js`'s `PublicKey.isOnCurve` agrees on every canonical encoding and differs only on y ≥ p and on x = 0 with the sign bit set, which a SHA-256 output cannot realistically hit. Tests check the curve test against noble zip215 on those edge encodings and against web3.js on random inputs, and the derived accounts against `spl-token`. Every rule has a test that fails when that rule alone is removed, and every refusal is asserted by its exact reason. A refusal clears the claim, logs the reason to the console and tells the user nothing was charged and, in case the site was just updated, to reload. The payee, mint and price come from `shared/payment.js`, the same constants the functions use, so a transfer the functions build always passes. `functions.test.js` checks exactly that.

### verify

`lib/verify.js`, `verifyPayment`. In order:

1. The claim must be 32 Base58 bytes, and the signature, if sent, 64. Otherwise 400 `invalid`, with no RPC call.
2. **The page's own transaction.** With the signature the wallet returned, `getSignatureStatuses` (searching history) says where that transaction stands: `processed` or `confirmed` is 202 `pending`; otherwise `getTransaction` at `finalized`, `jsonParsed` (null: 202 `pending`) and `lib/assess.js`. If it pays, it is the payment. If it names the claim's reference but does not pay (`failed`, `wrong_amount`, `wrong_mint`), that is a 400 verdict. If the node does not know the signature, or the transaction does not name the reference, the pointer is ignored and verify searches by reference.
3. **The search by reference.** `getSignaturesForAddress(reference)` at `confirmed`. The reference is public once the payment is broadcast, so anyone can add transactions naming it; none of them can redeem anything, because only the claim holder gets a token and a payment is spent once by its signature. So any transaction that pays is the payment. Successful rows are read oldest first (the claim's own payment is broadcast before anyone can know the reference), at most four per request. What does not pay may be someone else's, so the search never ends in a 400: nothing listed is 202 `not_found`; something not yet final is 202 `pending`; an odd answer from the node, rows left unread, or a full page of 1,000 is 503; a paying transaction already spent, with nothing else to read, is 409 `reused`; otherwise nothing pays and it is 202 `not_found`, and the page's give-up clock decides.
4. `lib/assess.js` reads the recorded token balances. Over every token account the payee owned before and owns after, the payee's USDC (classic token program only) must have risen by exactly 1,000,000 base units. Integers throughout (`BigInt`). The transaction must have succeeded, be the one asked for, and name the reference.
5. Only then the ledger: `spent/<signature>` present means 409 `reused`.
6. Otherwise 200 with an unlock token. Verify writes nothing.

A 400 is only ever a verdict on the transaction the page pointed at, read at `finalized` and naming the claim's reference: the claim's own. The page gives the attempt up on it. Anything short of that is a 202 or a 503 and decides nothing: the page keeps the claim and asks again.

### The unlock token

`lib/token.js`. `base64url(JSON {v: 2, sig, exp, jti}) . base64url(HMAC-SHA256(UNLOCK_SECRET))`. Ten minutes. At most 512 characters. The MAC is compared with `timingSafeEqual` before the payload is parsed. `jti` is 12 random bytes, so two tokens for one payment always differ. `UNLOCK_SECRET` shorter than 16 characters counts as unset, and verify and consume answer 500.

### consume

`lib/verify.js`, `consumeUnlock`. One conditional write, `setJSON("spent/<signature>", {at, jti}, {onlyIfNew: true})` (`@netlify/blobs` 11, `If-None-Match: *`), is the whole decision, as long as the store makes it atomically:

- Hosted Netlify Blobs: Netlify's documentation (<https://docs.netlify.com/build/data-and-storage/netlify-blobs/>, checked 2026-11-16) presents `onlyIfMatch` and `onlyIfNew` as the way "to do atomic, conditional writes", and the client documents that when "a concurrent write to the same key wins the race, the operation will return with `modified: false`". The "last write wins" note in Netlify's troubleshooting section is about unconditional writes. The suite cannot reach the hosted store, so this is Netlify's guarantee, not something the tests prove.
- `web/test/ledger.test.js` sends 50 concurrent consumes for one payment through the real consume function and the real Blobs client to an atomic stand-in (`startAtomicBlobs`) and requires exactly one winner. A get-then-write store, or a write without `onlyIfNew`, fails it. A contract test checks that the store is opened with `consistency: "strong"` and that only `modified: true` counts as a win.
- Netlify's local `BlobsServer`, which `netlify dev` and `functions.test.js` use, is **not** atomic: it checks for the key and writes it across awaits, and concurrent spends against it can all succeed. It shows the protocol, never single-spend.

Reads are strongly consistent. The conditional write decides who wins, but the winning token's retry learns it won by reading the record back, and verify reports a spent payment by reading it; a read from an edge cache could miss a record that exists. `ledger.test.js` puts a cache in front of the store that keeps misses, and the winner's retry must still get 200. The first token to create the record wins; every other token for that transaction gets 409 `reused`. The token that won gets 200 every time it is presented again, even after it expires, so a page whose response was lost does not lose the grind. That repeat writes nothing. An expired token whose payment is unspent gets 401 `expired`, and the page asks verify for a fresh one.

### The page's side

`web/src/pay-flow.js`:

- `pay`: a new claim, prepare, the check, the wallet. A wallet error that says nothing was sent (declined, short of funds, or refused at preflight such as "Blockhash not found" or "simulation failed") clears the claim, so the customer can pay again at once. Any other wallet error keeps the claim and starts the give-up clock, because the transfer may have gone out.
- `202 not_found` keeps polling until three minutes after the wallet sent (the blockhash has long expired by then), then gives up and clears the claim. While it waits without the wallet's signature, the status says why and counts down the time left.
- `202 pending` keeps polling for as long as it takes.
- `503`, `429`, a proxy page or a dropped connection back off (up to 15 s) and keep the claim. A service that does not answer is never a reason to give a payment up.
- `400` and `409` end the attempt and clear the claim only with their reason in the body (`400` with a reason, `409 reused`); without it they are a proxy's answer and decide nothing.
- After ten minutes neither confirmed nor ruled out, the page offers to give the attempt up, with a warning and then the reference (and signature, if known) to quote for a refund. Nothing gives it up on its own.
- `unlock` saves the token, and its expiry, with the claim before calling consume, and retries a lost response with the same token four times. A reload finds the saved token and spends it again before asking verify for a new one; the token that won gets 200 every time. Closing the tab while a spend is on its way asks first.
- A reference saved by the version before claims (`vg-pay-ref`) cannot be redeemed. The page shows it with how to ask for a refund, until the customer hides it.

### Limits and cost

- `prepare`: 12 requests a minute per visitor (`ip` + `domain`), two RPC calls (three the first time the payee's USDC account is missing).
- `verify`: 60 a minute per visitor, one to seven RPC calls (two in the usual case: the signature's status, then the transaction; at most the status, that transaction, the reference listing and four listed transactions).
- Both are Netlify code-based rate limit rules (`export const config`). The free plan allows two per project.
- Every POST must be `application/json` and at most 4 KB, so another site cannot make its visitors' browsers spend our RPC quota with a simple form or text post.
- RPC calls time out after 8 seconds. There are no automatic retries.

## Key generation

`web/src/grind-worker.js` and `cli/worker.js`:

- 32 bytes from `crypto.getRandomValues` are the ed25519 seed (the CLI gets them through `@noble/curves`' `randomSecretKey`, which reads the same source).
- The public key comes from `@noble/curves`. The address is its Base58.
- The secret key is shown as Base58 of the 64 bytes `seed ‖ public key`, the layout Phantom, Solflare, Backpack and `solana-keygen` import.

`web/test/keys.test.js` pins this with the RFC 8032 vectors, a known seed checked against OpenSSL and `@solana/web3.js`, and keys from the real worker imported with `Keypair.fromSecretKey`.

The key reaches the page only through `postMessage` from the worker. It is shown hidden; the user clicks to reveal it, and the terminal clears 60 seconds after the reveal. Closing the tab while a grind runs or while a key is held asks first. The terminal is marked `translate="no"`, so browser page translation does not send it to a translation service. Nothing is written to storage except the payment claim (with, once sent, its transaction signature and, once a spend starts, its unlock token), and nothing is read but that and the retired `vg-pay-ref`.

## Response headers

`web/src/headers.js` is the only definition. `vite build` writes `dist/_headers` from it (`web/vite.config.js`) and fails if a published page contains inline script or style, or if it cannot find exactly one grind worker.

- Page: `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'self'`.
- Worker (`/assets/grind-worker-*.js`): `default-src 'none'; frame-ancestors 'none'`. A dedicated worker loaded by URL is governed by its own response's policy (checked in Chromium).

`netlify.toml` and `web/netlify.toml` hold no headers. Netlify reads `web/netlify.toml` when the base directory is `web`; the two files are identical apart from `base`.

## Running the gate

Node.js 22.12 or newer for `web/` (`@netlify/blobs` 11), 20.19 or newer for `cli/`.

```bash
cd web && npm ci && npm test && npm run build
cd ../cli && npm ci && npm test
```

`web` tests use a mock chain (`web/test/helpers/chain.js`), a mock JSON-RPC node, Netlify's own local Blobs server (protocol only: it is not atomic) and an atomic Blobs stand-in (`web/test/helpers/servers.js`). `pay-page.test.js` drives `pay.js` with a stand-in document and wallet. They make no network call. `build.test.js` runs `vite build` itself and checks the output. The gate has been run on Node 24 only; Netlify builds on Node 22.
