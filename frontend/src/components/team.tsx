// Small pieces of the team features: "saved by", who else is here,
// read-only notes and the Mine / Everyone switch.

import { useAuth } from '../lib/auth';
import { fmtDateTime } from '../lib/util';
import type { PresenceEntry, Role } from '../types';

/** "Saved <time> by <user>" (either part may be unknown). */
export function SavedBy({ at, by, prefix = 'Saved' }: { at?: string | null; by?: string | null; prefix?: string }) {
  if (!at && !by) return null;
  return (
    <span className="saved-by" title={at ?? undefined}>
      {prefix}
      {at && <> {fmtDateTime(at)}</>}
      {by && (
        <>
          {' '}
          by <strong className="inline">{by}</strong>
        </>
      )}
    </span>
  );
}

/** A list cell's "Updated" value: when, and by whom underneath. */
export function WhenBy({ at, by }: { at?: string | null; by?: string | null }) {
  return (
    <>
      {fmtDateTime(at)}
      {by && <div className="muted small">by {by}</div>}
    </>
  );
}

/** "Ed Editor is here" / "… is editing (unsaved changes)" chips. */
export function PresenceChips({ others }: { others: PresenceEntry[] }) {
  if (!others.length) return null;
  return (
    <span className="presence-chips">
      {others.map((o) => (
        <span
          key={o.username}
          className={`presence-chip${o.editing ? ' editing' : ''}`}
          title={`${o.username} · seen ${o.seconds_ago < 5 ? 'just now' : `${o.seconds_ago} s ago`}`}
        >
          <span className="presence-dot" />
          {o.display_name || o.username} {o.editing ? 'is editing (unsaved changes)' : 'is here'}
        </span>
      ))}
    </span>
  );
}

/** In place of Save for someone whose role can't save here. */
export function ReadOnlyNote({ need = 'editor' }: { need?: Role }) {
  const { user } = useAuth();
  return (
    <span
      className="readonly-note"
      title={`Saving here needs the ${need} role. You can try changes in this page, but they can't be saved.`}
    >
      Read-only — your role is {user.role}
    </span>
  );
}

/** Mine / Everyone for chats and profiles; only editors and admins (with accounts on) see it. */
export function ScopeToggle({ value, onChange }: { value: 'mine' | 'all'; onChange: (v: 'mine' | 'all') => void }) {
  const { authOn, can } = useAuth();
  if (!authOn || !can('editor')) return null;
  return (
    <span className="seg seg-sm" role="group" aria-label="Whose">
      <button type="button" className={value === 'mine' ? 'active' : ''} onClick={() => onChange('mine')}>
        Mine
      </button>
      <button type="button" className={value === 'all' ? 'active' : ''} onClick={() => onChange('all')}>
        Everyone
      </button>
    </span>
  );
}

/** The scope to actually request: viewers (and accounts off) always get their own / everything. */
export function useScope(value: 'mine' | 'all'): 'mine' | 'all' {
  const { authOn, can } = useAuth();
  return authOn && can('editor') ? value : 'mine';
}
