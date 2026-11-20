import { BASE58_ALPHABET } from "./base58.js";

/**
 * The exact share of 32-byte keys whose Base58 address starts with each
 * character. An address starts with "1" when the key's first byte is zero.
 * Otherwise it is 43 or 44 characters long and its first character is the
 * leading Base58 digit of the key read as a number, so the share of each
 * character is a count of 256-bit values, done here in whole numbers.
 *
 * About 94% of addresses are 44 characters and begin with 2 to H, each a
 * little under 6% of all addresses. The 44-character range runs out partway
 * through J, which gets about 1.4%. Every other character begins only
 * 43-character addresses, at about 0.1% each.
 */
function firstCharShares() {
  const total = 1n << 256n;
  const floor = 1n << 248n; // smallest value whose first byte is not zero
  const counts = new Map([["1", floor]]);
  for (const length of [43n, 44n]) {
    const unit = 58n ** (length - 1n);
    for (let digit = 1n; digit < 58n; digit++) {
      const from = digit * unit > floor ? digit * unit : floor;
      const to = (digit + 1n) * unit < total ? (digit + 1n) * unit : total;
      if (to <= from) continue;
      const ch = BASE58_ALPHABET[Number(digit)];
      counts.set(ch, (counts.get(ch) ?? 0n) + (to - from));
    }
  }
  const scale = 10n ** 15n;
  return new Map([...counts].map(([ch, count]) => [ch, Number((count * scale) / total) / Number(scale)]));
}

const FIRST_CHAR_SHARE = firstCharShares();

/** A first character that opens about 1 address in 17. */
const COMMON_SHARE = FIRST_CHAR_SHARE.get("5");

/** First characters that each open about 1 address in 17: 2 to 9 and A to H. */
export const COMMON_FIRST_CHARS = BASE58_ALPHABET.split("")
  .filter((ch) => FIRST_CHAR_SHARE.get(ch) > COMMON_SHARE / 2)
  .join("");

/** Typical Solana address length. Used for the "anywhere" window count. */
export const ADDRESS_LENGTH = 44;

/**
 * Conservative browser rate per Web Worker, in keys/second.
 * Node on a laptop is often a bit higher; the grinder replaces this with
 * the measured rate once a run is underway.
 */
export const DEFAULT_KEYS_PER_THREAD = 5000;

export function validatePattern(pattern) {
  const bad = [];
  const seen = new Set();
  for (const ch of pattern) {
    if (!BASE58_ALPHABET.includes(ch) && !seen.has(ch)) {
      seen.add(ch);
      bad.push(ch);
    }
  }
  return bad;
}

function singleFirstProb(ch) {
  return FIRST_CHAR_SHARE.get(ch) ?? 0;
}

/**
 * Probability that a random Solana address starts with this character.
 * Case-insensitive letter prefixes add the other case when that glyph
 * exists in Base58. Digits are not doubled.
 */
export function firstCharProbability(ch, caseSensitive) {
  if (caseSensitive) return singleFirstProb(ch);
  const upper = ch.toUpperCase();
  const lower = ch.toLowerCase();
  if (upper === lower) return singleFirstProb(ch);
  let p = 0;
  if (BASE58_ALPHABET.includes(upper)) p += singleFirstProb(upper);
  if (BASE58_ALPHABET.includes(lower)) p += singleFirstProb(lower);
  return p;
}

/** Probability of a uniform (non-prefix) Base58 position matching `ch`. */
export function uniformCharProbability(ch, caseSensitive) {
  if (caseSensitive) return 1 / 58;
  const upper = ch.toUpperCase();
  const lower = ch.toLowerCase();
  if (
    upper !== lower &&
    BASE58_ALPHABET.includes(upper) &&
    BASE58_ALPHABET.includes(lower)
  ) {
    return 2 / 58;
  }
  return 1 / 58;
}

/**
 * How a prefix's first character compares with a common one.
 * "uncommon" is 1 and J, which open a few addresses in a thousand.
 * @returns {"common"|"uncommon"|"rare"}
 */
export function prefixRarity(pattern, caseSensitive) {
  const ch = pattern[0];
  if (!ch) return "rare";
  const share = firstCharProbability(ch, caseSensitive);
  if (share > COMMON_SHARE / 2) return "common";
  if (share > COMMON_SHARE / 20) return "uncommon";
  return "rare";
}

function product(chars, mapFn) {
  let p = 1;
  for (const ch of chars) p *= mapFn(ch);
  return p;
}

/**
 * Expected number of keypairs for a match.
 * Returns Infinity when the pattern cannot appear in a Solana address.
 */
export function estimateDifficulty(pattern, position, caseSensitive) {
  if (!pattern || pattern.length > ADDRESS_LENGTH) return Infinity;
  if (validatePattern(pattern).length > 0) return Infinity;

  const suffixP = product(pattern, (ch) => uniformCharProbability(ch, caseSensitive));
  const prefixP =
    firstCharProbability(pattern[0], caseSensitive) *
    product(pattern.slice(1), (ch) => uniformCharProbability(ch, caseSensitive));

  let expected;
  switch (position) {
    case "suffix":
      expected = 1 / suffixP;
      break;
    case "prefix":
      expected = 1 / prefixP;
      break;
    case "prefix-or-suffix":
      expected = 1 / (prefixP + suffixP);
      break;
    case "anywhere": {
      const windows = Math.max(1, ADDRESS_LENGTH - pattern.length + 1);
      expected = 1 / suffixP / windows;
      break;
    }
    default:
      throw new Error(`Unknown position: ${position}`);
  }

  if (!Number.isFinite(expected) || expected <= 0) return Infinity;
  return Math.max(1, Math.round(expected));
}

export function formatAttempts(n) {
  if (!Number.isFinite(n)) return "∞";
  const rounded = Math.round(n);
  if (Math.abs(rounded) < 1_000_000) return rounded.toLocaleString("en-US");
  const units = [
    [1e15, "Q"],
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
  ];
  for (const [scale, label] of units) {
    if (rounded >= scale) {
      const digits = rounded >= scale * 10 ? 1 : 2;
      return (rounded / scale).toFixed(digits).replace(/\.0+$/, "") + label;
    }
  }
  return rounded.toLocaleString("en-US");
}

/** Planning duration. Numeric results get a leading tilde; words do not. */
export function formatEstimate(seconds) {
  const time = formatDuration(seconds, { estimate: true });
  return /^\d/.test(time) ? `~${time}` : time;
}

/**
 * @param {number} seconds
 * @param {{ estimate?: boolean }} [opts]
 */
export function formatDuration(seconds, opts = {}) {
  if (!Number.isFinite(seconds)) return "not practical";
  if (opts.estimate && seconds < 1) return "under a second";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${m}m`;
  }
  if (s < 86400 * 60) {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return `${d}d ${h}h`;
  }
  const years = seconds / (86400 * 365.25);
  if (years < 100) return `${Math.max(1, Math.round(years))} years`;
  return "longer than a lifetime";
}

/**
 * The chance that a search has found at least one match after `attempts`
 * keys, when one match is expected every `expected` keys:
 * 1 − (1 − 1/expected)^attempts. A search for a pattern has no fixed length,
 * so this is what the page shows instead of a time: a probability, never a
 * promise. Each key is independent, so after a match the count starts again.
 */
export function foundByNowProbability(attempts, expected) {
  if (!Number.isFinite(expected) || expected <= 0 || !(attempts > 0)) return 0;
  if (expected <= 1) return 1;
  return -Math.expm1(attempts * Math.log1p(-1 / expected));
}

/**
 * The number of keys after which a search has found a match with chance `p`,
 * the inverse of foundByNowProbability. A horizon in attempts, never a time:
 * how fast a device gets there is not known in advance.
 */
export function attemptsForChance(p, expected) {
  if (!Number.isFinite(expected) || expected <= 0 || !(p > 0) || !(p < 1)) return Infinity;
  if (expected <= 1) return 1;
  return Math.ceil(Math.log1p(-p) / Math.log1p(-1 / expected));
}

/**
 * A probability as a short figure: whole percents, one decimal under 10%, and
 * bounds at the ends so a tiny chance never reads as 0% and a near-certain one
 * never reads as 100%. Rounded down, so the figure never overstates the chance.
 */
export function formatProbability(p) {
  if (!(p > 0)) return "0%";
  if (p < 0.001) return "<0.1%";
  if (p >= 0.999) return ">99.9%";
  if (p < 0.1) return `${(Math.floor(p * 1000) / 10).toFixed(1)}%`;
  return `${Math.floor(p * 100)}%`;
}

/** "About 1 in N" for the odds of one key matching. Whole numbers with separators until they get long. */
export function formatOdds(expected) {
  if (!Number.isFinite(expected)) return "not possible";
  if (expected < 1e12) return `About 1 in ${Math.round(expected).toLocaleString("en-US")}`;
  return `About 1 in ${formatAttempts(expected)}`;
}

function caseFoldHelps(pattern) {
  for (const ch of pattern) {
    if (uniformCharProbability(ch, false) > 1 / 58 + 1e-12) return true;
  }
  return false;
}

/**
 * Planning view shared by the page estimator, the terminal, and the CLI.
 */
export function describeJob({
  pattern,
  position,
  caseSensitive,
  threads,
  keysPerThread = DEFAULT_KEYS_PER_THREAD,
}) {
  const warnings = [];
  const text = typeof pattern === "string" ? pattern : "";
  const bad = text ? validatePattern(text) : [" "];

  if (!text) warnings.push("Enter a pattern.");
  else if (text.length > ADDRESS_LENGTH) {
    warnings.push("Solana addresses are at most 44 characters.");
  } else if (bad.length > 0 && text) {
    warnings.push(
      `Invalid Base58 character(s): ${bad.map((c) => `'${c}'`).join(", ")}. Allowed glyphs omit 0, O, I, and l.`
    );
  }

  const attempts =
    !text || text.length > ADDRESS_LENGTH || (text && validatePattern(text).length > 0)
      ? Infinity
      : estimateDifficulty(text, position, caseSensitive);

  const threadCount = Math.max(1, threads || 1);
  const perThread = Math.max(1, keysPerThread || DEFAULT_KEYS_PER_THREAD);
  const rate = threadCount * perThread;
  const seconds = Number.isFinite(attempts) ? attempts / rate : Infinity;

  let rarity = null;
  if (text && position === "prefix" && validatePattern(text).length === 0) {
    rarity = prefixRarity(text, caseSensitive);
    if (rarity !== "common") {
      const share = firstCharProbability(text[0], caseSensitive);
      const odds = `about ${(share * 100).toFixed(1)}% of addresses, roughly ${Math.round(COMMON_SHARE / share)}× rarer than a common one such as 2–9 or A–H`;
      warnings.push(
        rarity === "uncommon"
          ? `"${text[0]}" is uncommon as a first character (${odds}).`
          : `"${text[0]}" is rare as a first character (${odds}). A suffix is usually faster.`
      );
    }
  }

  if (
    text &&
    !caseSensitive &&
    validatePattern(text).length === 0 &&
    !caseFoldHelps(text)
  ) {
    warnings.push(
      "Ignoring case does not shorten this pattern. None of these characters has a second Base58 case."
    );
  }

  if (Number.isFinite(seconds) && seconds > 86400 * 365) {
    warnings.push(
      "At the assumed rate this is more than a year. A shorter pattern finishes much sooner."
    );
  } else if (Number.isFinite(seconds) && seconds > 86400) {
    warnings.push("At the assumed rate this is more than a day of grinding.");
  }

  return { attempts, seconds, rate, rarity, warnings };
}
