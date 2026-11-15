/** Browse deep links that open this page inside a mobile wallet. */

export function phantomBrowseUrl(pageUrl) {
  const url = new URL(pageUrl);
  return `https://phantom.app/ul/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(url.origin)}`;
}

export function solflareBrowseUrl(pageUrl) {
  const url = new URL(pageUrl);
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(pageUrl)}?ref=${encodeURIComponent(url.origin)}`;
}

export function offerInAppBrowserLinks({
  userAgent = "",
  platform = "",
  maxTouchPoints = 0,
  narrow = false,
} = {}) {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return true;
  if (platform === "MacIntel" && maxTouchPoints > 1) return true;
  return Boolean(narrow);
}
