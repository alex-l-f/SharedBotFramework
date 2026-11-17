// Who is signed in, and what they may do. `AuthGate` wraps the app: it shows
// the sign-in / first-admin / temporary-password pages until there is a
// usable session, and `useAuth()` gives pages the user and `can(role)`.
//
// With accounts off (SBF_AUTH=off) the server answers as a local admin and
// the gate renders the app straight away.

import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, setAuthHandler } from '../api';
import { ErrorBox, Loading } from '../components/ui';
import { ForcedPasswordPage, LoginPage, SetupPage } from '../pages/auth/SignInPages';
import { ROLES, type AuthStatus, type Role, type User } from '../types';
import { anyUnsaved } from './hooks';
import { invalidateAll } from './refdata';

export interface AuthContextValue {
  /** Accounts are on (false: everyone is the local admin). */
  authOn: boolean;
  user: User;
  /** The user has at least this role. */
  can: (role: Role) => boolean;
  /** Re-reads GET /auth/status (e.g. after changing one's own account). */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthGate');
  return ctx;
}

export const hasRole = (user: Pick<User, 'role'> | null | undefined, role: Role): boolean =>
  !!user && ROLES.indexOf(user.role) >= ROLES.indexOf(role);

export const ROLE_LABEL: Record<Role, string> = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The user the app is mounted for. It stays mounted (hidden) while someone
  // signs in again after a lost session, so unsaved edits survive.
  const [appUser, setAppUser] = useState<User | null>(null);
  const [lost, setLost] = useState(false);
  const appUserRef = useRef(appUser);
  appUserRef.current = appUser;

  const load = useCallback(async () => {
    try {
      setStatus(await api.auth.status());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Any 401 (session expired, signed out elsewhere, account disabled) → sign in again.
  useEffect(() => {
    setAuthHandler((problem) => {
      if (problem === 'password') {
        void load();
        return;
      }
      setStatus((s) => (s && s.auth && s.user ? { ...s, user: null } : s));
      if (appUserRef.current) setLost(true);
    });
    return () => setAuthHandler(null);
  }, [load]);

  const user = status?.user ?? null;
  const ready = !!status && !!user && !user.must_change_password;

  useEffect(() => {
    if (!ready || !user) return;
    setAppUser(user);
    setLost(false);
  }, [ready, user]);

  const signOut = useCallback(async () => {
    if (anyUnsaved() && !window.confirm('You have unsaved changes. Sign out and discard them?')) return;
    try {
      await api.auth.logout();
    } catch {
      /* signed out anyway */
    }
    invalidateAll();
    setAppUser(null);
    setLost(false);
    window.history.replaceState(null, '', '/');
    setStatus((s) => (s ? { ...s, user: null } : s));
  }, []);

  const value = useMemo<AuthContextValue | null>(
    () =>
      appUser
        ? {
            authOn: !!status?.auth,
            user: appUser,
            can: (role: Role) => hasRole(appUser, role),
            refresh: load,
            signOut,
          }
        : null,
    [appUser, status?.auth, load, signOut],
  );

  if (!status) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          {error != null ? <ErrorBox error={error} title="Cannot reach the SBF server" onRetry={() => void load()} /> : <Loading />}
        </div>
      </div>
    );
  }

  let screen: ReactNode = null;
  if (!ready) {
    if (user && user.must_change_password) {
      screen = <ForcedPasswordPage user={user} onDone={load} onSignOut={signOut} />;
    } else if (status.setup_needed) {
      screen = <SetupPage allowed={status.setup_allowed} onRecheck={load} onDone={(u) => setStatus({ ...status, user: u, setup_needed: false, setup_allowed: false })} />;
    } else {
      screen = (
        <LoginPage
          lost={lost}
          onSignedIn={(u) => {
            // Someone else signing in gets a fresh app (no one else's drafts).
            if (appUserRef.current && appUserRef.current.username !== u.username) setAppUser(null);
            setStatus({ ...status, user: u });
          }}
        />
      );
    }
  }

  return (
    <>
      {screen}
      {value && (
        <div hidden={!ready} className="app-holder">
          <AuthContext.Provider value={value}>
            <Fragment key={value.user.username}>{children}</Fragment>
          </AuthContext.Provider>
        </div>
      )}
    </>
  );
}
