const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Time-sortable unique id (ULID-like, lowercase Crockford base32): 10 chars of millisecond
 * timestamp + 16 chars of randomness. Sorting ids sorts by creation time, which keeps
 * timelines and audit logs naturally ordered. Uses Web Crypto so it runs in core and renderer.
 */
export function newId(prefix?: string): string {
  let t = Date.now();
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
  return prefix ? `${prefix}_${time}${rand}` : `${time}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
