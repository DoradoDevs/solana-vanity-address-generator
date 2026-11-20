/**
 * Reading a whole-number field. A number input whose text the browser cannot
 * parse ("4e", "-", "1e5x") reports an empty value and `validity.badInput`;
 * that is an error, not an empty field, so it never falls back to the default.
 * Pure, so it is tested without a page.
 */

/**
 * @param {{ raw: string, badInput?: boolean }} field the input's value and validity.badInput
 * @param {{ max: number, fallback: number }} limits
 * @returns {{ value: number } | { error: string }}
 */
export function readCount({ raw, badInput = false }, { max, fallback }) {
  const error = { error: `Enter a number from 1 to ${max}.` };
  if (badInput) return error;
  const text = String(raw ?? "").trim();
  if (text === "") return { value: fallback };
  if (!/^\d+$/.test(text)) return error;
  const n = Number(text);
  return n >= 1 && n <= max ? { value: n } : error;
}
