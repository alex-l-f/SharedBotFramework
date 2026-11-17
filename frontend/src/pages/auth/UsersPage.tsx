import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge, EmptyState, ErrorBox, Field, Loading, Modal, Notice, PageHeader } from '../../components/ui';
import { ROLE_LABEL, useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/util';
import { ROLES, type Role, type User } from '../../types';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/;
const CLI = 'python scripts/users.py';

/** A random temporary password (no look-alike characters). */
export function generatePassword(length = 14): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function UserStatus({ u }: { u: User }) {
  if (u.disabled) return <Badge tone="danger">disabled</Badge>;
  if (u.must_change_password) return <Badge tone="warn" title="Must choose a new password at the next sign-in">temporary password</Badge>;
  return <Badge tone="ok">active</Badge>;
}

/** /users — accounts (admins only). */
export function UsersPage() {
  const { user: me, authOn, can } = useAuth();
  const users = useLoad(() => (authOn && can('admin') ? api.users.list() : Promise.resolve([] as User[])), [authOn]);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  if (!authOn)
    return (
      <div className="page">
        <PageHeader title="Users" />
        <Notice>Accounts are off on this server (SBF_AUTH=off), so there are no users to manage.</Notice>
      </div>
    );
  if (!can('admin'))
    return (
      <div className="page">
        <PageHeader title="Users" />
        <Notice tone="warn">Only admins manage accounts. <Link to="/account">Your account</Link></Notice>
      </div>
    );

  const act = async (u: User, fn: () => Promise<unknown>, done?: string) => {
    setBusy(u.id);
    setError(null);
    setInfo(null);
    try {
      await fn();
      if (done) setInfo(done);
      users.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  const setRole = (u: User, role: Role) => {
    if (u.id === me.id && role !== 'admin' && !window.confirm(`Make yourself ${role}? You will lose access to this page.`)) return;
    void act(u, () => api.users.update(u.id as number, { role }), `${u.username} is now ${ROLE_LABEL[role].toLowerCase()}.`);
  };
  const rename = (u: User) => {
    const name = window.prompt(`Display name of ${u.username}`, u.display_name);
    if (name == null || name.trim() === u.display_name) return;
    void act(u, () => api.users.update(u.id as number, { display_name: name.trim() }));
  };
  const toggleDisabled = (u: User) => {
    if (!u.disabled && !window.confirm(`Disable ${u.username}? They are signed out everywhere and can't sign in until enabled again. Their chats are kept.`))
      return;
    void act(u, () => api.users.update(u.id as number, { disabled: !u.disabled }), `${u.username} ${u.disabled ? 'enabled' : 'disabled'}.`);
  };
  const signOutEverywhere = (u: User) => {
    if (!window.confirm(`Sign ${u.username} out of every browser${u.id === me.id ? ' (except this one)' : ''}?`)) return;
    void act(
      u,
      async () => {
        const r = await api.users.signOut(u.id as number);
        setInfo(`Ended ${r.ended} session(s) of ${u.username}.`);
      },
    );
  };
  const remove = (u: User) => {
    if (!window.confirm(`Delete the account ${u.username}? Their chats and profiles stay, without an owner. This cannot be undone.`)) return;
    void act(u, () => api.users.remove(u.id as number), `${u.username} deleted.`);
  };

  return (
    <div className="page page-wide">
      <PageHeader
        title="Users"
        subtitle={
          <>
            Accounts and roles. Viewers read and chat; editors also change definitions and data and run things; admins also manage settings and
            accounts. From a terminal on the server: <code>{CLI} add &lt;name&gt; --role admin</code>.
          </>
        }
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add user
          </button>
        }
      />
      {info && <Notice tone="ok">{info}</Notice>}
      {error != null && <ErrorBox error={error} title="Not done" />}
      {users.loading && !users.data && <Loading />}
      {users.error != null && <ErrorBox error={users.error} onRetry={users.reload} />}
      {users.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Display name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th className="num">Sessions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => {
                const self = u.id === me.id;
                const disabled = busy === u.id;
                return (
                  <tr key={u.id} className={u.disabled ? 'row-dim' : undefined}>
                    <td>
                      <code>{u.username}</code> {self && <Badge tone="accent">you</Badge>}
                    </td>
                    <td className="nowrap">
                      <button type="button" className="link-btn" title="Change display name" onClick={() => rename(u)}>
                        {u.display_name || <span className="muted">(none)</span>}
                      </button>
                    </td>
                    <td>
                      <select value={u.role} disabled={disabled} onChange={(e) => setRole(u, e.target.value as Role)} style={{ width: 'auto' }}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <UserStatus u={u} />
                    </td>
                    <td className="small muted nowrap">{u.last_login ? fmtDateTime(u.last_login) : 'never'}</td>
                    <td className="num">{u.sessions ?? 0}</td>
                    <td className="nowrap num">
                      <span className="row gap-sm user-actions">
                        <button className="btn btn-sm" disabled={disabled} onClick={() => setResetting(u)}>
                          Reset password…
                        </button>
                        <button className="btn btn-sm" disabled={disabled || !u.sessions} onClick={() => signOutEverywhere(u)} title="Sign out everywhere: end all of their sessions">
                          Sign out
                        </button>
                        {!self && (
                          <button className="btn btn-sm" disabled={disabled} onClick={() => toggleDisabled(u)}>
                            {u.disabled ? 'Enable' : 'Disable'}
                          </button>
                        )}
                        {!self && (
                          <button className="btn btn-sm btn-danger-ghost" disabled={disabled} onClick={() => remove(u)}>
                            Delete
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {users.data.length === 0 && <EmptyState>No users.</EmptyState>}
        </div>
      )}

      {adding && (
        <AddUserModal
          taken={(users.data ?? []).map((u) => u.username)}
          onClose={() => setAdding(false)}
          onCreated={(u, password, temporary) => {
            setAdding(false);
            users.reload();
            setError(null);
            setInfo(
              `Created ${u.username} (${ROLE_LABEL[u.role].toLowerCase()}). Give them their ${temporary ? 'temporary ' : ''}password: ${password}${temporary ? ' — they choose their own at the first sign-in.' : ''}`,
            );
          }}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(password, temporary) => {
            const u = resetting;
            setResetting(null);
            users.reload();
            setError(null);
            setInfo(`New ${temporary ? 'temporary ' : ''}password of ${u.username}: ${password}. They were signed out everywhere.`);
          }}
        />
      )}
    </div>
  );
}

function PasswordField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Password" hint={value.length > 0 && value.length < 8 ? <span className="text-danger">At least 8 characters</span> : 'At least 8 characters. You see it once, here.'}>
      <span className="row gap-sm">
        <input className="mono grow" value={value} autoComplete="off" spellCheck={false} onChange={(e) => onChange(e.target.value)} />
        <button type="button" className="btn btn-sm" onClick={() => onChange(generatePassword())}>
          Generate
        </button>
      </span>
    </Field>
  );
}

function AddUserModal({
  taken,
  onClose,
  onCreated,
}: {
  taken: string[];
  onClose: () => void;
  onCreated: (u: User, password: string, temporary: boolean) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [password, setPassword] = useState(() => generatePassword());
  const [temporary, setTemporary] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const nameProblem = !username
    ? 'Required'
    : !USERNAME_RE.test(username)
      ? '2–40 characters: lowercase letters, digits, . _ - (starting with a letter or digit)'
      : taken.includes(username)
        ? 'Taken'
        : null;
  const ok = !nameProblem && password.length >= 8;

  const submit = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const u = await api.users.create({ username, password, role, display_name: displayName.trim(), must_change_password: temporary });
      onCreated(u, password, temporary);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add user"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!ok || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Username" hint={nameProblem && username ? <span className="text-danger">{nameProblem}</span> : 'Used to sign in; lowercase.'}>
          <input className="mono" autoFocus autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value.trim().toLowerCase())} />
        </Field>
        <Field label="Display name">
          <input value={displayName} placeholder="e.g. Grace Hopper" onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </Field>
        <PasswordField value={password} onChange={setPassword} />
        <label className="check">
          <input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} />
          Must change it at the first sign-in
        </label>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (password: string, temporary: boolean) => void }) {
  const [password, setPassword] = useState(() => generatePassword());
  const [temporary, setTemporary] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (password.length < 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.users.resetPassword(user.id as number, password, temporary);
      onDone(password, temporary);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Reset password — ${user.username}`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={password.length < 8 || busy} onClick={() => void submit()}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </>
      }
    >
      <p className="muted small">They are signed out everywhere; their chats and profiles are untouched.</p>
      <PasswordField value={password} onChange={setPassword} />
      <label className="check">
        <input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} />
        Must change it at the next sign-in
      </label>
      {error != null && <ErrorBox error={error} />}
    </Modal>
  );
}
