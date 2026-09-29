import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="empty">
      <h2>Candidate not found</h2>
      <Link href="/">Back to feed</Link>
    </div>
  );
}
