# Deploy VanityGrinder

VanityGrinder is a **static site**. The browser generates every key. Going live means hosting `web/dist` and pointing `vanitygrinder.com` at it. Do not add a serverless function, an analytics beacon, a wallet adapter, or a payment API. Those would break the privacy promise.

The production Content-Security-Policy includes `connect-src 'none'`. After the HTML, CSS, and JS load, the page cannot `fetch`, open a websocket, or send a beacon. `web/public/_headers` (Cloudflare Pages and Netlify) and `web/vercel.json` (Vercel) both send that policy. Tests in `web/test/privacy.test.js` fail if the copies drift.

## What you edit before the first production build

File: `web/src/site.config.js`. It is compiled into the bundle. The browser cannot download a replacement later, because `connect-src 'none'` forbids that.

| Field | What to put | Leave it alone if |
|---|---|---|
| `tipAddress` | Your **public** Solana address (32–44 Base58 characters). | You do not want a tip line. `""` hides it. Do not invent an address. |
| `pro.enabled` | `true` only if this deploy should offer batch generation (several matches per run). | You want the default: one address per run. |
| `pro.freeMaxPatternLength` | Length that shows a Pro notice while the flag is off. Default `5`. | The default is fine. |
| `pro.maxBatch` | Cap when Pro is on. Default `10`. | The default is fine. |

Never put a private key, seed phrase, RPC URL with a secret, or payment secret in that file or in the host's environment. This app does not read payment keys. There is no Stripe key, no wallet key, and no server env var required for the site to function.

`npm test` expects `pro.enabled` to stay `false` in the repo so the flag cannot flip unnoticed. If you turn it on for the deploy you publish, update that assertion in `web/test/privacy.test.js` in the same change.

## Build on your machine first

Requires Node.js 22 (see `web/.node-version`). Node 20 also works.

```bash
cd web
npm ci
npm test
npm run build
```

`web/dist` must contain `index.html`, `assets/`, `_headers`, `robots.txt`, `sitemap.xml`, and `og.png`. The grind worker is a hashed file under `assets/`, referenced by the page. You do not configure a worker URL.

Optional local check of the production headers:

```bash
npm run preview
# other terminal:
curl -sI http://127.0.0.1:4173/ | tr -d '\r'
```

Confirm the response includes `connect-src 'none'` and does not include `connect-src 'self'`.

## Cloudflare Pages

Use the git integration. Uploading `dist` by hand also works; the settings below are for git.

1. In the Cloudflare dashboard open **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Select this repository.
3. Set **Production branch** to `main` (or whichever branch you release from).
4. Set **Root directory** to `web`. The preset will not find the app at the repo root.
5. Set **Framework preset** to **Vite**, or **None** if you would rather type the commands.
6. Set **Build command** to `npm run build`.
7. Set **Build output directory** to `dist`.
8. Set the environment variable **`NODE_VERSION`** to `22`. There are no other variables.
9. Save and deploy.

Cloudflare Pages reads `dist/_headers` and applies it. That file is copied from `web/public/_headers`.

Turn these off for the zone or the Pages project. Each one can inject a script or a beacon and either break the CSP or quietly violate the "no analytics" claim:

- Web Analytics
- Zaraz
- Email Address Obfuscation
- Rocket Loader
- Automatic HTTPS Rewrites are fine. Minify is unnecessary; the build is already minified.

Do not add a Pages Function, a `_worker.js`, or a form handler.

### Custom domain on Cloudflare

1. Open the Pages project → **Custom domains** → **Set up a custom domain**.
2. Enter `vanitygrinder.com`.
3. If the DNS zone is already on this Cloudflare account, accept the record Pages offers. It creates a proxied CNAME (or the apex CNAME flattening Cloudflare uses) to `<project>.pages.dev`.
4. Add `www.vanitygrinder.com` the same way if you want it.
5. In the DNS tab, confirm the apex and `www` are **Proxied** (orange cloud) and point at the Pages target, not at an old host.
6. SSL/TLS mode for the zone: **Full (strict)**. Pages certificates cover the custom domain once the record is in place. Wait until the domain shows Active.
7. Optional: a redirect rule so `www.vanitygrinder.com` 301s to `https://vanitygrinder.com`. The canonical tag is the apex.

Apex DNS when the zone is on Cloudflare:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | `<project>.pages.dev` | Proxied |
| CNAME | `www` | `<project>.pages.dev` | Proxied |

Cloudflare flattens the apex CNAME. You do not need an A record.

## Vercel

`web/vercel.json` sets the Vite build, `dist` output, and the same security headers as `_headers`. Vercel does **not** read `_headers`.

1. Import the Git repository at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `web`. This is the step that makes `vercel.json` apply.
3. Framework Preset: **Vite**. Build command `npm run build`. Output directory `dist`. Install command `npm install` (or `npm ci`).
4. Leave **Environment Variables** empty. Do not add `SOLANA_PRIVATE_KEY`, a Stripe key, or an RPC URL.
5. Node.js version: 22.x (Project → Settings → General).
6. Deploy.

Do not enable Vercel Analytics, Speed Insights, or Toolbar on this project. Do not add Serverless Functions or Edge Middleware.

### Custom domain on Vercel

1. Project → **Settings** → **Domains** → add `vanitygrinder.com`.
2. Add `www.vanitygrinder.com` and choose **Redirect to vanitygrinder.com**.
3. At the registrar (or Cloudflare DNS, if the zone lives there), create the records Vercel shows. They are currently:

| Type | Name | Value |
|---|---|---|
| A | `@` | `76.76.21.21` |
| CNAME | `www` | `cname.vercel-dns.com` |

4. If DNS is on Cloudflare and the site is on Vercel, set those records to **DNS only** (grey cloud). An orange-cloud proxy in front of Vercel fights the TLS certificate unless you have intentionally configured that.
5. Wait until Vercel shows the domain as valid and serving a certificate.

Confirm headers against the live host:

```bash
curl -sI https://vanitygrinder.com/ | tr -d '\r'
```

You want `content-security-policy` to contain `connect-src 'none'`.

## After DNS is live

1. Open `https://vanitygrinder.com/` and hard-refresh.
2. DevTools → Network. Disable cache. Reload. You should see only this origin: the document, the stylesheet, the script, the worker chunk, `og.png` is not loaded by the page (crawlers fetch it).
3. Grind a one-character suffix such as `a`. A match should appear without any new network row.
4. Confirm the private key is on screen, click it to copy, and confirm you can import that Base58 64-byte key into a wallet you trust. Then clear it from the clipboard.
5. Open the Safety FAQ, the estimator, and Support. With `tipAddress` still `""`, the tip line says it is not set. After you set an address and rebuild, the copy button appears.
6. View source or the response headers and check `connect-src 'none'` one more time.

`sitemap.xml` and `robots.txt` are already in the build. Submit `https://vanitygrinder.com/sitemap.xml` in Search Console when you want indexing. Nothing else has to be generated.

## Owner checklist

- [ ] `web/src/site.config.js`: your public tip address, or `""`.
- [ ] `pro.enabled` left `false`, or set `true` and the privacy test updated.
- [ ] `cd web && npm ci && npm test && npm run build` succeeds.
- [ ] Host root directory is `web`, build is `npm run build`, output is `dist`.
- [ ] No analytics product, no functions, no secrets in the dashboard.
- [ ] `vanitygrinder.com` DNS points at that host only, HTTPS is valid, `www` redirects to the apex.
- [ ] `curl -sI https://vanitygrinder.com/` shows `connect-src 'none'`.
- [ ] A one-character grind finishes with an empty network log after load.
