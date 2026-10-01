import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Viral Discovery · Review',
  description: 'Multi-source viral-video discovery and review inbox',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            🔥 Viral Discovery
          </Link>
          <nav className="topnav">
            <Link href="/">Inbox</Link>
            <Link href="/?view=saved">Saved</Link>
            <Link href="/health">Discovery health</Link>
          </nav>
          <span className="muted small">viral-video inbox</span>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
