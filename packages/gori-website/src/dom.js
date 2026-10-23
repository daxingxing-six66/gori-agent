/** A checked DOM boundary so missing markup fails with a useful error.
 * @param {string} selector
 * @returns {HTMLElement}
 */
export function element(selector) {
  const node = document.querySelector(selector);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing element: ${selector}`);
  return node;
}
