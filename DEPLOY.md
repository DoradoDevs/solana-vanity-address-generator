# Deploy VanityGrinder on Netlify

VanityGrinder goes live on **Netlify** (free tier, private repository). The grind still runs in the browser. Netlify Functions only quote the $1 price, build the unsigned transfer, and check that the payment landed.

Do not deploy this site to Vercel. The payment check is a Netlify Function and the content-security policy names `/.netlify/functions/`.

Keys are generated on your device. The only network call is payment verification. The grind worker does not get the RPC URL.

## Environment variables

Set these in the Netlify UI: Site configuration → Environment variables. Scope them to Functions (or all scopes). Do not commit the secret or the RPC URL.

| Name | Required | Value |
|---|---|---|
| `PAY_TO_ADDRESS` | No | Public Solana address that receives the $1. Default, also in `netlify.toml`: `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`. Set this only to override that address. |
| `SOLANA_RPC_URL` | Yes | HTTPS Solana mainnet RPC, for example a Helius or Triton URL. Used only inside the functions. A URL with an API key stays server-side. |
| `UNLOCK_SECRET` | Yes | Random string of at least 16 characters. `openssl rand -base64 32`. Signs the one-grind unlock token. |

`web/src/site.config.js` shows the same address as an optional tip. It is not a secret. Changing the tip line requires a rebuild. Changing `PAY_TO_ADDRESS` in the Netlify UI changes where payments go without a rebuild; the quote response also updates the tip line on the page.

The owner's USDC associated-token account is created inside the payment transaction if it does not exist yet. The payer covers that rent the first time.

## What the functions do

| Path | Role |
|---|---|
| `GET /.netlify/functions/quote` | SOL price from CoinGecko and the exact `1` USDC amount. No RPC key. |
| `POST /.netlify/functions/prepare` | Unsigned transfer to `PAY_TO_ADDRESS` with a unique `reference` account. Uses `SOLANA_RPC_URL` for a blockhash. |
| `POST /.netlify/functions/verify` | Finds the transaction by that reference, requires finality, checks the recipient and the amount (exactly 1.00 USDC, or SOL within 3% of $1), rejects a reused reference, stores it in Netlify Blobs, returns an HMAC token. |
| `POST /.netlify/functions/consume` | Burns that token. The terminal starts one grind only after this succeeds. |

A modified copy of the JavaScript can still grind without paying, because the private key is never sent to the server. The hosted site gates the terminal on a token the server will issue only once per payment.

## Build locally

Node.js 22 (`web/.node-version`).

```bash
cd web
npm ci
npm test
npm run build
```

`npm test` covers the grinder and the payment check with a mock RPC: exact USDC success, SOL underpayment, a non-USDC mint, and a reference that was already consumed.

## Netlify site

1. Netlify → Add new site → Import an existing project. Choose this private GitHub repository. The free tier allows a private repo.
2. The site base directory is `web`. Netlify reads `web/netlify.toml` (not only the repo-root file) for `[functions]`. That file sets `node_bundler = "esbuild"`. The root `netlify.toml` repeats the same functions block and sets `base = "web"`.
3. If the UI asks for a base directory, set `web`. Leave the build command and publish directory as the toml specifies (`npm run build`, `dist`).
4. Add `SOLANA_RPC_URL` and `UNLOCK_SECRET`. Leave `PAY_TO_ADDRESS` unset to use the default, or set it to replace that address.
5. Deploy. Confirm the function list shows `quote`, `prepare`, `verify`, and `consume`.
6. Enable Blobs for the site if the dashboard asks. The free tier includes a Blobs quota; each paid grind stores one small record.

`netlify dev` from the repository root serves the Vite app and the functions on port 8888. The production CSP allows `http://localhost:8888/.netlify/functions/` and `http://127.0.0.1:8888/.netlify/functions/` so that local check can run. It does not allow a public RPC in the browser. Vite's own hot-reload socket is not in the production policy; use `netlify dev` when you need to exercise a payment.

Do not enable Netlify Analytics or any snippet injection. Do not add a second function that accepts a private key.

## Domain vanitygrinder.com

1. Site configuration → Domain management → Add a domain → `vanitygrinder.com`.
2. Add `www.vanitygrinder.com` and set it to redirect to the apex.
3. At the DNS host, create the records Netlify shows. For DNS hosted outside Netlify they are currently:

| Type | Name | Value |
|---|---|---|
| A | `@` | `75.2.60.5` |
| CNAME | `www` | `<site-name>.netlify.app` |

Use the values in the Netlify UI if they differ. Wait until the domain shows a certificate.

4. Check the live policy:

```bash
curl -sI https://vanitygrinder.com/ | tr -d '\r'
```

`content-security-policy` must contain `connect-src https://vanitygrinder.com/.netlify/functions/` and must not contain a Solana RPC host.

5. Open the site, pay $1 in USDC or SOL (wallet or QR), and confirm DevTools shows requests only to `/.netlify/functions/`. After the terminal says it is grinding, no further requests should appear. The private key stays in the tab.

## Owner checklist

- [ ] `SOLANA_RPC_URL` and `UNLOCK_SECRET` are set in the Netlify UI and are not in git.
- [ ] `PAY_TO_ADDRESS` is unset (default `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`) or set to another public address you control.
- [ ] `cd web && npm ci && npm test && npm run build` succeeds.
- [ ] The site is the Netlify project for this private repo, not a Vercel project.
- [ ] `vanitygrinder.com` resolves to Netlify and HTTPS is valid. `www` redirects to the apex.
- [ ] `curl -sI` shows the functions-only `connect-src`.
- [ ] A $1 payment unlocks one grind, and paying again is required for the next one.
