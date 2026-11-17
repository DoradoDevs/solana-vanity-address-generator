# Findings register: 2026-11-16 audit

Branch `audit/2026-11-16`, base `34623f1` (production). Every fix has a regression test that was seen failing without it; the audit reports name the scratch logs that hold those runs. Status words: FIXED, OPEN (known, not fixed), NEEDS-ALEX (a decision for the owner), REFUTED (checked and not a problem).

Commits: `07131e5` payment, header and key fixes · `14b5aca` CLI tests and pool sizing · `28039ff` knowledge base · `edb18ad` payee pin and pre-sign check · `824ed25` kb stamp · `e4ea97a` fixes from the two independent reviews · `6a4bd47` kb stamp.

## Audit findings (VG)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| VG-01 | High | The payment reference was a bearer credential: anyone reading the chain could verify and consume a customer's grind first. | FIXED | 07131e5 | verify.test "knowing a payment's reference, or any account in it, redeems nothing"; "someone else's payment cannot be reached with one's own claim"; functions.test "a stranger who reads the payment off the chain cannot verify it" |
| VG-02 | Med | One payment unlocked many grinds: keyed by the caller's reference, signature never deduplicated, and any account in the transaction worked as a reference. | FIXED | 07131e5 | verify.test "one payment naming three references unlocks one grind, not three" |
| VG-03 | Med | Consume was read-then-write: parallel consumes all won, and a late verify flipped a spent record back to paid. | FIXED | 07131e5, e4ea97a | verify.test "fifty different tokens for one payment, spent at once: exactly one wins"; ledger.test "fifty different tokens for one payment, spent at once through Blobs: exactly one wins" (real client, atomic stand-in; the get-then-write mutant fails it) |
| VG-04 | High | A customer who had just paid was told "No payment was found": lookup used the finalized default, the page stopped on that 404, and paying again overwrote the first reference. | FIXED | 07131e5 | pay-flow.test "a payment that is not visible yet is waited for…"; "a second payment cannot be started while one is unresolved"; verify.test not_found/pending tests; rpc.test commitment test |
| VG-05 | Med | A cheap later transaction naming the reference hid the payment for good. | FIXED | 07131e5 | verify.test "a junk transaction that names the reference afterwards cannot hide the payment" |
| VG-06 | Med | 1,000 junk transactions naming a paid reference, or an RPC answer of the wrong shape, gave a permanent 400 and the page deleted the paid claim. | FIXED | 07131e5, e4ea97a | verify.test "a full page of signatures hides the oldest…"; "a full page that still shows the payment is no reason to stall…"; "the transaction the page sent is judged on its own…"; "a node that serves the wrong transaction…" |
| VG-07 | Low | Missing `preTokenBalances` made a transaction that moved nothing read as a payment. | FIXED | 07131e5 | verify.test "token balances that are missing or malformed never read as a payment" |
| VG-08 | Low | A failed transaction showed "pending" for 2 minutes, then told the user to "connect again", which started a new payment. | FIXED | 07131e5 | verify.test "the page's own transaction that failed on chain is not a payment"; "a failed first attempt does not block…" |
| VG-09 | Med | The CSP backing "keys never leave" allowed every `*.netlify.app` site and localhost; the worker had no policy of its own. | FIXED | 07131e5 | privacy.test connect-src and worker-policy tests; build.test worker rule |
| VG-10 | Med | prepare and verify were unauthenticated, unthrottled RPC fan-out; cross-site `text/plain` posts ran them; web3.js retried on 429; no timeout. | FIXED (code) | 07131e5 | functions.test rate-limit config, "prepare rejects malformed requests…", "…posts that are not JSON…"; rpc.test timeout. The 429s themselves are checked only on a live deploy (DEPLOY.md). |
| VG-11 | Low | The key was wiped 60 s after a match even when unattended; closing the tab lost it without warning. | FIXED | 07131e5 | Chromium harness only (main.js has no DOM test) |
| VG-12 | Low | The CSP allowlisted hashes of an unreviewed host-injected script; headers were hand-kept in 3 places with no drift check; the 404 page's inline style was blocked. | FIXED | 07131e5 | privacy.test "headers live in one place…", "no inline code…"; build.test "the build stops if a page gains inline code…" |
| VG-13 | Low | The estimator treated "J" as a common first character, and the "sol" example cannot exist in Base58. | FIXED | 07131e5 | grind.test "first-character odds are the real distribution, J included"; copy.test "every example pattern…" |
| VG-14 | Low | Without Blobs configured, the ledger silently fell back to memory. | FIXED | 07131e5 | functions.test "with no ledger there is no unlock…" |
| VG-15 | Low | The tip button copied a different address from the one shown. | FIXED | 07131e5, e4ea97a | Chromium harness; pay-page.test "the tip address is the bundle's own…" (the server can no longer replace it) |
| VG-16 | Info | The test suite failed on Windows and needed the CLI's dependencies. | FIXED | 07131e5, 14b5aca | build.test runs vite via `process.execPath`; cli/test/cli.test.js |
| VG-17 | Low | A lost consume response was later reported "already used": a retry after expiry, or more than 60 s later, was refused. | FIXED | 07131e5, e4ea97a | verify.test "the token that spent a payment gets the same answer whenever it asks again, even after it expires"; ledger.test "the winning token's retry is answered from the store itself…"; pay-flow.test "the token is saved with the claim before consume is called…" |
| VG-18 | Low | The key sat in a translatable page, so browser translation would send it to a translation service. | FIXED | 07131e5 | privacy.test "the terminal is marked never to be machine-translated" |
| VG-19 | Low | The browser signed whatever prepare returned, and the payee came from a server env var. | FIXED | edb18ad, e4ea97a | transfer-check.test (every rule pinned by exact reason, each fails when that rule alone is removed); functions.test "a PAY_TO_ADDRESS other than the pinned payee closes quote, prepare and verify"; pay-flow.test "only the transfer prepare built for this claim reaches the wallet…", "a transfer that is not exactly the expected one is never handed to the wallet…", "when the page's check cannot run, nothing is signed"; pay-page.test "a transfer the page's check refuses is never shown to the wallet…" |
| VG-20 | Low | The Blobs store is site-wide, so deploy previews can write to it. | NEEDS-ALEX (partly fixed) | 07131e5 | Nothing in the store can grant a grind any more. A hostile fork-PR preview could still mark payments spent: turn off or gate fork deploy previews (DEPLOY.md step 7). |
| VG-21 | Info | The paywall is enforced only in the browser. | NEEDS-ALEX (by design) | — | Documented in README and DEPLOY. |
| VG-22 | Info | npm audit: bigint-buffer (high), stream-json and uuid (moderate), all under server-only web3.js and spl-token. | OPEN | — | Not reachable with caller input. Present at base. |
| VG-23 | Low | Another tab can give up a claim while this tab's wallet prompt is open; a late send then shows no status. | OPEN | — | The signature is never attached to the wrong claim (pay-flow.test "a wallet that answers after another tab replaced the attempt leaves the new attempt alone"). Needs a wallet that sends more than 180 s after prepare; not reproduced. |
| VG-24 | Low | The reference was saved only after the wallet returned. | FIXED | 07131e5 | pay-flow.test "a claim is 32 random bytes… saved before anything is sent" |
| VG-25 | Low | A `?ref=` link silently replaced a saved, paid but unspent reference. | FIXED | 07131e5 | Removed; functions.test refuses a legacy `{reference}` body |
| VG-26 | Low | An `UNLOCK_SECRET` of any length was accepted. | FIXED | 07131e5 | functions.test "an unset or short UNLOCK_SECRET closes verify and consume…" |
| VG-27 | Info | `PAY_TO_ADDRESS` in `netlify.toml` never reached the functions; DEPLOY.md called the repo private. | FIXED | 07131e5, e4ea97a | copy.test "what the page says… matches what the code does"; toml comments reworded (B-R2) |
| R-1 | — | The RPC URL (with its API key) reaches a response, error or log. | REFUTED | — | rpc.test "no failure message ever contains the endpoint…"; functions.test RPC-failure tests |
| R-2 | — | Unlock tokens can be forged, altered or timed. | REFUTED | — | verify.test "consume refuses tokens that are expired, altered, foreign or malformed" |
| R-3 | — | A generated key can leave the tab. | REFUTED | — | build.test worker has no send/store/load; page talks only to /api/; keys.test known-answer tests |
| R-4 | — | Secrets in the git history. | REFUTED | — | Full scan of every blob on every branch: clean |

## Independent review of 07131e5..28039ff (A)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| A-R1 / A-R11 | Low | Single-spend under concurrency was tested only against an in-memory store; Netlify's local Blobs server double-spends; hosted atomicity was uncited. | FIXED | e4ea97a | ledger.test "fifty different tokens… through Blobs: exactly one wins" (the reviewer's get/sleep/set mutant and a no-`onlyIfNew` mutant both fail it); ledger.test "blobStore opens the ledger strongly consistent and writes only if the key is new" (contract, via an injection seam). kb cites Netlify's docs and says the local BlobsServer and `netlify dev` are not atomic; store.js comment corrected. Hosted atomicity remains Netlify's documented guarantee, not proven by the suite. |
| A-R2 / A-R10 / A-R19 | Low | kb/findings.md was linked but missing. | FIXED | this file | — |
| A-R3 | Low | A payment with no saved signature could be stalled for good by flooding its reference, locking that browser out of paying. | FIXED | e4ea97a | verify.test "a full page that still shows the payment is no reason to stall…", "a successful transaction that pays nothing, landed ahead of the payment, does not hide it", "no more than four listed transactions are read per check…"; pay-flow.test "after ten minutes unresolved the customer may give the attempt up…" (abandon, with warning and refund reference) |
| A-R4 | Low | A spend whose answer was lost could not be recovered after a reload (token held only in memory). | FIXED | e4ea97a | pay-flow.test "the token is saved with the claim before consume is called…", "a saved token is replayed before a newer one…"; pay-page.test "the token is saved before consume, the tab asks before closing mid-spend, and a reload replays it" |
| A-R5 | Low | verify could return a final 400 judged on a third party's transaction found by reference. | FIXED | e4ea97a | verify.test "the reference listing never gives a verdict: only the page's own transaction, read final, can be refused" |
| A-R6 | Low | Paid-but-unspent payments from production became unredeemable; the page deleted `vg-pay-ref` silently and DEPLOY said the old records could be deleted. | FIXED | e4ea97a | pay-flow.test "a reference saved by the page before claims is kept…"; pay-page.test "a reference saved by the page before claims is shown with how to get a refund…". DEPLOY: pre-deploy step lists `status: "paid"` records to refund or honour; records kept. Whether any such customers exist needs the production store: NEEDS-ALEX. |
| A-R7 | Low | An unrecognised wallet error locked the customer out for 3 minutes with a status that said "a few seconds". | FIXED | e4ea97a | funds.test "wallet errors map…" (Blockhash not found and simulation failures are `not_sent`; confirmation timeouts are not); pay-flow.test "while a payment is unseen the page is told how long until it is given up, and why it is waiting"; pay-page.test "while nothing is seen, the status counts down to when paying again is allowed, and says why it waits" |
| A-R8 | Low | The deploy check's test payment failed as "wrong amount" if made from the payee wallet. | FIXED | e4ea97a | functions.test "the payee cannot pay itself: prepare says to use another wallet, before any RPC call" |
| A-R9 | Low | A DEPLOY check step described behaviour the code does not have. | FIXED | e4ea97a | Docs only |
| A-R12 | Low | The strong-consistency assertion was deleted without replacement. | FIXED | e4ea97a | ledger.test contract test, and "the winning token's retry is answered from the store itself, not from a cached miss" (an edge cache that keeps misses; dropping `consistency: "strong"` fails both) |
| A-R13 | Low | pay.js's claim-retention decisions had no behavioural test. | FIXED | e4ea97a | The decisions moved into pay-flow's `pay` and `unlock` (pay-flow.test "a wallet error nobody recognises keeps the claim…", "a wallet that answers after another tab replaced the attempt…", "a saved token is replayed…"); pay-page.test drives pay.js itself |
| A-R14 | Low | 400/409 without a reason were untested in check() and spend(). | FIXED | e4ea97a | pay-flow.test "a 400 or 409 without its reason, from a proxy or the edge, keeps the claim in check, watch and spend" |
| A-R15 | Low | A funds assertion was weakened (rent always charged went undetected). | FIXED | e4ea97a | funds.test restores `rentLamports: rent` for existing payee accounts |
| A-R16 | Info | No typecheck or lint step. | OPEN | — | No tsconfig/eslint in the repo; suggestion only |
| A-R17 | Info | 8 npm audit advisories (present at base). | OPEN | — | Same as VG-22 |
| A-R18 | Info | Test servers bind ephemeral loopback ports; gate run on Node 24 only. | OPEN | — | Same as B-R17 |

## Independent review of edb18ad..824ed25 (B)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| B-R1 | Med | The CreateIdempotent check was load-bearing but no test failed when it was removed. | FIXED | e4ea97a | transfer-check.test "the first instruction must be exactly the payee's CreateIdempotent, even over only the expected accounts" (7 pinned-key-only cases, exact reason) |
| B-R2 / B-R6 / B-R7 / B-R14 | Low | Both netlify.toml comments described the removed DEFAULT_PAY_TO override. | FIXED | e4ea97a | Comments reworded, identical apart from `base` (privacy.test) |
| B-R3 / B-R4 | Low | The page showed and copied a tip address taken from `/api/quote`. | FIXED | e4ea97a | pay-page.test "the tip address is the bundle's own…"; privacy.test: pay.js has one fetch and never names the tip address or `payTo` |
| B-R5 | Low | The docs claimed a changed environment could not redirect payments; a build-scoped NODE_OPTIONS still can. | FIXED | e4ea97a | Docs: claim narrowed; DEPLOY pre-deploy step and checklist items for build variables and the bundle's address |
| B-R8 | Low | No pre-deploy step to check an existing PAY_TO_ADDRESS. | FIXED | e4ea97a | Docs: DEPLOY "Before publishing this version" step 1 |
| B-R9 | Low | After a payee change, open tabs refused every payment with copy that blamed the server. | FIXED | e4ea97a | pay-page.test "a transfer the page's check refuses is never shown to the wallet, and the visitor is told to reload" |
| B-R10 / B-R18 | Low | kb/findings.md missing. | FIXED | this file | — |
| B-R11 | Low | The pre-sign check could be unwired from pay.js with every test green. | FIXED | e4ea97a | pay-flow.test "only the transfer prepare built…", "a transfer that is not exactly the expected one is never handed to the wallet…", "when the page's check cannot run, nothing is signed"; pay-page.test refusal test (removing the check, or letting a throwing check pass, fails them) |
| B-R12 | Low | No test failed without the instruction-count check. | FIXED | e4ea97a | transfer-check.test "a third instruction over only the expected accounts is refused by the instruction count" |
| B-R13 | Low | Seven checks could each be deleted with the suite green. | FIXED | e4ea97a | transfer-check.test: every negative assertion is the exact reason; one minimal case per rule. Not isolable: the fee-payer check (unreachable once the signer check passes) and the header's `required > keyCount` clause (always also trips the readonly bound). |
| B-R15 | Info | The kb said the curve test matches web3.js's isOnCurve; it follows the runtime (zip215) on edge encodings. | FIXED | e4ea97a | transfer-check.test "on edge encodings the curve test follows the runtime's decompress (noble zip215), not web3.js"; kb reworded |
| B-R16 | Info | The decoder accepted non-canonical compact-u16 lengths. | FIXED | e4ea97a | transfer-check.test "a length the runtime would not read is unreadable, in every length field"; "canonical two- and three-byte lengths still read, up to u16" |
| B-R17 | Info | The gate ran on Node 24, not the Node 22 production uses. | OPEN | — | Node 22 is not installed here, and fetching it needs the owner's go-ahead. Run the gate on Node 22 before deploying. |
| B-R19 | Info | 8 npm audit advisories. | OPEN | — | Same as VG-22 |

## Sweep cross-check

| Sweep | Finding | Status |
|---|---|---|
| S1, S6 | VG-01 (S6 also VG-05) | Fixed |
| S2, S12 | VG-02, VG-03 | Fixed |
| S3 | VG-05, VG-06 | Fixed |
| S4, S7 | VG-04 | Fixed |
| S5, S19 | VG-10 | Fixed (code) |
| S8 | VG-03 | Fixed |
| S9 | VG-20 | Partly fixed; NEEDS-ALEX |
| S10, S14 | VG-09 | Fixed |
| S11 | VG-19 | Fixed (edb18ad, hardened in e4ea97a) |
| S13, S20 | VG-21 | NEEDS-ALEX (by design) |
| S15 | VG-12 | Fixed |
| S16 | VG-24 | Fixed |
| S17 | VG-25 | Fixed |
| S18 | VG-18 | Fixed |
| S21, S22 | VG-22 | Open |

## Open and owner decisions

- VG-20: turn off or gate deploy previews for fork pull requests.
- A-R6: before publishing, list the old `status: "paid"` records in `grind-payments` and refund or honour each one (DEPLOY.md, "Before publishing this version").
- Refund channel: the page tells customers to open an issue on the GitHub repository; confirm that is the support channel you want.
- B-R17: run the gate on Node 22 before deploying.
- VG-22: `npm audit fix` for the web3.js transitive dependencies; consider replacing spl-token to drop bigint-buffer.
- VG-23: two tabs racing on one claim, unresolved.
