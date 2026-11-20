# VanityGrinder

Generate custom **Solana vanity addresses** — wallet addresses that start with, end with, or contain a string you choose (e.g. `SoL...`, `...pump`, `cafe` anywhere). Ships in two flavors that share one grinding approach:

| | What it is | Best for |
|---|---|---|
| [`web/`](web) | A browser app. Every keypair is generated locally in Web Workers. The page may connect only back to its own site, and only for the grind payment: $1 in USDC per grind, paid from your wallet. | Anyone — keys stay on the device. |
| [`cli/`](cli) | A **multi-threaded** Node.js command-line grinder. | Max throughput on a workstation or server. |

Both use audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) ed25519 and never transmit, log, or persist a generated key.

---

## Security model

Vanity grinding means generating enormous numbers of real keypairs and keeping the one whose address matches. That only stays safe if the keys never leave your machine — so this tool is built around that:

- **Keys stay on the device.** The grind runs in Web Workers. The worker script is served with `Content-Security-Policy: default-src 'none'`, so the browser itself refuses to let it open a connection. The page's own policy is `connect-src 'self'`: it can reach only this site's `/api/` functions, which quote and verify the grind payment: $1 in USDC per grind, paid from your wallet. Fonts (Geist, SIL OFL) are served from this site; no analytics, cookies, or trackers. The Solana RPC URL stays in a Netlify environment variable and never reaches the browser.
- **Keys live in memory only.** Raw secret-key bytes are zeroed immediately after they're encoded; non-matching keys are discarded each cycle. Nothing about a key is written to storage. The one thing the page saves is a random payment claim, so a payment survives a reload.
- **Web app hardening.** DOM is built with `textContent` only (no `innerHTML`, no XSS surface). A matched key stays hidden until you reveal it, so a grind that finishes while you are away waits for you. About 60 seconds after you reveal it the terminal wipes itself; a key line that is still on screen redacts after 2 minutes. Copying a private key clears the clipboard about 60 seconds later when the browser allows it. The page asks before you close a tab that holds a running grind or an unsaved key.
- **CSPRNG required.** Generation refuses to run without `crypto.getRandomValues`.

The payment gate is a convenience fee for the hosted page, not a lock on the algorithm: the keys are made in your browser, so the server cannot meter the work, and this repository and its CLI are free to run. What the server does guarantee is on the other side: one payment unlocks one grind, and only for the browser that paid. See [kb/README.md](kb/README.md).

> ⚠️ **You are responsible for the private key.** Anyone who has it controls the wallet. For a high-value address, run the tool offline, save the key to a hardware wallet or password manager, and never paste it into a website.

---

## CLI (`cli/`)

```bash
cd cli
npm install
npm start
```

Interactive prompts walk you through the pattern, position (prefix / suffix / anywhere), case sensitivity, and thread count, show a difficulty estimate, then grind across all your CPU cores until it finds a match.

Requires Node.js ≥ 20.19 (what `@noble/curves` 2 needs). Uses `worker_threads` for parallelism and `@noble/curves` for fast ed25519 keygen. `npm test` grinds a short pattern through the worker and through the whole program, and checks the result against OpenSSL.

## Web app (`web/`)

```bash
cd web
npm install
npm run dev      # UI only. Payment calls need the functions below.
npm run build    # production build to web/dist
npm run preview  # serve the production build locally
```

A grind costs $1 in USDC per grind, paid from your wallet. To exercise that locally, from the repository root, with `SOLANA_RPC_URL` and `UNLOCK_SECRET` set:

```bash
npx netlify dev
```

That serves the app and the payment functions (`/api/quote`, `/api/prepare`, `/api/verify`, `/api/consume`) together on port 8888, with a local stand-in for Netlify Blobs (which, unlike hosted Blobs, does not make conditional writes atomically). `npm run dev` by itself does not start those functions, so payment fails. There is no development bypass of the payment. One payment unlocks one grind, and only after the server has seen the finalized 1.00 USDC transfer. A real `SOLANA_RPC_URL` means real mainnet: paying there spends real USDC.

The generator takes the pattern, position, case and threads in a short form and shows the odds as you type. Start grinding measures your device for a couple of seconds, then says "Pay $1 to start grinding" and waits for the wallet payment. While it grinds, the readouts show attempts per second, attempts, and the probability that a match would have been found by now; the console under them logs the run and holds the key. Vite bundles the worker into the production build and writes `dist/_headers`, the response headers Netlify serves.

```bash
npm test     # payment verification against a mock chain, the functions end to end,
             # key generation against RFC 8032 / OpenSSL / @solana/web3.js, and the built output
```

The full gate is `cd web && npm ci && npm test && npm run build`, then `cd cli && npm ci && npm test`. Node.js 22.12 or newer for `web/`.

Deploy on Netlify. Steps, DNS for `vanitygrinder.com`, and the `PAY_TO_ADDRESS`, `SOLANA_RPC_URL`, and `UNLOCK_SECRET` variables are in [DEPLOY.md](DEPLOY.md). The receive address is public and pinned in [`shared/payment.js`](shared/payment.js): `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`. The page refuses to sign a transfer to anywhere else. How the payment is verified, what was audited, and what is still open are in [kb/](kb/README.md).

The optional tip line uses that same address. The Pro flag in [`web/src/site.config.js`](web/src/site.config.js) still only toggles local batch generation. It does not take a payment.

---

## Difficulty

Roughly how many keypairs a **case-sensitive suffix** takes. A letter pattern with case ignored is about `29^n` instead of `58^n` (digits do not get that discount). The web estimator and the CLI both use the per-character model, including the prefix bias below.

| Pattern length | Case-sensitive suffix | Letter, either case | ~Time @ 100k keys/s (sensitive) |
|---|---|---|---|
| 1 char | 58 | 29 | instant |
| 2 chars | 3,364 | 841 | instant |
| 3 chars | 195,112 | 24,389 | ~2 seconds |
| 4 chars | 11.3M | 707k | ~2 minutes |
| 5 chars | 656M | 20.5M | ~1.8 hours |
| 6 chars | 38.1B | 595M | ~4.4 days |
| 7 chars | 2.21T | 17.2B | ~8.5 months |

**Prefixes are harder than they look.** ~94% of Solana addresses are 44 characters, whose first character is restricted to `2`–`J`. A prefix starting with a lowercase or late-alphabet letter is ~17× rarer than the naive `1/58` estimate, and ~59× rarer than a common first character — the tools warn you and suggest suffix/anywhere instead. `J` itself is about 4× rarer than `2`–`H`, because the 44-character range ends partway through it.

The Base58 alphabet excludes `0` (zero), `O` (capital o), `I` (capital i), and `l` (lowercase L) to avoid look-alikes.

---

## License

[MIT](LICENSE) © DoradoDevs
