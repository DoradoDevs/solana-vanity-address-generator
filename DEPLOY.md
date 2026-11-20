# Deploy VanityGrinder on Netlify

VanityGrinder goes live on **Netlify** (free tier) from this public GitHub repository. The grind still runs in the browser. Netlify Functions quote the fixed 1.00 USDC price, build the unsigned transfer, and check that the payment landed. $1 in USDC per grind, paid from your wallet.

Do not deploy this site to Vercel. The payment check is a set of Netlify Functions, the ledger is Netlify Blobs, and the response headers are a Netlify `_headers` file.

Keys are generated on your device. The only network calls are the payment functions. The grind worker is served with a policy that lets it open no connection at all.

How the payment is verified, and why, is in [kb/README.md](kb/README.md). What the 2026-11-16 audit found is in [kb/findings.md](kb/findings.md).

## Environment variables

Set these in the Netlify UI: Site configuration → Environment variables. Scope them to Functions (or all scopes). Variables in `netlify.toml` are build-time only: functions never see them. Do not commit the secret or the RPC URL.

| Name | Required | Value |
|---|---|---|
| `PAY_TO_ADDRESS` | No | Leave unset. The address that receives the $1 is pinned in code, `PAY_TO` in `shared/payment.js`: `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`. If this variable is set, it must be exactly that address; any other value makes quote, prepare and verify answer 503, so this variable cannot redirect payments. That is all the pin guarantees: anyone who can change the build environment (for example `NODE_OPTIONS`, which runs code inside `npm run build`) or deploy code can still change where payments go. |
| `SOLANA_RPC_URL` | Yes | HTTPS Solana mainnet RPC, for example a Helius or Triton URL. Used only inside the functions. A URL with an API key stays server-side: it is never put in a response, an error, or a log line. |
| `UNLOCK_SECRET` | Yes | Random string of at least 16 characters. `openssl rand -base64 32`. Signs the unlock token. Unset or shorter than 16 characters, verify and consume answer 500 and no grind can be unlocked. Changing it voids tokens not yet spent (they last ten minutes); their payments are unaffected and simply verify again. A token that already won its spend is still answered "ok" after the change, because consume matches it to the ledger record by its id, so a customer whose spend answer was lost keeps their grind across a rotation. It can be rotated at any time. |

To change where payments go, change `PAY_TO` in `shared/payment.js` (and the tip address in `web/src/site.config.js`) and deploy. Tabs opened before that deploy still hold the old address, so they refuse every payment until reloaded (the page says to reload). Payments already sent to the old address and not yet redeemed cannot be redeemed afterwards: refund them. The page and the functions are built from the same constant: before the wallet is asked to sign, the page decodes the transaction prepare returned and refuses it unless it is exactly 1.00 USDC of the USDC mint from the connected wallet's USDC account to that address's USDC account, naming this attempt's reference, with nothing else in it but the payee account's idempotent creation. The tip address is not a secret.

The payee's USDC associated-token account is created inside the payment transaction if it does not exist yet. The connected wallet is the fee payer and covers that rent the first time. The price is exactly 1.00 USDC. There is no SOL payment and no price oracle.

## What the functions do

Each function has its own path under `/api/`. The default `/.netlify/functions/<name>` URLs do not exist.

| Path | Role |
|---|---|
| `GET /api/quote` | The fixed `1.00` USDC amount, the USDC mint, and the receive address. No RPC call. |
| `POST /api/prepare` | Body `{ payer, claim }`. Builds the unsigned transfer of exactly 1.00 USDC from the wallet's USDC account to the payee's, with an idempotent create-account instruction and a read-only reference account. The reference is the SHA-256 of the caller's claim. Two RPC requests: balances and a blockhash. Rate limited to 12 a minute per visitor. The page checks the result byte by byte before its wallet sees it (`web/src/transfer-check.js`). |
| `POST /api/verify` | Body `{ claim, signature }`, the signature being the one the wallet returned (optional). With it, verify reads that transaction directly and ignores anything else that names the reference. Without it, or when the node does not know that signature, verify searches the transactions naming the claim's reference for one that pays. It lists them newest first, up to two pages of 1000 per request, and reads the oldest first, at most four per request. A history longer than that is answered 202 "searching" with a `cursor` (a signature: the second-oldest row listed, so the oldest is listed again next time and none is skipped); the page sends it back as `cursor` in the next request, and keeps it across a reload, so the search carries on where it stopped and always reaches the oldest end. A search that started from a cursor never answers "not found". A payment the operator refunded (see "Refund requests") answers 409 "refunded". Requires finality, checks that the transaction names the reference, and checks from the recorded token balances that the payee ended up with exactly 1.00 USDC more. Returns an unlock token, valid ten minutes. A 400 is only ever a verdict on the transaction the page pointed at, read at finalized: the claim's own. The search by reference never ends in a 400, because what it finds may be someone else's; when nothing there pays it answers 202, and when the node's answer cannot be relied on, 503. Either way the page keeps the payment. Writes nothing. Rate limited to 60 a minute per visitor. |
| `POST /api/consume` | Body `{ token }`. Records the transaction as spent with one conditional write to Netlify Blobs (`onlyIfNew`, which Netlify documents as an atomic conditional write). The first token wins; every other token for that transaction is refused. The winning token gets the same answer if it is sent again, even after it expires or `UNLOCK_SECRET` changes, so a lost response does not cost the customer their grind: the record keeps the winning token's id, and only that id is answered "ok" again. A payment marked refunded is answered 409 "refunded" to every token. The terminal starts one grind only after this succeeds. |

All POST bodies must be `application/json`. Other content types are refused before any RPC or ledger work, so another site cannot spend the RPC quota through its visitors' browsers.

The ledger is the Blobs store `grind-payments`, one record per spent transaction under `spent/<signature>`. Records written before this version are keyed by reference at the top level. This version does not read them, but they are what shows which old payments were used: keep them (see "Unspent payments from the old version"). A refund is recorded under the same `spent/<signature>` key as `{ refunded: true, at, payer }`, so a refunded payment can never also be spent.

A modified copy of the JavaScript can still grind without paying, because the private key is never sent to the server and the grinding happens in the browser. The same is true of anyone who opens the developer console, or who runs the CLI in this repository. The $1 buys the hosted page; the server's guarantees are that each payment is spent once, by one token, and that only the browser that paid is ever given a token for it.

## Build locally

Node.js 22.12 or newer (`web/.node-version` pins 22).

```bash
cd web
npm ci
npm test
npm run build
cd ../cli
npm ci
npm test
```

`npm test` in `web/` covers payment verification against a mock chain (wrong amount, wrong mint, wrong owner, failed and unfinalized transactions, one payment naming many references, somebody else's payment, RPC failures), concurrent spends (in memory, and through the real Blobs client against an atomic stand-in for hosted Blobs), the four functions end to end against a mock RPC node and Netlify's local Blobs server, the page's payment code with a stand-in document and wallet, key generation against RFC 8032, OpenSSL and `@solana/web3.js`, and the built output. It runs `vite build` itself. Every test has a 60 second limit (`--test-timeout` in `web/package.json`), so a hang fails the run instead of stalling it. `.github/workflows/test.yml` runs the same commands on Node 22 for every push and pull request, with read-only repository access and no secrets. Netlify's local Blobs server, which `netlify dev` also uses, does not make conditional writes atomically, so concurrent spends against it can all succeed: it shows the protocol, not single-spend.

`npm run build` writes `dist/_headers` from `web/src/headers.js`. That file is the only place response headers are defined. The build fails if a published page contains inline script or style, or if it cannot find exactly one grind worker to write a rule for.

## Netlify site

1. Netlify → Add new site → Import an existing project. Choose this GitHub repository.
2. The site base directory is `web`. Netlify reads `web/netlify.toml` in that case and the root `netlify.toml` otherwise; the two are kept identical apart from `base`.
3. If the UI asks for a base directory, set `web`. Leave the build command and publish directory as the toml specifies (`npm run build`, `dist`).
4. Add `SOLANA_RPC_URL` and `UNLOCK_SECRET`. Leave `PAY_TO_ADDRESS` unset (or delete it if an older setup added it with another value).
5. Deploy. Confirm the function list shows `quote`, `prepare`, `verify`, and `consume`, and that the deploy log lists rate limiting rules for `prepare` and `verify`. The free plan allows two such rules per project.
6. Enable Blobs for the site if the dashboard asks. The free tier includes a Blobs quota; each paid grind stores one small record.
7. Site configuration → Build & deploy → Deploy previews: turn off deploy previews for pull requests from forks, or require approval for them. The repository is public, the Blobs store is shared by every deploy of the site, and a preview runs the pull request's own functions. Nothing in the store can unlock a grind, but a hostile preview could mark customers' payments as spent.

`netlify dev` from the repository root serves the Vite app and the functions on port 8888, with a local Blobs store. That store is not atomic: do not use it to judge whether a payment can be spent twice. The policy names no host (`connect-src 'self'`), so the page works on any origin it is served from: production, a deploy preview, or localhost.

Do not enable Netlify Analytics or any snippet injection: the policy would block an injected script, and the page's promise is that nothing else runs on it. Do not add a function that accepts a private key.

## Before publishing this version

The live site runs `34623f1`. Do these before this version goes live, in this order.

1. **PAY_TO_ADDRESS.** Site configuration → Environment variables. It must be unset, or exactly `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp` (surrounding spaces are allowed). Any other value stops every payment as soon as this version is live. If it names another wallet, payments made to that wallet and not yet redeemed cannot be redeemed after the switch: let them be redeemed first, or refund them. A variable changed in the UI reaches the functions only after a redeploy.
2. **Build environment.** No variable that runs code during the build is set: `NODE_OPTIONS`, `NPM_CONFIG_*`, or anything else you did not add on purpose. Those can change the address compiled into the page and the functions.
3. **The old records.** Do not delete the Blobs store `grind-payments` or anything in it. The old version's records (`reference → { status, signature }` at the top level) are what tells, after the switch, which old payments were used. Listing the old payments that are owed a refund happens **after** publishing, not now: see "Unspent payments from the old version". A list taken before the switch would miss every payment made until the switch, and every customer the old version never wrote a record for.

## Check a deploy before it takes payments

Run these against the deploy preview URL of a pull request, then again against production after publishing. Replace `$SITE`.

```bash
SITE=https://vanitygrinder.com

# 1. The page policy names no host, and the worker's policy allows nothing.
curl -sI $SITE/ | tr -d '\r' | grep -i content-security-policy
MAIN=$(curl -s $SITE/ | grep -o 'assets/index-[^"]*\.js' | head -1)
WORKER=$(curl -s $SITE/$MAIN | grep -o 'assets/grind-worker-[A-Za-z0-9_-]*\.js' | head -1)
curl -sI $SITE/$WORKER | tr -d '\r' | grep -i content-security-policy

# 2. The functions answer on /api/ and nowhere else.
curl -s $SITE/api/quote
curl -s -o /dev/null -w '%{http_code}\n' $SITE/.netlify/functions/quote                      # 404
curl -s -X POST -H 'content-type: application/json' -d '{}' $SITE/api/prepare               # 400, "not valid"
curl -s -X POST -H 'content-type: text/plain' -d '{}' -o /dev/null -w '%{http_code}\n' $SITE/api/verify   # 400
curl -s -X POST -H 'content-type: application/json' -d '{"token":"x.y"}' $SITE/api/consume  # 400, reason "bad"

# 3. The rate limit is enforced (it can take about 10 seconds to start): expect 429s.
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'content-type: application/json' -d '{}' $SITE/api/prepare; done; echo
```

The first header must be `default-src 'self'; script-src 'self'; style-src 'self'; …; connect-src 'self'; …` with no host name in it. The second must be `default-src 'none'; frame-ancestors 'none'`.

Then pay once from a wallet other than the payee `crimeK…` (`PAY_TO`), on the deploy you are checking. The payee cannot pay itself: prepare refuses, because such a transfer would move nothing.

- The status line goes from "Looking for your payment on chain" to "Payment found" to "Paid. Starting this grind.", without a reload, and clears when the grind starts.
- DevTools shows requests only to `/api/` and this site's own static files (`/system.css`, `/system.js`, `/fonts/*.woff2`, the bundle). After the console says it is grinding, no further requests appear.
- The match shows the address and "Private Key: hidden". Clicking that line reveals the key and starts the 60 second countdown.
- The page is on Quiet Technical 2.3 (2026-11-20 redesign). The deploy now publishes `system.css`, `system.js`, `fonts/` (eleven `.woff2` files and `OFL.txt`) and a rebuilt `404.html` from `web/public/`; `404.css` is gone. No header or CSP changed: `font-src 'self'` was already in the policy. Check that `/fonts/geist-latin-wght-normal.woff2` answers 200 with `font/woff2`, and that a missing path shows the new 404 page with its styles. `og.png` is new (the generator, light theme); paste the URL into a link-preview tool after deploying, as X, Telegram and Discord cache the old card. There is no favicon until a mark is approved (`<link rel="icon" href="data:," />`).
- Reloading the page and reaching the payment step asks for a new payment; the spent payment is not offered again.

Deploying replaces the page and the functions together. Switching from `34623f1`: a tab opened before the deploy keeps the old page, whose function URLs (`/.netlify/functions/`) are gone, so nobody pays through it. Every payment made under the old version and never spent, not only one in flight at the moment of the deploy, cannot be redeemed afterwards; "Unspent payments from the old version" lists them from the chain once this version is live, and refunds them. If someone reports one, "Refund requests" handles it. Later deploys keep the `/api/` paths, so an old tab keeps talking to the new functions; if the payee changed, it refuses to pay until reloaded.

## Refund requests

Customers ask for a refund by opening an issue on the GitHub repository and quoting what the page showed them: the payment's reference and, if the page knew it, its transaction signature. Everything in such an issue is public anyway. Never ask a customer for anything secret, and never ask for or show the payment claim (`vg-pay-claim`); a refund needs none of it.

Refunds are handled with `web/scripts/payments.mjs`, a tool you run on your own computer. It is not part of the site and is never deployed. It reads the payment from the chain and the ledger from Netlify Blobs, and the only things it writes are refund records: the mark that stops a payment from being used, and which transfer refunded it. It holds no key and moves no money: you send the refund yourself, from the payee wallet.

Where it cannot be sure, it says so and asks you to look by hand. It never tells you to send money, or to send nothing, on a guess.

Use it only once this version is published. The old functions do not read the refund mark.

### One-time setup

1. Node.js 22.12 or newer, and the repository:

   ```bash
   git clone https://github.com/DoradoDevs/solana-vanity-address-generator.git
   cd solana-vanity-address-generator/web
   npm ci
   ```

2. A Netlify personal access token and the site ID. Either:
   - With the Netlify CLI: `npm i -g netlify-cli`, then `netlify login` (it opens the browser). Run `netlify link` inside `web/` and pick this site; `netlify status` then prints the site ID (also called the project ID). The CLI keeps its own token; for this tool, create one as below.
   - In the Netlify UI: User settings → Applications → Personal access tokens → New access token. Give it a short expiry. The site ID is under Site configuration → General → Site details → Site information ("Site ID" / "Project ID").

   The token can read and write every site on your account. Keep it out of files, chat and shell history where you can (on most shells, a command typed with a leading space is not saved), and revoke it when you are done.

3. A Solana mainnet RPC URL. Use a key of its own if your provider gives you one: the tool reads wallets' histories one transaction at a time, and with the site's key (`SOLANA_RPC_URL` in the Netlify UI, which also works) it shares the site's rate limit and credits. The tool retries a call that times out, drops, or is rate limited (HTTP 429 or 5xx), waiting 1, 2 and 4 seconds, then stops with "Try again later".

4. In the terminal you will run the tool from:

   ```bash
   export SOLANA_RPC_URL='https://…'
   export NETLIFY_SITE_ID='…'
   export NETLIFY_AUTH_TOKEN='…'
   ```

   On Windows PowerShell: `$env:SOLANA_RPC_URL = '…'`, and the same for the other two.

The tool never prints the token or any part of the RPC URL, error messages included. If a variable is missing it names it and stops.

### Find the transaction

If the issue quotes a signature (88 or so characters), use it. If it quotes only a reference (about 44 characters), open `https://solscan.io/account/<reference>`: the transactions listed there name it. The payment is the one that sent 1 USDC to `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`. Copy its signature. If several did, check each. A transfer quoted that names no reference (a tip sent to the same address, which the page shows for tips) is not a payment, and the tool says so.

### Check, mark, send, record: in that order

1. **Check.**

   ```bash
   node scripts/payments.mjs check <signature>
   ```

   It prints whether the transaction is finalized and succeeded, whether it paid exactly 1.00 USDC to the payee, the wallet that paid, its time, the ledger's records for it, and one verdict:

   | Verdict | Meaning | What to do |
   |---|---|---|
   | `REFUNDABLE` | A payment nothing has used, at least 24 hours old, and no USDC went from the payee to the wallet that paid since. | Go on to step 2. |
   | `USED` | It unlocked a grind (in this version, or the old one). | No refund. Reply that the payment was used, and when. |
   | `MARKED` | Marked refunded, but no refund transfer is recorded for it: either it was sent and step 4 was not done, or it was never sent. It lists any USDC the payee sent that wallet since the payment. | If one of the transfers it lists is this payment's refund, do step 4 with it. If none is, send the refund (step 3), then step 4. |
   | `REFUNDED` | Marked, and its refund transfer is recorded. | **Send nothing.** |
   | `MAYBE_REFUNDED` | Nothing used it and it is not marked, but the payee sent the wallet that paid some USDC after the payment, in a transfer no record gives to any payment. It lists those transfers. | Look by hand. If one of them refunded this payment, record it: `mark-refunded <signature> --sent <that transfer>` (it marks the payment too). If none did, send the refund and record it the same way. The tool will not mark it without a transfer. |
   | `NOT_A_PAYMENT` | Not a payment this site's page built: not a finalized, successful transfer of exactly 1.00 USDC to the payee, or one that names no reference account (every page version adds one; a plain transfer such as a tip has none). | No refund through this tool. A transaction that is not final yet says this too: check again in a minute. A SOL payment from launch day is not a USDC payment: see "SOL payments from launch day". |
   | `TOO_RECENT` | Unspent, but paid less than 24 hours ago. | Wait until the time it prints, then check again. |
   | `UNCLEAR` | It paid, but the tool cannot settle it: no single wallet paid exactly 1.00 USDC, the chain gave no time or slot for it, the ledger holds a record under one of its accounts that the old version could not have written, or a transaction of the paying wallet after it is not final yet or cannot be read. | Look at it by hand; the "not final yet" case goes away if you check again in a minute. The tool will not mark it. |

2. **Mark.**

   ```bash
   node scripts/payments.mjs mark-refunded <signature>
   ```

   It runs the same check again and refuses unless the verdict is `REFUNDABLE`. Then it writes `spent/<signature>` = `{ refunded: true, at, payer }` with the same conditional write that spends a payment for a grind, and prints the wallet to refund. If anything spent the payment between the check and the write, the write fails and nothing is marked: run check again. If the command stops with an error from the ledger, the mark may or may not have been written: run check before sending anything.

3. **Send** exactly 1.00 USDC from the payee wallet `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp` to the wallet `mark-refunded` printed, as an ordinary USDC transfer to that wallet address, on its own (one refund per transfer). Copy the transfer's signature.

4. **Record** which transfer refunded it:

   ```bash
   node scripts/payments.mjs mark-refunded <signature> --sent <the transfer's signature>
   ```

   It refuses, and writes nothing, unless the transfer is finalized (wait a minute after sending), moves exactly 1.00 USDC from the payee to the wallet that paid and no other wallet's USDC, landed after the payment, and is not already recorded as another payment's refund. Then it writes `refund-transfer/<transfer>` = `{ payment, at }` (created once, so one transfer answers one payment) and `refund-sent/<signature>` = `{ transfer, at }`, and `check` says `REFUNDED`. Run again with the same transfer, it says it is already recorded. Then reply on the issue with the refund's signature and close it.

**Why this order.** Once marked, `/api/verify` and `/api/consume` answer 409 "refunded" for that payment, so it can no longer unlock a grind. Marking first means a payment can never be both refunded and used: if the customer's page spends it first, the mark fails and you send nothing; if the mark lands first, the page is refused. Sending first and marking afterwards would leave a window where the customer gets the 1.00 USDC back and the grind.

**Why anyone may ask, and why 24 hours.** The refund only ever goes to the wallet whose USDC paid, as read from the transaction, never to an address the person asking names. So a stranger who copies a signature off the chain cannot gain anything by asking, and there is no need to make customers prove who they are (which would mean asking for a secret, or a signed message most customers cannot produce). The one thing a stranger could do is get somebody else's payment refunded while its owner still meant to use it. The money then goes back to the owner, so nothing is lost, but they lose the grind they came for. The 24 hour wait (`REFUND_MIN_AGE_MS` in the tool) gives a customer whose page is still waiting on the payment time to use it first. A customer who paid and gave up can always be told to wait a day.

**How the tool knows a refund was already sent.** Only step 4's record makes it say "send nothing". Without one, it reads the history of the account that paid and of the wallet's USDC associated account (where a transfer to the wallet lands), from now back to the payment and no further, and lists every transfer of USDC, of any amount, from the payee to that wallet that is not recorded as some payment's refund. If there is one, the verdict is `MARKED` or `MAYBE_REFUNDED` and you decide; if there is none, it is `REFUNDABLE`. Nothing is paired by time: the clock of the computer you run it on plays no part, and neither do the `--since` and `--until` of the lists. So a payment refunded by hand, before or without this runbook, comes up `MAYBE_REFUNDED` until you record its transfer; and a wallet that paid twice, refunded once, shows the unrecorded refund on its other payment until you record it. A transfer to another USDC account of the wallet, neither the one that paid nor its associated account, is not seen: send refunds only as step 3 says, to the wallet itself.

The customer's SOL network fee is not refunded; the tool only covers the 1.00 USDC.

## Unspent payments from the old version

The version before this one (`34623f1`) found a payment by a random reference, wrote `reference → { status: "paid", signature }` to the Blobs store `grind-payments` when its verify succeeded, and changed it to `status: "consumed"` when the grind started. This version cannot redeem any of those payments: its references come from a claim the old page never had. So every old payment that never unlocked a grind is owed a refund.

The ledger is not the list. The old version wrote a record only after its verify succeeded, so a customer whose page stopped on "No payment was found", or who closed the tab before the check finished, has no record at all, though their 1.00 USDC arrived. The tool therefore reads the list from the chain (every transaction on the payee's USDC account) and uses the ledger only to tell which were used.

Run it **after** this version is published, not before. Until the switch the old functions are live: they can still verify and spend old payments, they do not read refund marks, and a list taken before the switch misses payments made after it. Once the new version is live, the old page's function URLs are gone and nothing more is added to the old list.

1. Note the publish time: Deploys → the deploy that published this version → its "Published" time. Write it as an ISO time with the zone, for example `2026-11-20T15:04:05Z`.

2. Set up the shell as in "Refund requests", then:

   ```bash
   node scripts/payments.mjs old-payments --until 2026-11-20T15:04:05Z
   ```

   `--until` is the publish time: payments made at or after it belong to this version and are left out. The tool refuses a time in the future. `--since` defaults to `2026-11-15T14:36:14Z`, the time of `63308b0`, the first commit on any branch with the payment functions. That is only as early as the repository can see: a deploy made with the Netlify CLI publishes the working tree, committed or not. **Before relying on the default**, open Deploys in the Netlify UI, scroll to the oldest deploy (production, branch or preview) whose function list shows `verify`, and note its time. If it is earlier than `2026-11-15T14:36:14Z`, pass `--since` a minute before it, here and to `old-sol-payments`.

   It prints one line per payment that is neither used nor already refunded: signature, time, paying wallet, the old record's status (`paid`: verified but never used; `none`: never verified; `unreadable`: see `UNCLEAR`), and the verdict. It ends with how many were left out as used or refunded (with the refund recorded). Refunds sent from the payee, failed transactions, transfers of other amounts and transfers that name no reference (tips) are not payments and are not listed. A payment the payee may already have refunded by hand is listed as `MAYBE_REFUNDED`, with the transfers it saw.

3. For each `REFUNDABLE` payment, mark, send and record exactly as in "Refund requests". For each `MAYBE_REFUNDED` or `MARKED` one, decide by hand as its line says, and record the transfer with `--sent`. Payments from the last 24 hours before the switch are listed as `TOO_RECENT`: do them the next day. `UNCLEAR` ones need a look by hand.

4. Run `old-payments` again with the same `--until`. Everything you refunded and recorded is now counted as refunded; the list should hold only what you chose to leave.

Keep the old records in the store: they are what shows which old payments were used. A payment the old page sent in the last seconds before the switch can land just after it and is then not listed; if its customer asks, "Refund requests" handles it.

### SOL payments from launch day

The first versions (`8d35fb7` to `7ec217c`, the morning of 2026-11-15) also took SOL: a transfer of about $1 in SOL straight to the payee wallet, naming a reference, recorded as `{ status: "paid", asset: "sol", signature }` once verified. `9b2480c` charged USDC only. No version still running can redeem a SOL payment, and `old-payments` reads only the payee's USDC account, so these are listed separately:

```bash
node scripts/payments.mjs old-sol-payments
```

It reads the payee wallet's history and lists only SOL that someone else sent the payee in a top-level SystemProgram transfer naming a reference account. It never lists a transaction the payee wallet signed (a swap, an unstake, a transfer of your own), SOL that reached it any other way (a program paying it from a vault), or a plain transfer that names no reference (a tip). For each one listed it prints the signature, time, paying wallet, the SOL paid (to the lamport), the old record's status and one verdict:

| Verdict | Meaning | What to do |
|---|---|---|
| `REFUNDABLE` | Exactly what the launch versions built (one transfer from the wallet that signed and paid the fee, one reference, at most ComputeBudget instructions beside it, nothing else moved, about $1: between 0.001 and 0.02 SOL), the old record says nothing used it, and no SOL went from the payee to that wallet since. | Send exactly that SOL from the payee wallet to that wallet. |
| `SENT_BACK` | Exactly the launch shape, the wallet's only SOL payment, and exactly its lamports went back to the wallet once, after it. | Send nothing. |
| `MAYBE_REFUNDED` | SOL went back to the wallet since, but not in that one exact way: a different amount, more than one transfer, or a wallet that made more than one SOL payment (a used one included), where the chain cannot say which payment a transfer answered. | Look by hand. |
| `UNCLASSIFIED` | SOL from someone else naming a reference, but not exactly the launch shape (it says how). It may not be a payment at all. | Look by hand. Send nothing on the tool's word. |
| `UNCLEAR` | The ledger holds a record the old version could not have written, the chain gave no slot, or the transaction is not final yet. | Look by hand, or run again in a minute. |

What went back is read over the payee wallet's whole history from `--since` or `2026-11-15T14:36:14Z`, whichever is earlier, to now: `--since` and `--until` change only which payments are listed. Nothing is marked. Run it again after sending: each one you sent shows `SENT_BACK`, or `MAYBE_REFUNDED` for a wallet that paid more than once (check those against what you sent).

## Domain vanitygrinder.com

1. Site configuration → Domain management → Add a domain → `vanitygrinder.com`.
2. Add `www.vanitygrinder.com` and set it to redirect to the apex.
3. At the DNS host, create the records Netlify shows. For DNS hosted outside Netlify they are currently:

| Type | Name | Value |
|---|---|---|
| A | `@` | `75.2.60.5` |
| CNAME | `www` | `<site-name>.netlify.app` |

Use the values in the Netlify UI if they differ. Wait until the domain shows a certificate.

Since 2026-11-20 the default host, `vanitygrinder.netlify.app`, answers every page with a 301 to `https://vanitygrinder.com` (the first rules in `web/public/_redirects`, checked by `web/test/build.test.js`); deploy previews, branch deploys and the functions on `/api/` are not redirected.

## Owner checklist

- [ ] `SOLANA_RPC_URL` and `UNLOCK_SECRET` are set in the Netlify UI and are not in git.
- [ ] The steps in "Before publishing this version" are done: `PAY_TO_ADDRESS` checked, no build-affecting variables, the old records kept.
- [ ] Before the old lists: the oldest Netlify deploy that served `verify` is no earlier than `2026-11-15T14:36:14Z`, or `--since` is set before it ("Unspent payments from the old version", step 2).
- [ ] After publishing: `old-payments --until <publish time>` run; every `REFUNDABLE` payment marked, refunded and its transfer recorded with `--sent` (the `TOO_RECENT` ones the next day); every `MAYBE_REFUNDED`, `MARKED` and `UNCLEAR` one looked at by hand; and run again to confirm ("Unspent payments from the old version").
- [ ] `old-sol-payments` run, every `REFUNDABLE` SOL payment sent back, every other verdict but `USED` and `SENT_BACK` looked at by hand, and run again ("SOL payments from launch day").
- [ ] The built bundle pins the payee: `grep -l crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp web/dist/assets/index-*.js` after `npm run build`, and the same address in the deployed `$SITE/$MAIN`.
- [ ] `PAY_TO_ADDRESS` is unset, or set to exactly `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp` (`PAY_TO` in `shared/payment.js`). `curl -s $SITE/api/quote` returns that address, not a 503.
- [ ] `cd web && npm ci && npm test && npm run build` and `cd cli && npm ci && npm test` succeed.
- [ ] The site is the Netlify project for this repository, not a Vercel project.
- [ ] `vanitygrinder.com` resolves to Netlify and HTTPS is valid. `www` redirects to the apex.
- [ ] The checks in "Check a deploy before it takes payments" pass, including the 429s.
- [ ] A $1 USDC payment from a wallet other than the payee unlocks one grind without a reload, and paying again is required for the next one.
- [ ] The RPC provider's dashboard has a usage alert or a spending cap. The rate limits bound one visitor, not a crowd.
