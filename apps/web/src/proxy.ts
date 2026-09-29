import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, sameDigest, sha256Hex } from './lib/access.ts';

/**
 * Optional access gate. With DASHBOARD_ACCESS_TOKEN unset (local use) everything
 * is open; when set, requests without the hashed-token cookie go to /login.
 */
export async function proxy(request: NextRequest) {
  const token = process.env['DASHBOARD_ACCESS_TOKEN'];
  if (!token) return NextResponse.next();
  const cookie = request.cookies.get(ACCESS_COOKIE)?.value ?? '';
  if (cookie && sameDigest(cookie, await sha256Hex(token))) return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'],
};
