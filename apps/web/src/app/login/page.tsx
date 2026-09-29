import { loginAction } from '../actions.ts';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  return (
    <div className="empty">
      <h2>Dashboard access</h2>
      <form action={loginAction} className="login">
        <input type="hidden" name="next" value={params['next'] ?? '/'} />
        <input
          name="token"
          type="password"
          autoComplete="current-password"
          placeholder="Access token"
          required
        />
        <button className="btn" type="submit">
          Enter
        </button>
      </form>
      {params['error'] ? <p className="error-inline">Incorrect token.</p> : null}
    </div>
  );
}
