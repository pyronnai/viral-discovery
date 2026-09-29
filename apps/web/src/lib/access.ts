/**
 * Minimal access gate for the internal dashboard (not a user system). When
 * DASHBOARD_ACCESS_TOKEN is set, a correct token sets an httpOnly cookie holding
 * SHA-256(token); the proxy compares hashes. Web Crypto only (runs in the proxy).
 */
export const ACCESS_COOKIE = 'vd_access';

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-length hex digests. */
export function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether a submitted token matches the configured one (compares hashes). */
export async function tokenMatches(submitted: string, configured: string): Promise<boolean> {
  return sameDigest(await sha256Hex(submitted), await sha256Hex(configured));
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
