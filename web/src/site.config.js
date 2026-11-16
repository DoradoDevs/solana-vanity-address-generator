/**
 * Public site settings baked into the static build.
 *
 * The payment receiver is pinned in shared/payment.js, for the page and
 * the functions alike. Never put a private key, seed, RPC URL, or
 * UNLOCK_SECRET in this file.
 */
export const siteConfig = {
  siteName: "VanityGrinder",
  siteUrl: "https://vanitygrinder.com",
  repositoryUrl: "https://github.com/DoradoDevs/solana-vanity-address-generator",

  /** Optional public tip address. The same address as the pinned payee. */
  tipAddress: "crimeKXXM4ERRWcHZvetHPTz9BwoWYyfYzNjzD4THCp",

  pro: {
    /**
     * false: one address per run, and long patterns show a notice.
     * true: the terminal can grind several matches in one run.
     * Still local. There is no checkout behind this flag.
     */
    enabled: false,
    /** Lengths above this show the Pro notice while Pro is off. */
    freeMaxPatternLength: 5,
    /** Upper bound on matches per run when Pro is on. */
    maxBatch: 10,
  },
};
