import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Viral Discovery · Review',
  description: 'Internal review dashboard for viral/funny video candidates',
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
          <span className="muted small">internal review</span>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
