/**
 * How a pattern is drawn in an address: where it sits in a found address,
 * and the placeholder address the generator previews while a pattern is
 * typed. Pure functions, so they are tested without a page.
 */

/** Base58 is ASCII, so lower-casing is the same fold the matcher uses (A to Z only). */
const fold = (text, caseSensitive) => (caseSensitive ? text : text.toLowerCase());

/**
 * The [start, end) of the pattern in a found address, as the grind matched it,
 * or null if it is not there. Either end prefers the start, as the matcher does.
 * @param {string} address
 * @param {string} pattern
 * @param {"prefix"|"suffix"|"prefix-or-suffix"|"anywhere"} position
 * @param {boolean} caseSensitive
 * @returns {[number, number] | null}
 */
export function matchRange(address, pattern, position, caseSensitive) {
  if (!pattern || pattern.length > address.length) return null;
  const a = fold(address, caseSensitive);
  const p = fold(pattern, caseSensitive);
  const start = a.startsWith(p) ? [0, p.length] : null;
  const end = a.endsWith(p) ? [a.length - p.length, a.length] : null;
  switch (position) {
    case "prefix":
      return start;
    case "suffix":
      return end;
    case "prefix-or-suffix":
      return start ?? end;
    case "anywhere": {
      const at = a.indexOf(p);
      return at === -1 ? null : [at, at + p.length];
    }
    default:
      return null;
  }
}

/**
 * An address split into the parts around a match: [before, match, after].
 * With no match the whole address is `before`.
 */
export function splitAtMatch(address, range) {
  if (!range) return [address, "", ""];
  return [address.slice(0, range[0]), address.slice(range[0], range[1]), address.slice(range[1])];
}

/**
 * A 44-character placeholder address with the pattern where it would land:
 * [dots, pattern, dots]. Either end shows the end, the usual case; anywhere
 * shows it in the middle. Never longer than `width`.
 */
export function previewParts(pattern, position, width = 44) {
  const gap = Math.max(0, width - pattern.length);
  const dots = (n) => "·".repeat(n);
  if (position === "prefix") return ["", pattern, dots(gap)];
  if (position === "anywhere") {
    const left = Math.floor(gap / 2);
    return [dots(left), pattern, dots(gap - left)];
  }
  return [dots(gap), pattern, ""];
}
