/**
 * Public site settings baked into the static build.
 *
 * Edit this file, then rebuild. The browser cannot fetch a config later:
 * Content-Security-Policy connect-src 'none' blocks every network call.
 *
 * NEVER put a private key, seed phrase, API key, or payment secret here.
 * tipAddress is a public Solana receive address only. Leave it "" until
 * you set your own — a blank value is hidden, so visitors cannot send
 * SOL to a placeholder.
 */
export const siteConfig = {
  siteName: "VanityGrinder",
  siteUrl: "https://vanitygrinder.com",
  repositoryUrl: "https://github.com/DoradoDevs/solana-vanity-address-generator",

  /** Public Solana address. "" keeps the tip control hidden. */
  tipAddress: "",

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
