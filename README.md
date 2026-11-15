# VanityGrinder

Generate custom **Solana vanity addresses** — wallet addresses that start with, end with, or contain a string you choose (e.g. `SoL...`, `...pump`, `cafe` anywhere). Ships in two flavors that share one grinding approach:

| | What it is | Best for |
|---|---|---|
| [`web/`](web) | A browser app. Every keypair is generated locally in Web Workers. The page may call only its own Netlify Functions, and only to verify a $1 SOL or USDC payment. | Anyone — keys stay on the device. |
| [`cli/`](cli) | A **multi-threaded** Node.js command-line grinder. | Max throughput on a workstation or server. |

Both use audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) ed25519 and never transmit, log, or persist a generated key.

---

## Security model

Vanity grinding means generating enormous numbers of real keypairs and keeping the one whose address matches. That only stays safe if the keys never leave your machine — so this tool is built around that:

- **Keys stay on the device.** The grind runs in Web Workers and does not open a connection. The page may call only `/.netlify/functions/` to quote and verify a $1 payment. No web fonts, analytics, cookies, or trackers. The Solana RPC URL stays in a Netlify environment variable.
- **Keys live in memory only.** Raw secret-key bytes are zeroed immediately after they're encoded; non-matching keys are discarded each cycle.
- **Web app hardening.** DOM is built with `textContent` only (no `innerHTML`, no XSS surface). About 60 seconds after a match the terminal wipes itself; a key that is still on screen redacts after 2 minutes. Copying a private key clears the clipboard about 60 seconds later when the browser allows it.
- **CSPRNG required.** Generation refuses to run without `crypto.getRandomValues`.

> ⚠️ **You are responsible for the private key.** Anyone who has it controls the wallet. For a high-value address, run the tool offline, save the key to a hardware wallet or password manager, and never paste it into a website.

---

## CLI (`cli/`)

```bash
cd cli
npm install
npm start
```

Interactive prompts walk you through the pattern, position (prefix / suffix / anywhere), case sensitivity, and thread count, show a difficulty estimate, then grind across all your CPU cores until it finds a match.

Requires Node.js ≥ 18. Uses `worker_threads` for parallelism and `@noble/curves` for fast ed25519 keygen.

## Web app (`web/`)

```bash
cd web
npm install
npm run dev      # UI only. Payment calls need the functions below.
npm run build    # production build to web/dist
npm run preview  # serve the production build locally
```

A grind on the real site costs $1. To exercise that locally, from the repository root, with `SOLANA_RPC_URL` and `UNLOCK_SECRET` set:

```bash
npx netlify dev
```

That serves the app and the payment functions together (port 8888). `npm run dev` by itself does not start those functions, so the quote and the payment check fail.

While `npm run dev` is running, `http://localhost:5173/?dev=1` skips the $1 payment. That query is compiled out of production builds. `npm run preview` and the Netlify deploy ignore it.

The terminal asks for the pattern first, measures your device for a couple of seconds, then asks for the $1 payment and starts grinding. Vite bundles the worker into the production build.

```bash
npm test     # difficulty math, Base58, CSP headers, CLI worker smoke test
```

Deploy on Netlify. Steps, DNS for `vanitygrinder.com`, and the `PAY_TO_ADDRESS`, `SOLANA_RPC_URL`, and `UNLOCK_SECRET` variables are in [DEPLOY.md](DEPLOY.md). The default receive address is public: `crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp`.

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

**Prefixes are harder than they look.** ~94% of Solana addresses are 44 characters, whose first character is restricted to `2`–`J`. A prefix starting with a lowercase or late-alphabet letter is ~17× rarer than the naive `1/58` estimate — the tools warn you and suggest suffix/anywhere instead.

The Base58 alphabet excludes `0` (zero), `O` (capital o), `I` (capital i), and `l` (lowercase L) to avoid look-alikes.

---

## License

[MIT](LICENSE) © DoradoDevs
