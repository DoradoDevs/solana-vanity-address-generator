function fold(code) {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

function equalsFoldAt(address, start, pattern) {
  for (let i = 0; i < pattern.length; i++) {
    if (fold(address.charCodeAt(start + i)) !== fold(pattern.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function includesFold(address, pattern) {
  const limit = address.length - pattern.length;
  for (let i = 0; i <= limit; i++) {
    if (equalsFoldAt(address, i, pattern)) return true;
  }
  return false;
}

/**
 * @param {string} address
 * @param {string} pattern
 * @param {"prefix"|"suffix"|"prefix-or-suffix"|"anywhere"} position
 * @param {boolean} caseSensitive
 */
export function matchesAddress(address, pattern, position, caseSensitive) {
  if (!pattern || pattern.length > address.length) return false;

  if (caseSensitive) {
    switch (position) {
      case "prefix":
        return address.startsWith(pattern);
      case "suffix":
        return address.endsWith(pattern);
      case "prefix-or-suffix":
        return address.startsWith(pattern) || address.endsWith(pattern);
      case "anywhere":
        return address.includes(pattern);
      default:
        return false;
    }
  }

  switch (position) {
    case "prefix":
      return equalsFoldAt(address, 0, pattern);
    case "suffix":
      return equalsFoldAt(address, address.length - pattern.length, pattern);
    case "prefix-or-suffix":
      return (
        equalsFoldAt(address, 0, pattern) ||
        equalsFoldAt(address, address.length - pattern.length, pattern)
      );
    case "anywhere":
      return includesFold(address, pattern);
    default:
      return false;
  }
}
