# VanityGrinder knowledge base

Last verified: 2026-11-19 against `31a7a1b` (branch `audit/2026-11-16`; payment, header and key fixes in `07131e5`, payee pin and pre-sign check in `edb18ad`, review fixes in `e4ea97a`, CI in `9d8eba3`, spl-token removal in `9273afb`, round-4 fixes in `a013fa9`, round-5 fixes in `4deedde`, refund-tool fixes in `31a7a1b`).

The code wins over this page. If they disagree, fix the page.

## Index

- [Architecture](#architecture): what runs where.
- [Trust boundaries](#trust-boundaries): what each side may believe.
- [The money path](#the-money-path): prepare, pay, verify, consume.
- [Key generation](#key-generation): how a key is made and why it never leaves the tab.
- [Response headers](#response-headers): the content security policy and where it comes from.
- [Page and design system](#page-and-design-system): the generator's layout, the vendored Quiet Technical files, and the UI rules.
- [Running the gate](#running-the-gate): the checks that must pass before a commit.
- [Findings register](findings.md): what the 2026-11-16 audit found and what became of each finding.
- [DEPLOY.md](../DEPLOY.md): environment variables, Netlify settings, and checks for a live deploy.

## Architecture

| Part | Where | What it does |
|---|---|---|
| Page | `web/index.html`, `web/src/main.js`, `web/src/match-view.js`, `web/src/unload.js`, `web/src/style.css` | The generator on Quiet Technical 2.3 (see [Page and design system](#page-and-design-system)). A form takes the pattern, payment unlocks one run, readouts and a console show the run, the console holds the key. |
| Grind worker | `web/src/grind-worker.js` | Dedicated Web Workers, one per core. Generates ed25519 keys and matches their Base58 addresses. Has no network code. |
| Payment UI | `web/src/pay.js` | Wallet Standard discovery, the Connect wallet flow, status lines and notes. Tested with a stand-in document and wallet (`pay-page.test.js`). |
| Payment state | `web/src/pay-flow.js` | The saved claim, prepare → the page's check → the wallet (`pay`), polling, give-up rules, spending the token (`unlock`). No DOM, so it is unit-tested. |
| Functions | `web/netlify/functions/{quote,prepare,verify,consume}.mjs` | Netlify Functions v2 on `/api/<name>`. Shared code in `lib/`. |
| Ledger | Netlify Blobs store `grind-payments` | One record per spent or refunded transaction under `spent/<signature>`. |
| Operator tool | `web/scripts/payments.mjs` | Run by the operator on their own computer, never deployed: checks a payment, marks one refunded, lists the old version's unspent payments. See [Refunds](#refunds). |
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
                              (or getSignaturesForAddress(reference, before: cursor), paged)
                              getTransaction(finalized), assess, ledger read
        ◀── 202 not_found / pending / searching+cursor, 200 token, 400 verdict, 409 reused / refunded, 503
token saved with the claim (one spend at a time per browser: the vg-pay-spend lock)
        ── POST /api/consume {token} ──▶
                              HMAC check, create spent/<signature> if new ──▶ Blobs
        ◀── 200 ok / 409 reused / 409 refunded
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

The USDC account addresses are derived in the page: SHA-256 for the program address, and a BigInt ed25519 curve test (`isOnCurve`) that follows the runtime's point decompression (curve25519-dalek): it reduces y mod p and ignores the sign bit, the same rule as `@noble/curves` with zip215. `@solana/web3.js`'s `PublicKey.isOnCurve` agrees on every canonical encoding and differs only on y ≥ p and on x = 0 with the sign bit set, which a SHA-256 output cannot realistically hit. Tests check the curve test against noble zip215 on those edge encodings and against web3.js on random inputs, and the derived accounts against known answers recorded from `@solana/spl-token` 0.4.15 before it was removed (`web/test/helpers/spl-token-vectors.js`; they cannot be regenerated without it, so they are kept as they are). The functions build the two instructions themselves (`lib/tx.js`); `spl-token-vectors.test.js` holds those builders to the same answers byte for byte. Every rule has a test that fails when that rule alone is removed, and every refusal is asserted by its exact reason. A refusal clears the claim, logs the reason to the console and tells the user nothing was charged and, in case the site was just updated, to reload. The payee, mint and price come from `shared/payment.js`, the same constants the functions use, so a transfer the functions build always passes. `functions.test.js` checks exactly that.

### verify

`lib/verify.js`, `verifyPayment`. In order:

1. The claim must be 32 Base58 bytes, and the signature, if sent, 64. Otherwise 400 `invalid`, with no RPC call.
2. **The page's own transaction.** With the signature the wallet returned, `getSignatureStatuses` (searching history) says where that transaction stands: `processed` or `confirmed` is 202 `pending`; otherwise `getTransaction` at `finalized`, `jsonParsed` (null: 202 `pending`) and `lib/assess.js`. If it pays, it is the payment. If it names the claim's reference but does not pay (`failed`, `wrong_amount`, `wrong_mint`), that is a 400 verdict. If the node does not know the signature, or the transaction does not name the reference, the pointer is ignored and verify searches by reference.
3. **The search by reference.** `getSignaturesForAddress(reference)` at `confirmed`, newest first, 1,000 rows a page. It walks back with `before` up to two pages (`REFERENCE_PAGES`) per request. If it has not reached the oldest end, it answers 202 `searching` with a `cursor`, the second-oldest signature it listed (a node lists strictly before the cursor, so the oldest row is listed again by the next request; a cursor naming the oldest row would skip it for good, and with a history of exactly a whole number of requests' worth that row is the payment); the page saves the cursor with the claim and sends it back, so a long history is walked to its end over several requests and across a reload. A cursor that is not a signature is a 400 `invalid` before any RPC call. The reference is public once the payment is broadcast, so anyone can add transactions naming it; none of them can redeem anything, because only the claim holder gets a token and a payment is spent once by its signature. So any transaction that pays is the payment. Successful rows are read oldest first (the claim's own payment is broadcast before anyone can know the reference), at most four per request. What does not pay may be someone else's, so the search never ends in a 400: nothing listed is 202 `not_found`; something not yet final is 202 `pending`; an odd answer from the node or rows left unread is 503; a paying transaction already spent, with nothing else to read, is 409 `reused` (or `refunded`); otherwise nothing pays and it is 202 `not_found`, and the page's give-up clock decides. A search that started from a cursor skipped the newer rows, so it never answers `not_found`: it answers 503, and the page keeps the claim.
4. `lib/assess.js` reads the recorded token balances. Over every token account the payee owned before and owns after, the payee's USDC (classic token program only) must have risen by exactly 1,000,000 base units. Integers throughout (`BigInt`). The transaction must have succeeded, be the one asked for, and name the reference.
5. Only then the ledger: `spent/<signature>` present means 409 `reused`, or 409 `refunded` when the record says `refunded: true`.
6. Otherwise 200 with an unlock token. Verify writes nothing.

A 400 is only ever a verdict on the transaction the page pointed at, read at `finalized` and naming the claim's reference: the claim's own. The page gives the attempt up on it. Anything short of that is a 202 or a 503 and decides nothing: the page keeps the claim and asks again.

### The unlock token

`lib/token.js`. `base64url(JSON {v: 2, sig, exp, jti}) . base64url(HMAC-SHA256(UNLOCK_SECRET))`. Ten minutes. At most 512 characters. The MAC is compared with `timingSafeEqual` before the payload is parsed. `jti` is 12 random bytes, so two tokens for one payment always differ. `UNLOCK_SECRET` shorter than 16 characters counts as unset, and verify and consume answer 500.

### consume

`lib/verify.js`, `consumeUnlock`. A fresh spend needs an authentic, unexpired token. One conditional write, `setJSON("spent/<signature>", {at, jti}, {onlyIfNew: true})` (`@netlify/blobs` 11, `If-None-Match: *`), is the whole decision, as long as the store makes it atomically:

- Hosted Netlify Blobs: Netlify's documentation (<https://docs.netlify.com/build/data-and-storage/netlify-blobs/>, checked 2026-11-16) presents `onlyIfMatch` and `onlyIfNew` as the way "to do atomic, conditional writes", and the client documents that when "a concurrent write to the same key wins the race, the operation will return with `modified: false`". The "last write wins" note in Netlify's troubleshooting section is about unconditional writes. The suite cannot reach the hosted store, so this is Netlify's guarantee, not something the tests prove.
- `web/test/ledger.test.js` sends 50 concurrent consumes for one payment through the real consume function and the real Blobs client to an atomic stand-in (`startAtomicBlobs`) and requires exactly one winner. A get-then-write store, or a write without `onlyIfNew`, fails it. A contract test checks that the store is opened with `consistency: "strong"` and that only `modified: true` counts as a win.
- Netlify's local `BlobsServer`, which `netlify dev` and `functions.test.js` use, is **not** atomic: it checks for the key and writes it across awaits, and concurrent spends against it can all succeed. It shows the protocol, never single-spend.

Reads are strongly consistent. The conditional write decides who wins, but the winning token's retry learns it won by reading the record back, and verify reports a spent payment by reading it; a read from an edge cache could miss a record that exists. `ledger.test.js` puts a cache in front of the store that keeps misses, and the winner's retry must still get 200. The first token to create the record wins; every other token for that transaction gets 409 `reused`. The token that won gets 200 every time it is presented again, even after it expires or `UNLOCK_SECRET` is rotated, so a page whose response was lost does not lose the grind. That repeat writes nothing. It is matched by the token's `jti` against the one the record kept, read from the payload without the MAC (`readUnlockClaims`): the jti is 96 random bits that only the winning browser and the ledger hold, and the answer grants nothing that was not already granted. Every other token needs a valid MAC. A record marked `refunded` answers 409 `refunded` to every token. An expired token whose payment is unspent gets 401 `expired`, and the page asks verify for a fresh one.

### The page's side

`web/src/pay-flow.js`:

- `pay`: a new claim, prepare, the check, the wallet. Only a wallet error that proves nothing was sent clears the claim: the customer declined, or the wallet is short of SOL or USDC (`classifyWalletError` in `shared/pay-copy.js`). A preflight refusal is not proof: a wallet that retries a send it already made is refused with "This transaction has already been processed", "Blockhash not found" or "Simulation failed" while the first send lands. Those, and every other wallet error, keep the claim and the page follows it through verify. Kept on purpose: when such a send did not land, the customer waits up to three minutes (the give-up clock) before paying again, and the status says why and counts down. A faster release from the blockhash's last valid height is not sound, because a wallet may sign on a newer blockhash than prepare's.
- `202 not_found` keeps polling until three minutes after the wallet sent (the blockhash has long expired by then), then gives up and clears the claim. While it waits without the wallet's signature, the status says why and counts down the time left.
- `202 pending` keeps polling for as long as it takes. `202 searching` saves the cursor and keeps polling.
- `503`, `429`, a proxy page or a dropped connection back off (up to 15 s) and keep the claim. A service that does not answer is never a reason to give a payment up.
- `400` and `409` end the attempt and clear the claim only with their reason in the body (`400` with a reason, `409 reused` or `refunded`); without it they are a proxy's answer and decide nothing. A `400` (except `failed`, where the transfer itself failed and nothing moved) leaves a refund note.
- After ten minutes neither confirmed nor ruled out, the page offers to give the attempt up, with a warning and then the reference (and signature, if known) to quote for a refund. Once verify has paid a claim (a token is saved), `not_found` never gives it up on its own and the offer stays.
- A given-up or refused payment leaves a refund note in `vg-pay-refunds`: reference, signature if known, why, when. Never the claim, which would let anyone redeem the payment. The page shows each note, the IDs as their own `code.pay-id` elements that wrap on a phone and select whole, until the customer hides it.
- `unlock` runs one spend at a time per browser, under the `vg-pay-spend` Web Lock (where a browser has none, a lease in `localStorage`, `vg-pay-spend-lease`, two minutes, renewed before every request the spend sends and checked again when each answer arrives; a tab frozen past two minutes keeps the lease unless another tab took it meanwhile, and a tab that finds it lost the lease sends nothing more and does not act on an answer that arrives after (not even a 200: the tab that took over replays the saved token, gets the same 200, and runs the one grind). Every request is aborted after 20 seconds without an answer (`POST_TIMEOUT_MS`), so a live holder never outlasts its lease. Two tabs that write a lease at once both read it back after 50 ms, and only the last writer spends). It takes the claim the token was issued for and spends only if that claim is still the saved one; otherwise the payment was spent, given up or replaced elsewhere, and nothing is sent (`elsewhere`). It saves the token and its expiry with the claim before calling consume, and retries a lost response with the same token four times. A token saved by an earlier spend of the claim is replayed before a newer one; the token that won gets 200 every time. Every clear names its claim (`forget(claim)`), so a verdict on one payment never clears another tab's newer one. A reload always asks verify first; if verify says the payment was used and a token is saved, that token is replayed, and its 200 is the lost spend's answer. Closing the tab while a spend is on its way asks first (`web/src/unload.js`, `confirmUnload`).
- A reference saved by the version before claims (`vg-pay-ref`) cannot be redeemed. The page shows it with how to ask for a refund, until the customer hides it.

### Refunds

A payment nothing has used can be refunded. The operator runs `web/scripts/payments.mjs` on their own computer (DEPLOY.md, "Refund requests"); it is not a function and is never deployed. Its rule: where it cannot be sure it asks for a look by hand, and it never says "send" or "send nothing" on a guess. `check <signature>` reads the transaction at finalized and the ledger, and gives one verdict: `REFUNDABLE`, `USED`, `MARKED`, `REFUNDED`, `MAYBE_REFUNDED`, `NOT_A_PAYMENT`, `TOO_RECENT` (under 24 hours old) or `UNCLEAR`. Only a transfer that names a reference account counts as a payment (every page version adds one, read-only, to the transfer); a plain 1.00 USDC transfer to the same address, such as a tip, is `NOT_A_PAYMENT`. `mark-refunded <signature>` takes only a `REFUNDABLE` payment and writes `spent/<signature>` = `{refunded: true, at, payer}` with the same `onlyIfNew` write a spend uses, so a payment is either spent for a grind or refunded, never both. The operator then sends 1.00 USDC to the wallet that paid, as read from the transaction, never to one the person asking names (so nobody's identity needs proving), and records it: `mark-refunded <signature> --sent <transfer>` checks the transfer is a finalized move of exactly 1.00 USDC from the payee to that wallet, no other wallet's USDC moving, landed after the payment, and writes `refund-transfer/<transfer>` = `{payment}` (created once: one transfer answers one payment) and `refund-sent/<signature>` = `{transfer}`. Only that record makes `check` say `REFUNDED`, send nothing. Before it calls a payment `REFUNDABLE` the tool lists the history of the account that paid and of the wallet's USDC associated account from now back to the payment's slot (nothing older is read; each account once per run, with the RPC retried on timeouts, 429 and 5xx), and any USDC from the payee to that wallet that no record claims makes it `MAYBE_REFUNDED` (or, once marked, `MARKED` with those transfers listed): decided by hand. No clock and no listing window takes part. `old-payments --until <publish time>` lists from the chain every payment the version before claims took and never used, from `LAUNCH_AT` (2026-11-15T14:36:14Z, `63308b0`, the first commit with the payment functions; DEPLOY.md has the operator check Netlify's deploy list for anything older, since a CLI deploy can predate any commit) unless given `--since`. `old-sol-payments` lists SOL paid to the payee by someone else in a top-level SystemProgram transfer naming a reference; nothing the payee signed (a swap, an unstake) and no SOL that arrived any other way is listed. Exactly the launch shape (one transfer from the fee payer, one reference, ComputeBudget at most beside it, nothing else moved, 0.001 to 0.02 SOL) is `REFUNDABLE`; anything else listed is `UNCLASSIFIED`. Its `SENT_BACK` is the one exact pairing the chain allows: the wallet's only SOL payment, and exactly its lamports went back once, after it; any other SOL back to the wallet is `MAYBE_REFUNDED`. What went back is read over the whole history, whatever `--since`/`--until` list. The tool holds no key and moves no money. `web/test/payments-admin.test.js` covers it against the mock chain and Blobs.

### Limits and cost

- `prepare`: 12 requests a minute per visitor (`ip` + `domain`), two RPC calls (three the first time the payee's USDC account is missing).
- `verify`: 60 a minute per visitor, one to eight RPC calls (two in the usual case: the signature's status, then the transaction; at most the status, that transaction, two reference listings and four listed transactions).
- Both are Netlify code-based rate limit rules (`export const config`). The free plan allows two per project.
- Every POST must be `application/json` and at most 4 KB, so another site cannot make its visitors' browsers spend our RPC quota with a simple form or text post.
- RPC calls time out after 8 seconds. There are no automatic retries.

## Key generation

`web/src/grind-worker.js` and `cli/worker.js`:

- 32 bytes from `crypto.getRandomValues` are the ed25519 seed (the CLI gets them through `@noble/curves`' `randomSecretKey`, which reads the same source).
- The public key comes from `@noble/curves`. The address is its Base58.
- The secret key is shown as Base58 of the 64 bytes `seed ‖ public key`, the layout Phantom, Solflare, Backpack and `solana-keygen` import.

`web/test/keys.test.js` pins this with the RFC 8032 vectors, a known seed checked against OpenSSL and `@solana/web3.js`, and keys from the real worker imported with `Keypair.fromSecretKey`.

The key reaches the page only through `postMessage` from the worker. It is shown hidden; the user clicks to reveal it, and the terminal clears 60 seconds after the reveal. Closing the tab while a grind runs or while a key is held asks first (`confirmUnload`, tested on every combination). The terminal is marked `translate="no"`, so browser page translation does not send it to a translation service. Nothing is written to storage except the payment claim (with, once sent, its transaction signature, once a spend starts, its unlock token, and a search cursor), the refund notes (reference and signature, never a claim) and, in a browser without Web Locks, the spend lease; nothing else is read but the retired `vg-pay-ref`.

## Response headers

`web/src/headers.js` is the only definition. `vite build` writes `dist/_headers` from it (`web/vite.config.js`) and fails if a published page contains inline script or style, or if it cannot find exactly one grind worker.

- Page: `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'self'`.
- Worker (`/assets/grind-worker-*.js`): `default-src 'none'; frame-ancestors 'none'`. A dedicated worker loaded by URL is governed by its own response's policy (checked in Chromium).

`netlify.toml` and `web/netlify.toml` hold no headers. Netlify reads `web/netlify.toml` when the base directory is `web`; the two files are identical apart from `base`.

## Page and design system

Last verified: 2026-11-20 on branch `ui/2026-11-20`, against `017b289` plus the round-7 UI review fixes (UX-09 to UX-23 in `findings.md`).

The page is built on Quiet Technical 2.3.0, VanityGrinder's product settings (`data-product="vanity"`, `data-theme="dark"` only; accent orchid `#c19fd1`). `web/public/system.css`, `web/public/system.js` and `web/public/fonts/` (Geist and Geist Mono, with `OFL.txt`) are byte copies from the design repo; `web/test/ui.test.js` pins their SHA-256 and checks every font `system.css` names is present. Never edit them here: copy a new release over them and update the hashes. `web/src/style.css` holds only VanityGrinder's own `vg-*` classes (and `.pay-id`); `_design/tools/collide.mjs --product web/src/style.css` must report 0 shared class names, 0 redefined system properties, 0 bare element selectors.

- **Hero.** One headline, one line, the primary Start grinding (the nav repeats it with the same words) and the secondary Estimate a pattern. Both Start grinding links (`a[data-start]`) move focus to the pattern field. While a run holds the form (`setPhase`, every phase but setup) they read "Back to the run", unfilled, and lead to the job summary, so the phase's own action (Connect wallet, Stop) is the only filled button.
- **Generator.** The real tool on a whole plinth, in a window. Side panel: the setup form (pattern with Base58 hint and inline errors, position radios, Match case, worker threads, odds as you type, Start grinding); during a run it becomes a summary list, and the payment step appears under it. Main view: three readouts (attempts/s, attempts, found by now, probability), the preview or found address with the pattern underlined (`.match`, from `match-view.js`), and the console. Before a run the rate and the probability are a `.hatch` with words ("Not measured yet", "Not started"), never a zero, and with no valid pattern the address row says "Type a pattern to preview it." The run column is a size container: under 30rem (a phone, or the split window on a tablet) the readouts become label-then-figure rows. Worker threads and Matches show their error when the field is left and clear it while the value is fixed; leaving the field never removes it (that moved Start grinding under the click). Text a number input cannot parse (`validity.badInput`, e.g. "4e") is an error, never the default (`readCount`, `web/src/fields.js`).
- **Run figures.** The generator prints no time for the search, before or during a run. Before it, the console prints the odds ("About 1 in N per key"), a horizon in attempts ("50% chance: by ~N attempts", `attemptsForChance`) and the rate this device measured (`web/src/console-lines.js`); describeJob's warnings that rest on an assumed rate are left out there and beside the form (`consoleWarnings`). The third readout is `1 - (1 - 1/E)^n` over attempts since the last match (`foundByNowProbability`, `formatProbability` in `shared/grind-math.js`), rounded down, bounded to `<0.1%` and `>99.9%`. Only the estimator shows a "Rough time", labelled as planning at an assumed speed. Stop draws the final count once more, so the readouts, the progress line and "Checked N keys" agree; a progress report that arrives after Stop is dropped.
- **Console.** `role="log"`, `aria-live="off"`; `#live-status` is the console's only voice. The payment step speaks through its own `#pay-status` (`role="status"`), which `pay.js` clears once the payment is spent on a grind, so no "unlocked" line comes back after the run. The estimator's result is not live: one short sentence goes to `#est-live` 700 ms after the input settles. When a match prints, the console pins the MATCH FOUND box (or "Match N of M") to its top, so the warnings after it never push the key line out of a phone's 20rem console. The private key line stays a console line ("Private Key: hidden. Click here to reveal it."); a click reveals it and announces "Key shown." only, a second click copies with a toast that never contains the key. Copy failures are console lines, not toasts. Fixed height, so arriving lines never move the page; long lines wrap under their text.
- **404.** `web/public/404.html` on the same system; no product stylesheet.
- **Brand assets.** `web/public/og.png` (1200 by 630, light theme, Geist) is the generator itself: the window, the readouts and a sample found address with `CAFE` underlined, labelled Sample, beside the headline and the page's own lede; its `og:image:alt` says so. It was rendered from the system's own components in Chromium, not drawn by hand. There is no favicon yet: both pages declare `<link rel="icon" href="data:," />` (no emoji, no request for a missing `/favicon.ico`) until Alex approves a mark (see Open and owner decisions in `findings.md`).

## Running the gate

Node.js 22.12 or newer for `web/` (`@netlify/blobs` 11), 20.19 or newer for `cli/`.

```bash
cd web && npm ci && npm test && npm run build
cd ../cli && npm ci && npm test
```

`web` tests use a mock chain (`web/test/helpers/chain.js`), a mock JSON-RPC node, Netlify's own local Blobs server (protocol only: it is not atomic) and an atomic Blobs stand-in (`web/test/helpers/servers.js`). `pay-page.test.js` drives `pay.js` with a stand-in document and wallet. They make no network call. `build.test.js` runs `vite build` itself and checks the output. Every test has a 60 second limit (`--test-timeout`), so a hang fails instead of stalling. Locally the gate has been run on Node 24 only. `.github/workflows/test.yml` runs it on Node 22 (what Netlify builds on) for every push and pull request, with `permissions: contents: read`, actions pinned by commit SHA and no secrets; until that workflow has run on GitHub, Node 22 is unverified.
