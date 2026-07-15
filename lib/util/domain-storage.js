import { domainToASCII } from 'node:url';

import { sanitizeForFilename } from './safe-filename.js';

/**
 * Return the canonical ASCII hostname used to decide domain ownership.
 *
 * IDN input is converted to its lossless Punycode representation before any
 * filename sanitising happens. This keeps distinct domains such as
 * `mønchen.de` and `münchen.de` distinct instead of collapsing both to the
 * same dash-replaced display string.
 *
 * @param {string} input
 * @returns {string}
 */
export function canonicalDomainIdentity(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';

  let hostname;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    hostname = new URL(withScheme).hostname;
  } catch {
    return '';
  }

  const ascii = domainToASCII(hostname.replace(/\.+$/, ''));
  return ascii ? ascii.toLowerCase() : '';
}

/**
 * Cross-platform directory component for a domain namespace.
 * Canonicalisation happens first, so sanitising is identity-preserving for a
 * valid DNS hostname (ASCII letters/digits, dots and hyphens only).
 *
 * @param {string} input
 * @returns {string}
 */
export function domainStorageSlug(input) {
  const canonical = canonicalDomainIdentity(input);
  return canonical ? sanitizeForFilename(canonical) : '_unknown';
}
