# VanityGrinder knowledge base

Last verified: 2026-11-16 against `14b5aca` (branch `audit/2026-11-16`; payment, header and key fixes in `07131e5`).

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
| Payment UI | `web/src/pay.js` | Wallet Standard discovery, the Connect wallet flow, status lines. |
| Payment state | `web/src/pay-flow.js` | The saved claim, polling, give-up rules, spending the token. No DOM, so it is unit-tested. |
| Functions | `web/netlify/functions/{quote,prepare,verify,consume}.mjs` | Netlify Functions v2 on `/api/<name>`. Shared code in `lib/`. |
| Ledger | Netlify Blobs store `grind-payments` | One record per spent transaction under `spent/<signature>`. |
| Shared | `shared/` | Base58, matching, odds (`grind-math.js`), price copy. Used by the page, the worker and the CLI. |
| CLI | `cli/` | Free Node.js grinder on `worker_threads`. No payment, no network. |

The grind runs only in the browser (or the CLI). The server never sees a key, a pattern, or a match.

## Trust boundaries

- **The browser trusts** its own bundle and the wallet, not the server's transaction: it decodes what prepare built and signs nothing but the exact expected transfer (see [The page's check before signing](#the-pages-check-before-signing)). It holds the claim and, once paid, the unlock token. It decides when to start a grind. A modified page can grind without paying. That is accepted: the key never goes to the server, so the server cannot meter the work. The paywall protects paying customers, not revenue.
- **The functions trust** the RPC node in `SOLANA_RPC_URL` for chain data, Netlify Blobs for the ledger, and `UNLOCK_SECRET`. The payee is not configuration: it is `PAY_TO` in `shared/payment.js`, and a `PAY_TO_ADDRESS` that names anything else makes quote, prepare and verify answer 503. They trust nothing a caller asserts. The claim only selects which reference the caller may speak for. The optional signature only says where to look. Everything that grants a grind is read from the finalized transaction.
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
        ── POST /api/consume {token} ──▶
                              HMAC check, create spent/<signature> if new ──▶ Blobs
        ◀── 200 ok / 409 reused
grind starts
```

### The claim and the reference

The page makes 32 random bytes, the claim, and saves it before it asks the server for anything. The transfer names `reference = base58(sha256(claim))` as a read-only account. The reference is public once the transaction lands. The claim is never sent anywhere except our own functions. Only the browser holding the claim can get a token for that payment. Knowing the reference, or any other account in the transaction, gives a third party nothing: verify looks up the hash of what it is sent, so nobody can choose the reference.

While a claim is saved and unresolved, the page starts no second payment. A reload, a closed tab, or a wallet that never answers leaves the claim saved, and the page picks it up again.

### The page's check before signing

`web/src/transfer-check.js`, `checkPreparedTransfer`, run by `pay.js` between prepare and the wallet. The check makes no network call. It decodes the legacy transaction and refuses to sign unless all of the following hold:

- There is exactly one signature slot, and the only signer is the connected wallet. That wallet is the fee payer.
- The accounts are exactly these nine: the wallet, its USDC account, the payee's USDC account, the payee `PAY_TO`, the USDC mint, the reference, and the System, Token and Associated Token programs. Only the wallet and the two USDC accounts are writable.
- There are exactly two instructions:
  - Associated Token `CreateIdempotent` for the payee's USDC account.
  - Token `TransferChecked` of 1,000,000 base units at 6 decimals of the USDC mint, from the wallet's USDC account to the payee's, with the wallet as authority and `sha256(claim)` as a read-only fifth account.

The USDC account addresses are derived in the page: SHA-256 for the program address, and a BigInt ed25519 curve test that matches the runtime's (`isOnCurve`). Tests check both against `@solana/web3.js` and `spl-token`. A refusal clears the claim, logs the reason to the console and tells the user nothing was charged. The payee, mint and price come from `shared/payment.js`, the same constants the functions use, so a transfer the functions build always passes. `functions.test.js` checks exactly that.

### verify

`lib/verify.js`, `verifyPayment`. In order:

1. The claim must be 32 Base58 bytes, and the signature, if sent, 64. Otherwise 400 `invalid`, with no RPC call.
2. **Find the transaction.** With the signature the wallet returned, `getSignatureStatuses` (searching history) says where that transaction stands. Transactions that third parties add naming the reference are never looked at. Without a signature (the wallet failed after sending, or an old page), the payment is the oldest successful transaction among `getSignaturesForAddress(reference)` at `confirmed`. The reference is unknown to everyone until that transaction is broadcast, so a later one cannot displace it. If the node returns a full page of 1,000 signatures, the oldest is out of sight: 503, decide nothing.
3. `processed` or `confirmed`: 202 `pending`. Nothing on chain: 202 `not_found`.
4. `getTransaction` at `finalized`, `jsonParsed`. Null: 202 `pending`.
5. `lib/assess.js` reads the recorded token balances. Over every token account the payee owned before and owns after, the payee's USDC (classic token program only) must have risen by exactly 1,000,000 base units. Integers throughout (`BigInt`). The transaction must have succeeded, be the one asked for, and name the reference.
6. Only then the ledger: `spent/<signature>` present means 409 `reused`.
7. Otherwise 200 with an unlock token. Verify writes nothing.

A 400 is a verdict about the claim's own transaction (`failed`, `wrong_amount`, `wrong_mint`), and the page gives the attempt up on it. Anything short of that, such as a node that serves the wrong transaction or one without its token balances, is 503 and decides nothing: the page keeps the claim and asks again. A signature that points at a transaction not naming the claim's reference is ignored and the claim is looked up by reference.

### The unlock token

`lib/token.js`. `base64url(JSON {v: 2, sig, exp, jti}) . base64url(HMAC-SHA256(UNLOCK_SECRET))`. Ten minutes. At most 512 characters. The MAC is compared with `timingSafeEqual` before the payload is parsed. `jti` is 12 random bytes, so two tokens for one payment always differ. `UNLOCK_SECRET` shorter than 16 characters counts as unset, and verify and consume answer 500.

### consume

`lib/verify.js`, `consumeUnlock`. One conditional write, `setJSON("spent/<signature>", {at, jti}, {onlyIfNew: true})` (`@netlify/blobs` 11, `If-None-Match: *`), is the whole decision. The first token to create the record wins; every other token for that transaction gets 409 `reused`. The token that won gets 200 every time it is presented again, even after it expires, so a page whose response was lost does not lose the grind. That repeat writes nothing. An expired token whose payment is unspent gets 401 `expired`, and the page asks verify for a fresh one.

### The page's side

`web/src/pay-flow.js`:

- `202 not_found` keeps polling until three minutes after the wallet sent (the blockhash has long expired by then), then gives up and clears the claim.
- `202 pending` keeps polling for as long as it takes.
- `503`, `429`, a proxy page or a dropped connection back off (up to 15 s) and keep the claim. A service that does not answer is never a reason to give a payment up.
- `400` with a reason and `409 reused` end the attempt and clear the claim.
- Spending retries a lost response with the same token, four times.

### Limits and cost

- `prepare`: 12 requests a minute per visitor (`ip` + `domain`), two RPC calls (three the first time the payee's USDC account is missing).
- `verify`: 60 a minute per visitor, one to four RPC calls (two in the usual case: the signature's status, then the transaction).
- Both are Netlify code-based rate limit rules (`export const config`). The free plan allows two per project.
- Every POST must be `application/json` and at most 4 KB, so another site cannot make its visitors' browsers spend our RPC quota with a simple form or text post.
- RPC calls time out after 8 seconds. There are no automatic retries.

## Key generation

`web/src/grind-worker.js` and `cli/worker.js`:

- 32 bytes from `crypto.getRandomValues` are the ed25519 seed (the CLI gets them through `@noble/curves`' `randomSecretKey`, which reads the same source).
- The public key comes from `@noble/curves`. The address is its Base58.
- The secret key is shown as Base58 of the 64 bytes `seed ‖ public key`, the layout Phantom, Solflare, Backpack and `solana-keygen` import.

`web/test/keys.test.js` pins this with the RFC 8032 vectors, a known seed checked against OpenSSL and `@solana/web3.js`, and keys from the real worker imported with `Keypair.fromSecretKey`.

The key reaches the page only through `postMessage` from the worker. It is shown hidden; the user clicks to reveal it, and the terminal clears 60 seconds after the reveal. Closing the tab while a grind runs or while a key is held asks first. The terminal is marked `translate="no"`, so browser page translation does not send it to a translation service. Nothing is written to storage except the payment claim (and, once sent, its transaction signature).

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

`web` tests use a mock chain (`web/test/helpers/chain.js`), a mock JSON-RPC node and Netlify's own local Blobs server (`web/test/helpers/servers.js`). They make no network call. `build.test.js` runs `vite build` itself and checks the output.
