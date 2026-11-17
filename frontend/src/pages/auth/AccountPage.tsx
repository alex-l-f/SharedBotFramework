import { useState } from 'react';
import { api } from '../../api';
import { ErrorBox, Field, Notice, PageHeader } from '../../components/ui';
import { ROLE_LABEL, useAuth } from '../../lib/auth';
import { fmtDateTime, pluralize } from '../../lib/util';
import { PasswordForm } from './SignInPages';

const ROLE_HELP = {
  viewer: 'You can read everything, chat with systems, plan simulations and export bundles.',
  editor: 'You can also create, edit and delete definitions and data, run retrievers and simulations, and import bundles.',
  admin: 'You can do everything, including runtime settings and accounts.',
};

/** /account — one's own display name and password. */
export function AccountPage() {
  const { user, authOn, refresh } = useAuth();
  const [name, setName] = useState(user.display_name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState<string | null>(null);

  if (!authOn) {
    return (
      <div className="page">
        <PageHeader title="Account" />
        <Notice>
          Accounts are off on this server (<code>SBF_AUTH=off</code>): everyone using it acts as a local admin, and there is nothing to sign in to.
          Start the server without <code>SBF_AUTH=off</code> to use accounts; the first admin is created on the sign-in page or with{' '}
          <code>python scripts/users.py add &lt;name&gt; --role admin</code>.
        </Notice>
      </div>
    );
  }

  const saveName = async () => {
    if (busy || name.trim() === user.display_name) return;
    setBusy(true);
    setError(null);
    try {
      await api.auth.updateMe(name.trim());
      await refresh();
      setFlash('Saved');
      setTimeout(() => setFlash(null), 2000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Account" subtitle={`Signed in as ${user.username}`} />
      <div className="grid-2 account-grid">
        <section className="panel">
          <h2 className="panel-title">Profile</h2>
          <Field label="Username" hint="Shown in “saved by” and on chats you own. Only an admin can change it (by recreating the account).">
            <input value={user.username} disabled />
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <Field label="Display name" hint="How others see you (presence, lists).">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="row gap-sm">
              <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === user.display_name}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              {flash && <span className="flash">{flash}</span>}
            </div>
          </form>
          {error != null && <ErrorBox error={error} title="Not saved" />}
          <div className="subsection-title">Role: {ROLE_LABEL[user.role]}</div>
          <p className="muted small">{ROLE_HELP[user.role]} Ask an admin if you need more.</p>
          {user.last_login && <p className="muted small">Last sign-in {fmtDateTime(user.last_login)}</p>}
        </section>
        <section className="panel">
          <h2 className="panel-title">Password</h2>
          <p className="muted small">Changing it signs you out on your other devices and browsers.</p>
          {pwDone && <Notice tone="ok">{pwDone}</Notice>}
          <PasswordForm
            onChanged={(ended) =>
              setPwDone(`Password changed.${ended ? ` Signed out ${pluralize(ended, 'other session')}.` : ''}`)
            }
          />
        </section>
      </div>
    </div>
  );
}
