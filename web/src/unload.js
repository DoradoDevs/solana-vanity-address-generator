/**
 * Whether closing or reloading the tab should ask first. A running grind, an
 * unsaved key, and the answer to a spend on its way exist only in this tab:
 * any one of them is reason to ask. main.js passes every beforeunload event
 * here with the page's state.
 * @param {{ preventDefault(): void, returnValue?: string }} event
 * @param {{ grinding: boolean, holdingKey: boolean, spending: boolean }} state
 * @returns {boolean} true when the browser was told to ask
 */
export function confirmUnload(event, { grinding, holdingKey, spending }) {
  if (!grinding && !holdingKey && !spending) return false;
  event.preventDefault();
  event.returnValue = "";
  return true;
}
