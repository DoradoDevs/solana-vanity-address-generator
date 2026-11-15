import { BASE58_ALPHABET } from "./base58.js";

/** First character of a 44-char Solana address is almost always one of these. */
export const COMMON_FIRST_CHARS = "23456789ABCDEFGHJ";

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

function rareFirstProb(ch) {
  // ~6% of addresses are 43 chars and can start with any Base58 glyph.
  if (ch === "1") return 1 / 250;
  return 1 / 1000;
}

function singleFirstProb(ch) {
  return COMMON_FIRST_CHARS.includes(ch) ? 1 / 17 : rareFirstProb(ch);
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

/** @returns {"common"|"uncommon"|"rare"} */
export function prefixRarity(pattern, caseSensitive) {
  const ch = pattern[0];
  if (!ch) return "rare";
  if (caseSensitive) {
    if (COMMON_FIRST_CHARS.includes(ch)) return "common";
    if (ch === "1") return "uncommon";
    return "rare";
  }
  if (
    COMMON_FIRST_CHARS.includes(ch.toUpperCase()) ||
    COMMON_FIRST_CHARS.includes(ch.toLowerCase())
  ) {
    return "common";
  }
  if (ch === "1") return "uncommon";
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
    if (rarity === "uncommon") {
      warnings.push(
        `"${text[0]}" is uncommon as a first character (about 0.4% of addresses, roughly 15× a common one such as 2–9, A–H, or J).`
      );
    } else if (rarity === "rare") {
      warnings.push(
        `"${text[0]}" is rare as a first character (about 0.1% of addresses, roughly 17× a common one such as 2–9, A–H, or J). A suffix is usually faster.`
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
