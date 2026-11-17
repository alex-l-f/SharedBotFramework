// Full-page screens shown by the auth gate (outside the router): sign in,
// create the first admin, and change a temporary password.

import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api';
import { ErrorBox, Field, Notice } from '../../components/ui';
import type { User } from '../../types';

const CLI_HINT = 'python scripts/users.py add <name> --role admin';

function AuthCard({ title, subtitle, children }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">SBF</span>
          <span>SharedBotFramework</span>
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

export function LoginPage({ lost, onSignedIn }: { lost: boolean; onSignedIn: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const u = await api.auth.login(username.trim(), password);
      setPassword('');
      onSignedIn(u);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      {lost && <Notice tone="warn">Your session has ended. Sign in again to continue where you were (unsaved edits are kept).</Notice>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Username">
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || !username.trim() || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted small">Forgot your password? Ask an admin to reset it.</p>
    </AuthCard>
  );
}

export function SetupPage({ allowed, onRecheck, onDone }: { allowed: boolean; onRecheck: () => void; onDone: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ user: User; chats: number; profiles: number } | null>(null);

  if (!allowed) {
    return (
      <AuthCard title="Create the first admin" subtitle="This server has no accounts yet.">
        <p>For safety the first admin can only be created from a browser on the server&apos;s own machine. Either:</p>
        <ul>
          <li>
            open this page on the server machine (e.g. <code>http://127.0.0.1:{window.location.port || '80'}</code>), or
          </li>
          <li>
            run <code>{CLI_HINT}</code> in the SharedBotFramework folder on the server.
          </li>
        </ul>
        <button className="btn" onClick={onRecheck}>
          Check again
        </button>
      </AuthCard>
    );
  }

  if (created) {
    const { chats, profiles } = created;
    return (
      <AuthCard title="Admin created" subtitle={`You are signed in as ${created.user.display_name || created.user.username}.`}>
        {chats + profiles > 0 && (
          <Notice tone="ok">
            Chats and profiles from before accounts ({chats} chat{chats === 1 ? '' : 's'}, {profiles} profile{profiles === 1 ? '' : 's'}) now belong to you.
          </Notice>
        )}
        <p className="muted">Add the rest of the team on the Users page.</p>
        <button className="btn btn-primary" onClick={() => onDone(created.user)}>
          Continue
        </button>
      </AuthCard>
    );
  }

  const mismatch = confirm.length > 0 && confirm !== password;
  const tooShort = password.length > 0 && password.length < 8;
  const submit = async () => {
    if (busy || mismatch || tooShort || !username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const { adopted, ...user } = await api.auth.setup({ username: username.trim(), password, display_name: displayName.trim() });
      setCreated({ user, chats: adopted?.chats ?? 0, profiles: adopted?.profiles ?? 0 });
    } catch (e) {
      setError(e);
      // Someone else finished setup meanwhile: show the sign-in page.
      if (e instanceof ApiError && e.status === 409) onRecheck();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Create the first admin" subtitle="This server has no accounts yet. The first account is an admin who can add everyone else.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Username" hint="2–40 characters: lowercase letters, digits, . _ -">
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} />
        </Field>
        <Field label="Display name">
          <input value={displayName} placeholder="e.g. Ada Lovelace" onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Password" hint={tooShort ? <span className="text-danger">At least 8 characters</span> : 'At least 8 characters'}>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Repeat password" hint={mismatch ? <span className="text-danger">Does not match</span> : undefined}>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <p className="muted small">Chats and profiles created before accounts existed will belong to this admin.</p>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" className="btn btn-primary auth-submit" disabled={busy || mismatch || tooShort || !username.trim() || !password || !confirm}>
          {busy ? 'Creating…' : 'Create admin and sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

/** A temporary password must be changed before anything else. */
export function ForcedPasswordPage({ user, onDone, onSignOut }: { user: User; onDone: () => Promise<void>; onSignOut: () => void }) {
  return (
    <AuthCard
      title="Choose your password"
      subtitle={`Hi ${user.display_name || user.username} — you signed in with a temporary password. Choose your own to continue.`}
    >
      <PasswordForm submitLabel="Set password and continue" autoFocus onChanged={() => void onDone()} />
      <button className="btn btn-ghost btn-sm" onClick={onSignOut}>
        Sign out
      </button>
    </AuthCard>
  );
}

/** Current + new password (twice). Used here and on the Account page. */
export function PasswordForm({
  submitLabel = 'Change password',
  autoFocus,
  onChanged,
}: {
  submitLabel?: string;
  autoFocus?: boolean;
  onChanged: (otherSessionsEnded: number) => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== next;
  const tooShort = next.length > 0 && next.length < 8;
  const submit = async () => {
    if (busy || mismatch || tooShort || !current || !next) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged(r.other_sessions_ended);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="password-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Current password">
        <input type="password" autoFocus={autoFocus} autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </Field>
      <Field label="New password" hint={tooShort ? <span className="text-danger">At least 8 characters</span> : 'At least 8 characters'}>
        <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="Repeat new password" hint={mismatch ? <span className="text-danger">Does not match</span> : undefined}>
        <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      {error != null && <ErrorBox error={error} />}
      <button type="submit" className="btn btn-primary" disabled={busy || mismatch || tooShort || !current || !next || !confirm}>
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
