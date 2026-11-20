# Findings register: 2026-11-16 audit

Branch `audit/2026-11-16`, base `34623f1` (production). Every fix has a regression test that was seen failing without it; the audit reports name the scratch logs that hold those runs. Status words: FIXED, OPEN (known, not fixed), NEEDS-ALEX (a decision for the owner), REFUTED (checked and not a problem).

Commits: `07131e5` payment, header and key fixes · `14b5aca` CLI tests and pool sizing · `28039ff` knowledge base · `edb18ad` payee pin and pre-sign check · `824ed25` kb stamp · `e4ea97a` fixes from the two independent reviews · `6a4bd47` kb stamp · `07445aa` this register · `9d8eba3` CI · `9273afb` spl-token removed, npm audit cleared · `a013fa9` round-4 review fixes · `1132cfd` kb stamp · `4deedde` round-5 review fixes · `517432d` register · `31a7a1b` round-6 refund-tool fixes · register and kb stamp in the commit after it.

## Audit findings (VG)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| VG-01 | High | The payment reference was a bearer credential: anyone reading the chain could verify and consume a customer's grind first. | FIXED | 07131e5 | verify.test "knowing a payment's reference, or any account in it, redeems nothing"; "someone else's payment cannot be reached with one's own claim"; functions.test "a stranger who reads the payment off the chain cannot verify it" |
| VG-02 | Med | One payment unlocked many grinds: keyed by the caller's reference, signature never deduplicated, and any account in the transaction worked as a reference. | FIXED | 07131e5 | verify.test "one payment naming three references unlocks one grind, not three" |
| VG-03 | Med | Consume was read-then-write: parallel consumes all won, and a late verify flipped a spent record back to paid. | FIXED | 07131e5, e4ea97a | verify.test "fifty different tokens for one payment, spent at once: exactly one wins"; ledger.test "…through Blobs: exactly one wins" |
| VG-04 | High | A customer who had just paid was told "No payment was found": lookup used the finalized default, the page stopped on that 404, and paying again overwrote the first reference. | FIXED | 07131e5 | pay-flow.test "a payment that is not visible yet is waited for…"; "a second payment cannot be started while one is unresolved"; verify.test not_found/pending tests; rpc.test commitment test |
| VG-05 | Med | A cheap later transaction naming the reference hid the payment for good. | FIXED | 07131e5 | verify.test "a junk transaction that names the reference afterwards cannot hide the payment" |
| VG-06 | Med | 1,000 junk transactions naming a paid reference, or an RPC answer of the wrong shape, gave a permanent 400 and the page deleted the paid claim. | FIXED | 07131e5, e4ea97a, a013fa9 | verify.test "a full page of transactions after the payment cannot hide it: the search walks back to the oldest end"; "the transaction the page sent is judged on its own…"; "a node that serves the wrong transaction…" |
| VG-07 | Low | Missing `preTokenBalances` made a transaction that moved nothing read as a payment. | FIXED | 07131e5 | verify.test "token balances that are missing or malformed never read as a payment" |
| VG-08 | Low | A failed transaction showed "pending" for 2 minutes, then told the user to "connect again", which started a new payment. | FIXED | 07131e5 | verify.test failed-transaction tests |
| VG-09 | Med | The CSP backing "keys never leave" allowed every `*.netlify.app` site and localhost; the worker had no policy of its own. | FIXED | 07131e5 | privacy.test; build.test worker rule |
| VG-10 | Med | prepare and verify were unthrottled RPC fan-out; cross-site `text/plain` posts ran them; web3.js retried on 429; no timeout. | FIXED (code) | 07131e5 | functions.test rate-limit and content-type tests; rpc.test timeout. The 429s are checked only on a live deploy. |
| VG-11 | Low | The key was wiped 60 s after a match even when unattended; closing the tab lost it without warning. | FIXED | 07131e5 | Chromium harness only |
| VG-12 | Low | The CSP allowlisted hashes of an injected script; headers were kept in 3 places; the 404 page's inline style was blocked. | FIXED | 07131e5 | privacy.test; build.test |
| VG-13 | Low | The estimator treated "J" as a common first character, and the "sol" example cannot exist in Base58. | FIXED | 07131e5 | grind.test; copy.test |
| VG-14 | Low | Without Blobs configured, the ledger silently fell back to memory. | FIXED | 07131e5 | functions.test "with no ledger there is no unlock…" |
| VG-15 | Low | The tip button copied a different address from the one shown. | FIXED | 07131e5, e4ea97a | pay-page.test "the tip address is the bundle's own…" |
| VG-16 | Info | The test suite failed on Windows and needed the CLI's dependencies. | FIXED | 07131e5, 14b5aca | build.test; cli/test/cli.test.js |
| VG-17 | Low | A lost consume response was later reported "already used". | FIXED | 07131e5, e4ea97a, a013fa9 | verify.test "the token that spent a payment gets the same answer whenever it asks again, even after it expires"; "the token that won is answered 'ok' again after UNLOCK_SECRET is rotated; no other token is"; ledger.test retry test; pay-flow.test "the token is saved with its claim before consume is called, and a reload replays it after asking verify" |
| VG-18 | Low | The key sat in a translatable page, so browser translation would send it to a translation service. | FIXED | 07131e5 | privacy.test "the terminal is marked never to be machine-translated" |
| VG-19 | Low | The browser signed whatever prepare returned, and the payee came from a server env var. | FIXED | edb18ad, e4ea97a | transfer-check.test; functions.test PAY_TO_ADDRESS test; pay-flow.test and pay-page.test pre-sign tests |
| VG-20 | Low | The Blobs store is site-wide, so deploy previews can write to it. | NEEDS-ALEX (partly fixed) | 07131e5 | Nothing in the store can grant a grind. A hostile fork-PR preview could still mark payments spent or refunded: gate fork previews (DEPLOY step 7). |
| VG-21 | Info | The paywall is enforced only in the browser. | NEEDS-ALEX (by design) | — | Documented |
| VG-22 | Info | npm audit: bigint-buffer, stream-json and uuid under web3.js and spl-token. | FIXED | 9273afb | spl-token removed (lib/tx.js held to recorded spl-token 0.4.15 answers by spl-token-vectors.test; 50k random transactions identical); overrides jayson 5.0.0 and uuid 11.1.1; audit 8 → 0. jayson 5 is outside web3.js's ^4.3.0: NEEDS-ALEX to accept. |
| VG-23 | Low | Another tab can give up a claim while this tab's wallet prompt is open; a late send then shows no status. | OPEN (narrowed) | a013fa9 | The signature is never attached to the wrong claim, and a token is never spent or saved for another claim (pay-flow.test "a token is only ever spent for the claim it was issued for…", "a fresh token fetched while another tab replaced the attempt is never saved onto the new attempt"). A given-up payment leaves a refund note. The status gap itself is not reproduced. |
| VG-24 | Low | The reference was saved only after the wallet returned. | FIXED | 07131e5 | pay-flow.test "a claim is 32 random bytes… saved before anything is sent" |
| VG-25 | Low | A `?ref=` link silently replaced a saved reference. | FIXED | 07131e5 | functions.test refuses a legacy `{reference}` body |
| VG-26 | Low | An `UNLOCK_SECRET` of any length was accepted. | FIXED | 07131e5 | functions.test "an unset or short UNLOCK_SECRET closes verify and consume…" |
| VG-27 | Info | `PAY_TO_ADDRESS` in `netlify.toml` never reached the functions; DEPLOY.md called the repo private. | FIXED | 07131e5, e4ea97a | copy.test |
| R-1 | — | The RPC URL (with its API key) reaches a response, error or log. | REFUTED | — | rpc.test; functions.test; payments-admin.test "the command line never prints the token or the RPC URL…" |
| R-2 | — | Unlock tokens can be forged, altered or timed. | REFUTED | — | verify.test "consume refuses tokens that are expired, altered, foreign or malformed". The replay of the token that already won is matched by jti without the MAC, by design (C-R16); it grants nothing new. |
| R-3 | — | A generated key can leave the tab. | REFUTED | — | build.test; keys.test |
| R-4 | — | Secrets in the git history. | REFUTED | — | Full scan clean. The test-only fakes in payments-admin.test.js are not credentials. |

## Independent review of 07131e5..28039ff (A)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| A-R1 / A-R11 | Low | Single-spend was tested only in memory; Netlify's local Blobs server double-spends; hosted atomicity was uncited. | FIXED | e4ea97a | ledger.test atomic stand-in and contract tests. Hosted atomicity is Netlify's documented guarantee, not proven by the suite. |
| A-R2 / A-R10 / A-R19 | Low | kb/findings.md was linked but missing. | FIXED | 07445aa | — |
| A-R3 | Low | A payment with no saved signature could be stalled for good by flooding its reference. | FIXED (at the root) | e4ea97a, a013fa9, 4deedde | Paged, resumable cursor search: verify.test "a full page of transactions after the payment cannot hide it…", "a history longer than one call can list is resumed from the cursor…", "a search that started from a cursor never says 'not found'…"; pay-flow.test "a long reference history is followed with the cursor the server returns, across a reload". Residual: four or more successful junk transactions before the payment still give 503; the claim is kept and give-up is offered.; verify.test "a payment that lands exactly on a call's boundary is found: the cursor's own row is listed again" (D-R1) |
| A-R4 | Low | A spend whose answer was lost could not be recovered after a reload. | FIXED | e4ea97a, a013fa9 | pay-flow.test reload-replay tests; pay-page.test reload test |
| A-R5 | Low | verify could return a 400 judged on a third party's transaction. | FIXED | e4ea97a | verify.test "the reference listing never gives a verdict…" |
| A-R6 | Low | Unspent production payments became unredeemable. | FIXED | e4ea97a, a013fa9, 4deedde | Retired-reference tests; reconciliation after the switch, from the chain (`payments.mjs old-payments`, C-R10). Whether such customers exist needs the production store: NEEDS-ALEX. Tips are not payments; a refund counts only once recorded with `--sent`, and unrecorded money back to a wallet is for a look by hand; the launch versions' SOL payments are listed by `old-sol-payments`, exact launch shape only (D-R4, D-R5, D-R6, E-R1, E-R4). |
| A-R7 | Low | An unrecognised wallet error locked the customer out for 3 minutes. | FIXED (superseded) | e4ea97a, a013fa9 | The `not_sent` class it added was removed in a013fa9 (C-R1); countdown tests in pay-flow and pay-page |
| A-R8 | Low | The deploy check's test payment failed if made from the payee wallet. | FIXED | e4ea97a | functions.test "the payee cannot pay itself…" |
| A-R9 | Low | A DEPLOY check step described behaviour the code does not have. | FIXED | e4ea97a | Docs only |
| A-R12 | Low | The strong-consistency assertion was deleted without replacement. | FIXED | e4ea97a | ledger.test contract and cached-miss tests |
| A-R13 | Low | pay.js's claim-retention decisions had no behavioural test. | FIXED | e4ea97a | pay-flow and pay-page tests |
| A-R14 | Low | 400/409 without a reason were untested in check() and spend(). | FIXED | e4ea97a | pay-flow.test proxy-answer test |
| A-R15 | Low | A funds assertion was weakened. | FIXED | e4ea97a | funds.test |
| A-R16 | Info | No typecheck or lint step. | OPEN | — | Suggestion only |
| A-R17 | Info | 8 npm audit advisories. | FIXED | 9273afb | Same as VG-22 |
| A-R18 | Info | Test servers bind ephemeral ports; gate run on Node 24 only. | Ports accepted (C-R23); Node 22: CI added | 9d8eba3 | Same as B-R17 |

## Independent review of edb18ad..824ed25 (B)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| B-R1 | Med | The CreateIdempotent check was load-bearing but untested. | FIXED | e4ea97a | transfer-check.test |
| B-R2 / B-R6 / B-R7 / B-R14 | Low | Both netlify.toml comments described the removed override. | FIXED | e4ea97a | privacy.test |
| B-R3 / B-R4 | Low | The page showed and copied a tip address taken from `/api/quote`. | FIXED | e4ea97a | pay-page.test; privacy.test |
| B-R5 | Low | The docs overclaimed what the payee pin guarantees. | FIXED | e4ea97a | Docs |
| B-R8 | Low | No pre-deploy step to check an existing PAY_TO_ADDRESS. | FIXED | e4ea97a | DEPLOY step 1 |
| B-R9 | Low | After a payee change, open tabs refused every payment with copy that blamed the server. | FIXED | e4ea97a | pay-page.test |
| B-R10 / B-R18 | Low | kb/findings.md missing. | FIXED | 07445aa | — |
| B-R11 | Low | The pre-sign check could be unwired from pay.js with every test green. | FIXED | e4ea97a | pay-flow and pay-page pre-sign tests |
| B-R12 | Low | No test failed without the instruction-count check. | FIXED | e4ea97a | transfer-check.test |
| B-R13 | Low | Seven checks could each be deleted with the suite green. | FIXED | e4ea97a | transfer-check.test exact reasons |
| B-R15 | Info | The kb's wording about the curve test was wrong on edge encodings. | FIXED | e4ea97a | transfer-check.test |
| B-R16 | Info | The decoder accepted non-canonical compact-u16 lengths. | FIXED | e4ea97a | transfer-check.test |
| B-R17 | Info | The gate ran on Node 24, not the Node 22 production uses. | CI added; closes when it runs | 9d8eba3 | `.github/workflows/test.yml`: Node 22, actions pinned by SHA, `permissions: contents: read`, no secrets. Not run yet: nothing pushed. |
| B-R19 | Info | 8 npm audit advisories. | FIXED | 9273afb | Same as VG-22 |

## Independent review of 07445aa (C, round 3)

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| C-R1 / C-R4 / C-R5 / C-R9 | Med | "already been processed", "Simulation failed" and "Blockhash not found" were read as proof nothing was sent, clearing the claim of a payment that had landed. | FIXED | a013fa9 | funds.test "wallet errors map…"; pay-flow.test "a resend refused at preflight is no proof nothing was sent: the claim is kept and the payment is found" |
| C-R2 / C-R6 / C-R11 / C-R17 / C-R22 | Low | The saved token was not tied to its claim: two tabs could get two grinds from one payment, and a stale 409 could wipe a newer claim. | FIXED | a013fa9 | pay-flow.test "a token is only ever spent for the claim it was issued for (two tabs, a stale token, a newer payment)"; "one payment reaches one grind across tabs…"; "…a spend left unanswered is finished by one tab only"; "without Web Locks a lease in storage keeps spends apart…"; "a fresh token fetched while another tab replaced the attempt is never saved onto the new attempt"; pay-page.test "a second tab's grind does not spend a payment this tab already spent…". The lease fallback is renewed before every request and every request times out (D-R3/D-R8/D-R10). |
| C-R3 / C-R7 / C-R14 | Low | Refunds were promised with no procedure; a refunded payment could still be redeemed; anyone could ask. | FIXED (support channel NEEDS-ALEX) | a013fa9 | `web/scripts/payments.mjs` (operator-run, never deployed); verify and consume answer 409 refunded; refunds go only to the paying wallet, after 24 h. payments-admin.test.js (27 tests, 13 mutants); verify.test "a payment the operator refunded and marked spent is refused as refunded, by verify and by consume". DEPLOY "Refund requests". |
| C-R8 | Low | A-R3 not closed at the root. | FIXED | a013fa9 | See A-R3 |
| C-R10 | Low | DEPLOY step 3 could not list every unredeemed old payment, and ran before the switch. | FIXED | a013fa9 | DEPLOY "Unspent payments from the old version"; payments-admin.test old-payments tests |
| C-R12 | Low | A saved token skipped watch and the give-up offer. | FIXED | a013fa9 | pay-flow.test "a saved token never strands the browser…" |
| C-R13 | Low | A given-up payment's refund reference vanished on the next payment or a reload. | FIXED | a013fa9 | pay-flow.test "a given-up payment's reference is kept until the customer hides it…"; pay-page.test give-up test |
| C-R15 | Low | On phones the reference and signature overflowed. | FIXED | a013fa9 | pay-page.test "on a phone the reference and the transaction wrap and select whole…" |
| C-R16 | Low | Rotating UNLOCK_SECRET turned a lost-answer spend into "already used". | FIXED | a013fa9 | verify.test "the token that won is answered 'ok' again after UNLOCK_SECRET is rotated; no other token is" (jti match without the MAC, by design) |
| C-R18 | Low | The abandon UI had no test. | FIXED | a013fa9 | pay-page.test "give-up is offered only after ten minutes unresolved, asks twice, and leaves the reference and transaction to quote" (M1–M3 killed) |
| C-R19 | Low | The pointed path's final-but-not-served branch was untested. | FIXED | a013fa9 | verify.test "the page's own transaction, final but not served yet, is pending…" |
| C-R20 | Low | beforeunload during a spend was untested. | FIXED | a013fa9, 4deedde | The source-text test was replaced (D-R2/D-R9): pay-page.test "closing the tab asks first while a grind runs, a key is held, or a spend is on its way, and only then" |
| C-R21 | Low | A regression could hang the suite instead of failing it. | FIXED | a013fa9 | `--test-timeout=60000`; the fake sleep is capped |
| C-R23 | Info | Test servers bind ephemeral ports. | ACCEPTED | — | Loopback only |
| C-R24 | Info | Gate verified on Node 24 only. | CI added; closes when it runs | 9d8eba3 | Same as B-R17 |
| C-R25 | Info | npm audit: 8 advisories. | FIXED | 9273afb | Same as VG-22 |

## Independent review of 07445aa..43aef24 (D, round 4)

The reviewer reproduced the gate (web 216/216 twice, build, cli 4/4, audit 8 → 0), confirmed the hand-built instructions byte-identical to spl-token and transfer-check independent of the builder, found CI safe on the public repository, and found that the mark-refunded/consume race and the jti replay hold.

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| D-R1 | Med | The resume cursor named the oldest listed row, which the next call never listed, so a payment exactly on a call boundary (histories of 2,000 or 4,000 rows) was never found: 503 forever. | FIXED | 4deedde | verify.test "a payment that lands exactly on a call's boundary is found: the cursor's own row is listed again" (2,000 and 4,000 rows). The cursor is now the second-oldest listed row. Mutant (cursor = oldest row) killed. |
| D-R4 | Low | The refund tool counted any 1.00 USDC transfer to the payee (tips included) as a payment, and the runbook said to refund every one listed. | FIXED | 4deedde | payments-admin.test "a 1.00 USDC transfer that names no reference (a tip) is not a payment: check, mark-refunded and old-payments leave it alone"; "old-payments starts at the launch unless told otherwise" (`--since` defaults to 2026-11-15T14:37:02Z). DEPLOY: tips are not payments. Mutants (no reference check, sysvar as reference, since from 0) killed. |
| D-R5 | Low | Payments already refunded by hand were listed REFUNDABLE again. | FIXED, redone in 31a7a1b (E-R4) | 4deedde, 31a7a1b | The tool reads the paying wallet's USDC history since launch and pairs each 1.00 USDC transfer from the payee back to it with that wallet's oldest unanswered unused payment (a mark takes the refund it names, or the first after it): verdict SENT_BACK, mark-refunded records it and says send nothing. payments-admin.test "a payment already refunded by hand is SENT_BACK…"; "a refund sent after a payment was marked belongs to that payment; one sent before any mark answers the oldest unmarked one". Mutants killed. Limit: a refund sent somewhere other than the wallet's own USDC accounts is not seen (DEPLOY says to send only to the wallet). |
| D-R6 | Low | SOL payments taken by the launch versions were missing from the refund procedure. | FIXED, classification redone in 31a7a1b (E-R1) | 4deedde, 31a7a1b | `old-sol-payments` lists SOL payments to the payee that name a reference, since launch, with the paying wallet, the exact lamports, the old record, and USED / SENT_BACK / REFUNDABLE / UNCLEAR. payments-admin.test "old-sol-payments lists the launch versions' SOL payments nothing used…". DEPLOY "SOL payments from launch day". Mutants killed. |
| D-R3 / D-R8 / D-R10 | Low | Without Web Locks, the lease was never renewed and post() had no timeout, so a second tab could spend while the first still was; the settle step was untested. | FIXED | 4deedde | The lease is renewed before every request, a tab that lost it sends nothing more, and every request aborts after 20 s (`POST_TIMEOUT_MS`, a timer and AbortController, since browsers without Web Locks lack AbortSignal.timeout). pay-flow.test "…a spend that outlasts LEASE_MS renews its lease before each request…", "…a tab that lost its lease (frozen past LEASE_MS) sends nothing more", "…two tabs that both find no lease and write one at once: only the last writer spends"; pay-page.test "a request that gets no answer is aborted after its time limit…". Mutants (no renewal, no hold check, no settle re-read, no timeout) killed. |
| D-R2 / D-R9 | Low | The beforeunload test only read main.js's text; two behaviour-breaking mutants survived. | FIXED | 4deedde | The rule is `confirmUnload` in web/src/unload.js. pay-page.test "closing the tab asks first while a grind runs, a key is held, or a spend is on its way, and only then" checks all 8 combinations and pins main.js's handler to exactly one call. The reviewer's two mutants (`&&` → `||`, `if (true) return;`) and two more killed. |
| D-R11 | Low | consume's "no secret, no answers" guard was untested. | FIXED | 4deedde | verify.test "with no UNLOCK_SECRET consume answers nothing, not even the token that already won" ('', undefined, null; ledger unchanged). Removing the guard fails it. |
| D-R7 | Low | After "Blockhash not found" or "Simulation failed" a customer waits up to 3 minutes before paying again. | ACCEPTED, copy fixed | 4deedde | Kept on purpose: those errors also come from a retry of a send that landed. A release at the blockhash's last valid height is not sound because a wallet may sign on a newer blockhash. The status now says why it waits and counts down: pay-page.test "while nothing is seen, the status counts down…" (with "Blockhash not found"). |
| D-R12 | Info | Test servers bind ephemeral loopback ports. | ACCEPTED | — | Same as C-R23 |
| D-R13 | Info | Node 22 still unverified; CI not seen running. | CI added; closes when it runs | 9d8eba3 | Same as B-R17 |

## Release-candidate review of 43aef24..517432d (E, round 5)

The reviewer reproduced the gate three times (227/227, build, cli 4/4, audit 0), confirmed the cursor fix, and confirmed that no past version's real payment can be classed as a tip. All findings were in the operator refund tool (`web/scripts/payments.mjs`) except R12, R14 and R16. Fixed in `31a7a1b` on the rule the coordinator set: the tool fails toward a look by hand, never toward "send money" or "send nothing". Before-fix runs: scratch `regression-r6-tool-before-fix.log` (21 of 43 tool tests fail on 517432d, among them the swap listed REFUNDABLE with the pool vault as payer, and hand transfers read "send nothing"), `regression-r6-client-before-fix.log` (2 fail). Mutation: `regression-r6-mutants.log` + `-rerun.log`, 46 mutants, all killed after the tests were tightened (6 survived the first run: the refund amount clauses each masked by the other, and three SOL shape checks masked by the extra-account check; now pinned by asymmetric fixtures and by the reason each case gives).

| ID | Sev | Finding | Status | Commit | Regression test |
|---|---|---|---|---|---|
| E-R1 / E-R2 | Med | `old-sol-payments` listed any SOL inflow since launch that named a read-only account (a swap or unstake the payee signed, a program paying from a vault) as REFUNDABLE, naming the account that lost the SOL (e.g. an AMM vault) as the wallet to send to. | FIXED | 31a7a1b | Only SOL someone else sent the payee in a top-level SystemProgram transfer naming a reference is listed; nothing the payee signed (`solPayment` returns null), nothing that arrived otherwise, no tips. Exactly the launch shape (one transfer from the signing fee payer, one reference, ComputeBudget at most, nothing else moved, 0.001–0.02 SOL) is REFUNDABLE; everything else listed is UNCLASSIFIED with the reason and "send nothing on this tool's word". payments-admin.test "old-sol-payments lists nothing the payee signed (a swap, an unstake)…", "SOL paid to the payee in anything but the launch shape is UNCLASSIFIED…" (10 shapes, each with its reason). |
| E-R4 / E-R6 / E-R8 | Low (Med by one reviewer) | SENT_BACK pairing compared the operator's clock with chain blockTime, so a refund could be credited to another payment whose customer was then told "send nothing". | FIXED | 31a7a1b | No pairing by time. "Send nothing" for USDC rests only on a record: `mark-refunded <sig> --sent <transfer>` checks the transfer (finalized, exactly 1.00 from the payee to the payer, no other USDC moving, after the payment) and claims it once (`refund-transfer/<transfer>`, `refund-sent/<sig>`). Unrecorded USDC of any amount from the payee to the wallet after the payment makes it MAYBE_REFUNDED (or MARKED once marked), for a look by hand. payments-admin.test "a refund recorded with --sent belongs to its payment whatever the clocks say…" (operator clock an hour fast), "--sent records only a finalized refund of exactly 1.00…", "any USDC the payee sent the wallet after its payment makes it MAYBE_REFUNDED…". |
| E-R7 | Low | Pairing read only the --since/--until window, so narrowing it moved one payment's refund onto another. | FIXED | 31a7a1b | USDC: each payment's look-back runs from the payment's slot to now, whatever the window. SOL: the whole history from the earlier of --since and LAUNCH_AT to now is read; the window filters the listing only. payments-admin.test "what went back is read from the whole history: --since and --until choose only what is listed". |
| E-R3 / E-R10 / E-R11 / E-R13 / E-R14 / E-R17 | Low | 13 of the reviewer's 25 mutants survived on money rules. | FIXED | 31a7a1b | Pinned: exact 1.00 on both sides (asymmetric fixtures), no third wallet, transfers before the payment, the payer's associated account scanned (fixture PAYER_ATA is not PAYER's real associated account, so the test now uses the real one), slot cut-off, exact lamports, consumed SOL payments, hold() after each answer, after verify and in the second spend (pay-flow.test, three new tests), the 20 s default timeout (pay-page.test "post() with no time limit given…"). chainRpc rows now carry their slot. 46 mutants, all killed. |
| E-R5 | Low | LAUNCH_AT rested on "a deploy follows its commit", which a Netlify CLI deploy of an uncommitted tree breaks. | FIXED (documented) | 31a7a1b | LAUNCH_AT is now 2026-11-15T14:36:14Z (`63308b0`, the first commit on any branch with the payment functions), and its doc says it is only as early as the repository can see. DEPLOY step 2 and the owner checklist have the operator check Netlify's deploy list for the oldest deploy serving `verify` and pass an earlier `--since` if needed. "old-payments starts at the first commit with the payment functions unless told otherwise". Whether any deploy predates it: NEEDS-ALEX. |
| E-R9 | Low | check and mark-refunded read the payer's whole USDC history since launch, one getTransaction per row, with no retry. | FIXED | 31a7a1b | The look-back lists each account once per run, only back to the payment's slot, and reads only those transactions once; `retrying` retries timeouts, dropped connections, 429 and 5xx (1, 2, 4 s) and nothing else. DEPLOY recommends an RPC key of its own. payments-admin.test "check reads the wallet's history back to the payment's slot and no further…" (1,500 older rows never read), "the RPC is retried after a timeout, a dropped connection, 429 or a 5xx, and after nothing else". |
| E-R12 / E-R16 | Low / Info | Without Web Locks, a tab frozen past its lease whose consume had reached the server still acted on the answer: two grinds from one payment. | FIXED | 31a7a1b | `spend` asks `hold()` when each answer arrives, and `unlock` after verify's answer: a tab whose lease was taken does not act on a late answer (the tab that took over replays the saved token and runs the one grind). pay-flow.test "…a tab frozen past its lease, whose consume reached the server, leaves the outcome to the tab that took over: one grind", "…a fresh token that verify returns after another tab took the lease is neither saved nor spent". A frozen tab whose lease nobody took keeps it (documented in kb/README). |
| E-R15 | Info | The hand-refund lookup reused the first payment's token account for all of a wallet's payments; a confirmed-but-not-final refund was skipped. | FIXED | 31a7a1b | Each payment scans its own paying account and the wallet's associated account; a transaction of the wallet after the payment that is not final, or unreadable, makes the payment UNCLEAR ("check again in a minute"). payments-admin.test "a transfer back is looked for in the account that paid and in the wallet's associated account, for each payment on its own", "a transaction of the wallet after the payment that is not final yet, or cannot be read, makes it UNCLEAR…". Limit, documented: USDC sent to a third token account of the wallet (neither the paying one nor the associated one) is not seen. |

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
| S11 | VG-19 | Fixed |
| S13, S20 | VG-21 | NEEDS-ALEX (by design) |
| S15 | VG-12 | Fixed |
| S16 | VG-24 | Fixed |
| S17 | VG-25 | Fixed |
| S18 | VG-18 | Fixed |
| S21, S22 | VG-22 | Fixed (9273afb) |

## Open and owner decisions

- VG-20: turn off or gate deploy previews for fork pull requests.
- E-R5: before the old lists, check Netlify's deploy list for any deploy serving `verify` before 2026-11-15T14:36:14Z; pass an earlier `--since` if there is one.
- A-R6 / C-R10 / D-R6 / E-R1: after publishing, run `old-payments --until <publish time>` (mark, send and record with `--sent` each REFUNDABLE one; decide each MAYBE_REFUNDED, MARKED and UNCLEAR one by hand) and `old-sol-payments` (send back each REFUNDABLE SOL payment; look at every UNCLASSIFIED and MAYBE_REFUNDED one by hand) (DEPLOY.md, "Unspent payments from the old version"). Keep the old records.
- Payee address: does anything other than VanityGrinder (another bot or service) receive USDC or SOL at `crimeKXXM…`? If it does, its payments can look like VanityGrinder payments to the refund tool; look at every listed one by hand.
- Refund channel: the page tells customers to open a GitHub issue; confirm that is the support channel you want.
- B-R17 / C-R24 / D-R13: push the branch so the CI workflow runs on Node 22.
- VG-22: accept the jayson 5.0.0 override (outside web3.js's declared ^4.3.0) or pin back.
- VG-23: the late-send status gap, unresolved (narrowed).
- A-R16: typecheck/lint, suggestion only.
