# VanityGrinder

Generate custom **Solana vanity addresses** — wallet addresses that start with, end with, or contain a string you choose (e.g. `SoL...`, `...pump`, `cafe` anywhere). Ships in two flavors that share one grinding approach:

| | What it is | Best for |
|---|---|---|
| [`web/`](web) | A **zero-network** browser app. Every keypair is generated locally in Web Workers behind a strict Content-Security-Policy (`connect-src 'none'`). | Anyone — no install, keys never leave the tab. |
| [`cli/`](cli) | A **multi-threaded** Node.js command-line grinder. | Max throughput on a workstation or server. |

Both use audited [`@noble/curves`](https://github.com/paulmillr/noble-curves) ed25519 and never transmit, log, or persist a generated key.

---

## Security model

Vanity grinding means generating enormous numbers of real keypairs and keeping the one whose address matches. That only stays safe if the keys never leave your machine — so this tool is built around that:

- **100% local generation.** No servers, no API calls. The web app *enforces* this with a CSP that blocks every outbound connection (`connect-src 'none'`) and ships **no web fonts, analytics, cookies, or trackers**.
- **Keys live in memory only.** Raw secret-key bytes are zeroed immediately after they're encoded; non-matching keys are discarded each cycle.
- **Web app hardening.** DOM is built with `textContent` only (no `innerHTML`, no XSS surface); the on-screen private key auto-redacts after 2 minutes; the clipboard auto-clears 60 seconds after you copy.
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
npm run dev      # bundles the worker, then starts the Vite dev server
npm run build    # production build to web/dist
npm run preview  # serve the production build locally
```

Open the printed localhost URL. The interface is a retro terminal — enter a pattern and it grinds locally in Web Workers. Deploy `web/dist` to any static host; `web/public/_headers` ships the production security headers (CSP, `X-Frame-Options`, etc.) for Netlify/Cloudflare/Vercel-style hosts.

---

## Difficulty

Roughly how many keypairs you'll grind for a case-insensitive suffix/anywhere match:

| Pattern length | Avg. attempts | ~Time @ 100k keys/s |
|---|---|---|
| 1 char | 58 | instant |
| 2 chars | 3,364 | instant |
| 3 chars | 195,112 | ~2 seconds |
| 4 chars | 11.3M | ~2 minutes |
| 5 chars | 656M | ~1.8 hours |
| 6 chars | 38B | ~4.4 days |
| 7+ chars | 2.2T+ | months+ |

**Prefixes are harder than they look.** ~94% of Solana addresses are 44 characters, whose first character is restricted to `2`–`J`. A prefix starting with a lowercase or late-alphabet letter is ~17× rarer than the naive `1/58` estimate — the tools warn you and suggest suffix/anywhere instead.

The Base58 alphabet excludes `0` (zero), `O` (capital o), `I` (capital i), and `l` (lowercase L) to avoid look-alikes.

---

## License

[MIT](LICENSE) © DoradoDevs
