/**
 * Turns text into a URL-friendly slug: lowercase ASCII letters and digits
 * separated by single hyphens, with accents removed.
 *
 * Non-Latin scripts are not transliterated; their characters are dropped.
 *
 * @param {string} text
 * @returns {string}
 * @throws {TypeError} when `text` is not a string
 */
export function slugify(text) {
  if (typeof text !== 'string') {
    throw new TypeError('slugify expects a string');
  }
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
