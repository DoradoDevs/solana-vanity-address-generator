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
| `UNLOCK_SECRET` | Yes | Random string of at least 16 characters. `openssl rand -base64 32`. Signs the unlock token. Unset or shorter than 16 characters, verify and consume answer 500 and no grind can be unlocked. Changing it voids tokens already issued (they last ten minutes); payments are unaffected and simply verify again. |

To change where payments go, change `PAY_TO` in `shared/payment.js` (and the tip address in `web/src/site.config.js`) and deploy. Tabs opened before that deploy still hold the old address, so they refuse every payment until reloaded (the page says to reload). Payments already sent to the old address and not yet redeemed cannot be redeemed afterwards: refund them. The page and the functions are built from the same constant: before the wallet is asked to sign, the page decodes the transaction prepare returned and refuses it unless it is exactly 1.00 USDC of the USDC mint from the connected wallet's USDC account to that address's USDC account, naming this attempt's reference, with nothing else in it but the payee account's idempotent creation. The tip address is not a secret.

The payee's USDC associated-token account is created inside the payment transaction if it does not exist yet. The connected wallet is the fee payer and covers that rent the first time. The price is exactly 1.00 USDC. There is no SOL payment and no price oracle.

## What the functions do

Each function has its own path under `/api/`. The default `/.netlify/functions/<name>` URLs do not exist.

| Path | Role |
|---|---|
| `GET /api/quote` | The fixed `1.00` USDC amount, the USDC mint, and the receive address. No RPC call. |
| `POST /api/prepare` | Body `{ payer, claim }`. Builds the unsigned transfer of exactly 1.00 USDC from the wallet's USDC account to the payee's, with an idempotent create-account instruction and a read-only reference account. The reference is the SHA-256 of the caller's claim. Two RPC requests: balances and a blockhash. Rate limited to 12 a minute per visitor. The page checks the result byte by byte before its wallet sees it (`web/src/transfer-check.js`). |
| `POST /api/verify` | Body `{ claim, signature }`, the signature being the one the wallet returned (optional). With it, verify reads that transaction directly and ignores anything else that names the reference. Without it, or when the node does not know that signature, verify searches the transactions naming the claim's reference for one that pays (at most four read per request). Requires finality, checks that the transaction names the reference, and checks from the recorded token balances that the payee ended up with exactly 1.00 USDC more. Returns an unlock token, valid ten minutes. A 400 is only ever a verdict on the transaction the page pointed at, read at finalized: the claim's own. The search by reference never ends in a 400, because what it finds may be someone else's; when nothing there pays it answers 202, and when the node's answer cannot be relied on, 503. Either way the page keeps the payment. Writes nothing. Rate limited to 60 a minute per visitor. |
| `POST /api/consume` | Body `{ token }`. Records the transaction as spent with one conditional write to Netlify Blobs (`onlyIfNew`, which Netlify documents as an atomic conditional write). The first token wins; every other token for that transaction is refused. The winning token gets the same answer if it is sent again, even after it expires, so a lost response does not cost the customer their grind. The terminal starts one grind only after this succeeds. |

All POST bodies must be `application/json`. Other content types are refused before any RPC or ledger work, so another site cannot spend the RPC quota through its visitors' browsers.

The ledger is the Blobs store `grind-payments`, one record per spent transaction under `spent/<signature>`. Records written before this version are keyed by reference at the top level. This version does not read them, but they are the only list of customers who paid under the old version and were never given a grind: keep them (see "Before publishing this version").

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

`npm test` in `web/` covers payment verification against a mock chain (wrong amount, wrong mint, wrong owner, failed and unfinalized transactions, one payment naming many references, somebody else's payment, RPC failures), concurrent spends (in memory, and through the real Blobs client against an atomic stand-in for hosted Blobs), the four functions end to end against a mock RPC node and Netlify's local Blobs server, the page's payment code with a stand-in document and wallet, key generation against RFC 8032, OpenSSL and `@solana/web3.js`, and the built output. It runs `vite build` itself. Netlify's local Blobs server, which `netlify dev` also uses, does not make conditional writes atomically, so concurrent spends against it can all succeed: it shows the protocol, not single-spend.

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
3. **Unspent payments from the old version.** The old version stored `reference → { status: "paid", signature }` at the top level of the Blobs store `grind-payments` and handed a token to such a record at any time. This version cannot redeem them. List them and refund or honour each one:

   ```bash
   netlify blobs:list grind-payments --directories   # the old references, plus the spent/ directory this version writes
   netlify blobs:get grind-payments <reference>
   ```

   A record whose `status` is `paid` is a payment that was verified. Look up its `signature` on a block explorer to find the paying wallet, and refund 1.00 USDC to it unless the customer was given their grind. Keep the records afterwards. Customers whose browser still holds the old reference see it on the page with how to ask for a refund.

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

- The status line goes from "Looking for your payment on chain" to "Payment found" to "Grind unlocked", without a reload.
- DevTools shows requests only to `/api/`. After the terminal says it is grinding, no further requests appear.
- The match shows the address and "Private Key: hidden". Clicking that line reveals the key and starts the 60 second countdown.
- Reloading the page and reaching the payment step asks for a new payment; the spent payment is not offered again.

Deploying replaces the page and the functions together. Switching from `34623f1`: a tab opened before the deploy keeps the old page, whose function URLs (`/.netlify/functions/`) are gone, so nobody pays through it. Every payment made under the old version and never spent, not only one in flight at the moment of the deploy, cannot be redeemed afterwards; step 3 of "Before publishing this version" lists them. If someone reports one, refund the 1.00 USDC to the sending wallet. Later deploys keep the `/api/` paths, so an old tab keeps talking to the new functions; if the payee changed, it refuses to pay until reloaded.

## Domain vanitygrinder.com

1. Site configuration → Domain management → Add a domain → `vanitygrinder.com`.
2. Add `www.vanitygrinder.com` and set it to redirect to the apex.
3. At the DNS host, create the records Netlify shows. For DNS hosted outside Netlify they are currently:

| Type | Name | Value |
|---|---|---|
| A | `@` | `75.2.60.5` |
| CNAME | `www` | `<site-name>.netlify.app` |

Use the values in the Netlify UI if they differ. Wait until the domain shows a certificate.

## Owner checklist

- [ ] `SOLANA_RPC_URL` and `UNLOCK_SECRET` are set in the Netlify UI and are not in git.
- [ ] The steps in "Before publishing this version" are done: `PAY_TO_ADDRESS` checked, no build-affecting variables, old `status: "paid"` records refunded or honoured and kept.
- [ ] The built bundle pins the payee: `grep -l crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp web/dist/assets/index-*.js` after `npm run build`, and the same address in the deployed `$SITE/$MAIN`.
- [ ] `PAY_TO_ADDRESS` is unset, or set to exactly `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp` (`PAY_TO` in `shared/payment.js`). `curl -s $SITE/api/quote` returns that address, not a 503.
- [ ] `cd web && npm ci && npm test && npm run build` and `cd cli && npm ci && npm test` succeed.
- [ ] The site is the Netlify project for this repository, not a Vercel project.
- [ ] `vanitygrinder.com` resolves to Netlify and HTTPS is valid. `www` redirects to the apex.
- [ ] The checks in "Check a deploy before it takes payments" pass, including the 429s.
- [ ] A $1 USDC payment from a wallet other than the payee unlocks one grind without a reload, and paying again is required for the next one.
- [ ] The RPC provider's dashboard has a usage alert or a spending cap. The rate limits bound one visitor, not a crowd.
