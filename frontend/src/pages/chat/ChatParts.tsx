import { useEffect, useState } from 'react';
import { api } from '../../api';
import { ScopeToggle, useScope } from '../../components/team';
import { ErrorBox, Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useLocalStorage } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/util';
import type { Chat, Profile } from '../../types';

/** Only a chat's owner (or an admin) may delete it; anyone with accounts off. */
export function useMayDelete(): (c: { user_id?: number | null }) => boolean {
  const { user, authOn, can } = useAuth();
  return (c) => !authOn || can('admin') || (c.user_id != null && c.user_id === user.id);
}

/** Why the signed-in user can't write in this chat (null: they can). `linkLabel`: the chat link a visitor conversation came through. */
export function useReadOnlyReason(chat: Chat | null, linkLabel?: string | null): string | null {
  const { user, authOn, can } = useAuth();
  if (!chat) return null;
  if (chat.origin === 'link')
    return linkLabel ? `Visitor conversation from link “${linkLabel}” — read-only` : 'Visitor conversation from a chat link — read-only';
  if (chat.origin && chat.origin !== 'chat') return 'Simulated conversation — read-only';
  if (!authOn || can('admin') || (chat.user_id != null && chat.user_id === user.id)) return null;
  return chat.owner ? `${chat.owner}'s chat — read-only` : 'Someone else’s chat — read-only';
}

/** Side panel with a same-origin iframe (course pages need the SCORM shim on window.top). */
export function ViewerPanel({
  url,
  title,
  width,
  onResizeStart,
  onClose,
}: {
  url: string;
  title: string;
  width: number;
  onResizeStart: (e: React.MouseEvent) => void;
  onClose: () => void;
}) {
  // Course pages may set the top window's title; restore ours afterwards.
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
  return (
    <>
      <div className="splitter-x" onMouseDown={onResizeStart} title="Drag to resize" />
      <aside className="viewer-panel" style={{ width }}>
        <div className="viewer-header">
          <strong className="viewer-title" title={title}>
            {title || 'Viewer'}
          </strong>
          <a className="btn btn-sm btn-ghost" href={url} target="_blank" rel="noreferrer">
            ↗
          </a>
          <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close viewer">
            ×
          </button>
        </div>
        <iframe key={url} className="viewer-frame" src={url} title={title || 'Viewer'} allow="autoplay; fullscreen" />
      </aside>
    </>
  );
}

/** Profile select with inline creation. */
export function ProfilePicker({
  profiles,
  value,
  onChange,
  onCreated,
  allowNone,
  showOwner,
}: {
  profiles: Profile[];
  value: number | null;
  onChange: (id: number | null) => void;
  onCreated: (p: Profile) => void;
  allowNone: boolean;
  /** Everyone's profiles are listed: name their owners. */
  showOwner?: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);

  const create = async () => {
    if (!name.trim()) return;
    setError(null);
    try {
      const p = await api.profiles.create(name.trim());
      setCreating(false);
      setName('');
      onCreated(p);
    } catch (e) {
      setError(e);
    }
  };

  if (creating) {
    return (
      <span className="profile-picker">
        <input
          autoFocus
          value={name}
          placeholder="Profile name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
            if (e.key === 'Escape') setCreating(false);
          }}
        />
        <button className="btn btn-sm btn-primary" onClick={create} disabled={!name.trim()}>
          Create
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => setCreating(false)}>
          Cancel
        </button>
        {error != null && <span className="text-danger small">{error instanceof Error ? error.message : String(error)}</span>}
      </span>
    );
  }
  return (
    <span className="profile-picker">
      <select
        value={value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__new') setCreating(true);
          else onChange(e.target.value ? Number(e.target.value) : null);
        }}
      >
        {(allowNone || value == null) && <option value="">{allowNone ? 'No profile' : 'Choose a profile…'}</option>}
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {showOwner ? ` (${p.owner ?? 'no owner'})` : ''}
          </option>
        ))}
        <option value="__new">+ New profile…</option>
      </select>
    </span>
  );
}

/** Right-hand drawer listing this system's chats. */
export function SessionsDrawer({
  systemId,
  currentChatId,
  profiles,
  onOpen,
  onNew,
  onClose,
}: {
  systemId: string;
  currentChatId: string | undefined;
  profiles: Profile[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [scopePref, setScopePref] = useLocalStorage<'mine' | 'all'>('sbf.chat.scope', 'mine');
  const scope = useScope(scopePref);
  const chats = useLoad(() => api.chats.list(systemId, 100, scope), [systemId, scope]);
  const [error, setError] = useState<unknown>(null);
  const mayDelete = useMayDelete();
  const names = new Map(profiles.map((p) => [p.id, p.name]));

  const remove = async (id: string) => {
    if (!window.confirm('Delete this chat and its traces?')) return;
    try {
      await api.chats.remove(id);
      chats.reload();
      if (id === currentChatId) onNew();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <div className="drawer-header">
          <strong>Sessions</strong>
          <span className="row gap-sm">
            <button className="btn btn-sm btn-primary" onClick={onNew}>
              + New chat
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onClose} aria-label="Close">
              ×
            </button>
          </span>
        </div>
        <div className="drawer-toolbar">
          <ScopeToggle value={scope} onChange={setScopePref} />
        </div>
        {chats.loading && <Loading />}
        {chats.error != null && <ErrorBox error={chats.error} onRetry={chats.reload} />}
        {error != null && <ErrorBox error={error} />}
        {chats.data && chats.data.length === 0 && <div className="muted small drawer-empty">No chats yet.</div>}
        <ul className="session-list">
          {(chats.data ?? []).map((c) => (
            <li key={c.id} className={c.id === currentChatId ? 'active' : ''}>
              <button type="button" className="session-item" onClick={() => onOpen(c.id)}>
                <div className="session-title">{c.title || <span className="muted">(empty chat)</span>}</div>
                <div className="muted small">
                  {fmtDateTime(c.updated_at)} · {c.turns} turn{c.turns === 1 ? '' : 's'}
                  {c.profile_id != null && <> · {names.get(c.profile_id) ?? `profile ${c.profile_id}`}</>}
                  {scope === 'all' && <> · {c.owner ?? 'no owner'}</>}
                </div>
              </button>
              {mayDelete(c) && (
                <button type="button" className="btn btn-ghost btn-icon danger" title="Delete chat" onClick={() => remove(c.id)}>
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
