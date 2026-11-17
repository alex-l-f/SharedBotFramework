import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useRouteError, isRouteErrorResponse, Link, useLocation } from 'react-router-dom';
import { api } from '../api';
import { ROLE_LABEL, useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import type { Role } from '../types';

// `accounts`: only with accounts on (with them off, everyone is the local admin).
const NAV: { to: string; label: string; icon: string; role?: Role; accounts?: boolean }[] = [
  { to: '/agents', label: 'Agents', icon: '◉' },
  { to: '/systems', label: 'Systems', icon: '⬡' },
  { to: '/chat', label: 'Chat', icon: '✎' },
  { to: '/links', label: 'Links', icon: '↗', role: 'editor' },
  { to: '/safety', label: 'Safety', icon: '⛨' },
  { to: '/memory', label: 'Memory', icon: '◈' },
  { to: '/data', label: 'Data', icon: '▤' },
  { to: '/simulations', label: 'Simulations', icon: '↻' },
  { to: '/transfer', label: 'Import / Export', icon: '⇅' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
  { to: '/users', label: 'Users', icon: '☺', role: 'admin', accounts: true },
];

export function Layout() {
  const meta = useLoad(api.meta, []);
  const { can, authOn } = useAuth();
  return (
    <div className="app">
      <nav className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">SBF</span>
          <span className="brand-name">SharedBotFramework</span>
        </Link>
        <ul className="nav">
          {NAV.filter((n) => (!n.accounts || authOn) && (!n.role || can(n.role))).map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                <span className="nav-icon" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <UserChip />
        <div className="sidebar-footer">
          {meta.data ? (
            <span title={`workspace: ${meta.data.workspace}\ndata: ${meta.data.data}`}>v{meta.data.version}</span>
          ) : meta.error ? (
            <span className="text-danger" title="GET /api/meta failed">backend unreachable</span>
          ) : null}
        </div>
      </nav>
      <main className="main">
        {meta.data && <MetaBanner errors={meta.data.errors} onRecheck={meta.reload} />}
        <Outlet />
      </main>
    </div>
  );
}

/** The signed-in user (display name + role) with Account and Sign out. */
function UserChip() {
  const { user, authOn, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  if (!authOn) {
    return (
      <div className="user-chip local" title="Accounts are off (SBF_AUTH=off): everyone using this server acts as a local admin.">
        <span className="user-avatar">L</span>
        <span className="user-text">
          <span className="user-name">Local user</span>
          <span className="user-role">accounts off</span>
        </span>
      </div>
    );
  }
  const name = user.display_name || user.username;
  return (
    <div className="user-chip-wrap" ref={ref}>
      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head small">
            Signed in as <strong className="inline">{user.username}</strong>
          </div>
          <Link to="/account" className="user-menu-item" role="menuitem">
            Account
          </Link>
          <button type="button" className="user-menu-item" role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}
      <button type="button" className="user-chip" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="user-avatar">{name.slice(0, 1).toUpperCase()}</span>
        <span className="user-text">
          <span className="user-name">{name}</span>
          <span className="user-role">{ROLE_LABEL[user.role] ?? user.role}</span>
        </span>
      </button>
    </div>
  );
}

function MetaBanner({ errors, onRecheck }: { errors: Record<string, Record<string, string>>; onRecheck: () => void }) {
  const [hidden, setHidden] = useState(false);
  const entries = Object.entries(errors).flatMap(([kind, items]) => Object.entries(items).map(([id, msg]) => ({ kind, id, msg })));
  if (!entries.length || hidden) return null;
  return (
    <div className="meta-banner notice notice-warn">
      <div className="row space-between">
        <strong>{entries.length} definition file(s) fail validation and are ignored</strong>
        <span className="row gap-sm">
          <button className="btn btn-sm" onClick={onRecheck}>
            Recheck
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setHidden(true)}>
            Dismiss
          </button>
        </span>
      </div>
      <ul>
        {entries.map((e) => (
          <li key={`${e.kind}/${e.id}`}>
            <code>
              {e.kind}/{e.id}
            </code>
            : <span className="pre-line">{e.msg}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RouteError() {
  const err = useRouteError();
  const msg = isRouteErrorResponse(err) ? `${err.status} ${err.statusText}` : err instanceof Error ? err.message : String(err);
  return (
    <div className="page">
      <div className="notice notice-error">
        <strong>Something went wrong.</strong>
        <div className="pre-line">{msg}</div>
        <Link to="/">Back to start</Link>
      </div>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="page">
      <h1>Not found</h1>
      <p>
        <Link to="/">Back to start</Link>
      </p>
    </div>
  );
}
