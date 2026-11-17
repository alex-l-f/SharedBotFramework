import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ScopeToggle, useScope } from '../../components/team';
import { Badge, EmptyState, ErrorBox, Loading, Modal, Notice, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useLocalStorage } from '../../lib/hooks';
import { useLibraries } from '../../lib/refdata';
import { fmtDateTime, toInline } from '../../lib/util';
import type { MemoryNote, Profile, SystemDef } from '../../types';
import { NoteForm } from './NoteForm';

const PAGE = 30;

export function MemoryPage() {
  const systems = useLoad(async () => {
    const list = await api.systems.list();
    const defs = await Promise.all(list.map((s) => api.systems.get(s.id).catch(() => null)));
    return defs.filter((d): d is SystemDef => !!d && d.memory.enabled && !!d.memory.schema_id);
  }, []);
  const [scopePref, setScopePref] = useLocalStorage<'mine' | 'all'>('sbf.memory.scope', 'mine');
  const scope = useScope(scopePref);
  const profiles = useLoad(() => api.profiles.list(scope), [scope]);
  const [systemId, setSystemId] = useLocalStorage<string>('sbf.memory.system', '');
  const [profileId, setProfileId] = useLocalStorage<number | null>('sbf.memory.profile', null);

  const memSystems = systems.data ?? [];
  const system = memSystems.find((s) => s.id === systemId) ?? memSystems[0];
  const profile = (profiles.data ?? []).find((p) => p.id === profileId) ?? null;

  return (
    <div className="page page-wide">
      <PageHeader
        title="Memory"
        subtitle="Privacy-preserving template notes per profile: every note is a template plus enum slots (or a library resource reference)."
        actions={
          <label className="field-inline">
            System{' '}
            <select value={system?.id ?? ''} onChange={(e) => setSystemId(e.target.value)} disabled={!memSystems.length}>
              {memSystems.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id} (namespace {s.memory.namespace || s.id})
                </option>
              ))}
            </select>
          </label>
        }
      />
      {systems.loading && !systems.data && <Loading />}
      {systems.error != null && <ErrorBox error={systems.error} onRetry={systems.reload} />}
      {systems.data && memSystems.length === 0 && <Notice>No system has memory enabled (System settings → Memory).</Notice>}

      <div className="memory-layout">
        <ProfilesPanel
          profiles={profiles.data ?? []}
          scope={scope}
          onScope={setScopePref}
          loading={profiles.loading}
          error={profiles.error}
          selected={profile?.id ?? null}
          onSelect={setProfileId}
          onChanged={profiles.reload}
        />
        <div className="memory-main">
          {system && profile ? (
            <ProfileMemory key={`${system.id}/${profile.id}`} system={system} profile={profile} onNotesChanged={profiles.reload} />
          ) : (
            system && <EmptyState>Select a profile to see its memory.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfilesPanel({
  profiles,
  scope,
  onScope,
  loading,
  error,
  selected,
  onSelect,
  onChanged,
}: {
  profiles: Profile[];
  scope: 'mine' | 'all';
  onScope: (s: 'mine' | 'all') => void;
  loading: boolean;
  error: unknown;
  selected: number | null;
  onSelect: (id: number | null) => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const { user, authOn, can } = useAuth();
  // Only a profile's owner (or an admin) may delete it.
  const mayDelete = (p: Profile) => !authOn || can('admin') || (p.user_id != null && p.user_id === user.id);

  const create = async () => {
    if (!name.trim()) return;
    setActionError(null);
    try {
      const p = await api.profiles.create(name.trim());
      setName('');
      onChanged();
      onSelect(p.id);
    } catch (e) {
      setActionError(e);
    }
  };
  const remove = async (p: Profile) => {
    if (!window.confirm(`Delete profile "${p.name}" and all of its memory notes (in every namespace)?`)) return;
    setActionError(null);
    try {
      await api.profiles.remove(p.id);
      if (selected === p.id) onSelect(null);
      onChanged();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <aside className="panel profiles-panel">
      <div className="row space-between">
        <h2 className="panel-title">Profiles</h2>
        <ScopeToggle value={scope} onChange={onScope} />
      </div>
      {loading && !profiles.length && <Loading />}
      {error != null && <ErrorBox error={error} />}
      {actionError != null && <ErrorBox error={actionError} />}
      <ul className="profile-list">
        {profiles.map((p) => (
          <li key={p.id} className={p.id === selected ? 'active' : ''}>
            <button type="button" className="profile-item" onClick={() => onSelect(p.id)}>
              <span>
                {p.name}
                {scope === 'all' && <span className="muted small"> · {p.owner ?? 'no owner'}</span>}
              </span>
              <span className="muted small">{p.memories ?? 0} notes</span>
            </button>
            {mayDelete(p) && (
              <button type="button" className="btn btn-ghost btn-icon danger" title="Delete profile" onClick={() => remove(p)}>
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {!loading && profiles.length === 0 && <div className="muted small">No profiles yet.</div>}
      <form
        className="row gap-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input value={name} placeholder="New profile name" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!name.trim()}>
          Add
        </button>
      </form>
    </aside>
  );
}

function ProfileMemory({ system, profile, onNotesChanged }: { system: SystemDef; profile: Profile; onNotesChanged: () => void }) {
  const templates = useLoad(() => api.memory.templates(system.id), [system.id]);
  const libraries = useLibraries();
  const snapshot = useLoad(() => api.memory.snapshot(system.id, profile.id), [system.id, profile.id]);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [template, setTemplate] = useState('');
  const [offset, setOffset] = useState(0);
  const notes = useLoad(
    () => api.memory.notes(system.id, { profile_id: profile.id, q: query || undefined, template: template || undefined, limit: PAGE, offset }),
    [system.id, profile.id, query, template, offset],
  );
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MemoryNote | null>(null);
  const [error, setError] = useState<unknown>(null);
  const canEdit = useAuth().can('editor');

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(q.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const refresh = () => {
    notes.reload();
    snapshot.reload();
    onNotesChanged();
  };

  const remove = async (n: MemoryNote) => {
    if (!window.confirm(`Delete note #${n.id}?`)) return;
    setError(null);
    try {
      await api.memory.remove(system.id, n.id);
      refresh();
    } catch (e) {
      setError(e);
    }
  };

  const total = notes.data?.total ?? 0;

  return (
    <div className="stack">
      <section className="panel">
        <h2 className="panel-title">
          Injected snapshot <span className="muted small">what nodes with inject_memory see for {profile.name}</span>
        </h2>
        {snapshot.loading && <Loading />}
        {snapshot.error != null && <ErrorBox error={snapshot.error} onRetry={snapshot.reload} />}
        {snapshot.data &&
          (snapshot.data.block ? (
            <pre className="code-block snapshot-block">{snapshot.data.block.trim()}</pre>
          ) : (
            <div className="muted small">Empty — this profile has no notes yet, so a session starts like a brand-new user.</div>
          ))}
      </section>

      <section className="panel">
        <div className="row space-between wrap gap-sm">
          <h2 className="panel-title">
            Notes <Badge tone="muted">{total}</Badge>
          </h2>
          <div className="row gap-sm wrap">
            <input className="search" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} />
            <select value={template} onChange={(e) => {
              setTemplate(e.target.value);
              setOffset(0);
            }}>
              <option value="">All templates</option>
              {Object.keys(templates.data ?? {}).map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            {canEdit && (
              <button className="btn btn-sm btn-primary" onClick={() => setAdding(!adding)} disabled={!templates.data}>
                {adding ? 'Close' : '+ Add note'}
              </button>
            )}
          </div>
        </div>
        {templates.error != null && <ErrorBox error={templates.error} title="Templates unavailable" />}
        {adding && templates.data && (
          <div className="subpanel">
            <NoteForm
              templates={templates.data}
              libraries={libraries.data ?? []}
              submitLabel="Add note"
              onCancel={() => setAdding(false)}
              onSubmit={async (tpl, slots) => {
                await api.memory.add(system.id, profile.id, tpl, slots);
                setAdding(false);
                refresh();
              }}
            />
          </div>
        )}
        {error != null && <ErrorBox error={error} />}
        {notes.loading && !notes.data && <Loading />}
        {notes.error != null && <ErrorBox error={notes.error} onRetry={notes.reload} />}
        {notes.data && notes.data.memories.length === 0 && <EmptyState>No notes{query || template ? ' match' : ''}.</EmptyState>}
        <ul className="note-list">
          {(notes.data?.memories ?? []).map((n) => (
            <li key={n.id} className="note">
              <div className="note-text">{n.rendered}</div>
              <div className="note-meta">
                <Badge tone="neutral">{n.template}</Badge>
                {n.follow_up && <Badge tone="warn">follow-up</Badge>}
                <span className="muted small">{fmtDateTime(n.ts)}</span>
                {n.chat_id && (
                  <Link className="small" to={`/chat/${system.id}/${n.chat_id}`}>
                    chat
                  </Link>
                )}
                <span className="muted small mono clamp-1" title={toInline(n.slots)}>
                  {toInline(n.slots)}
                </span>
                <span className="grow" />
                {canEdit && (
                  <>
                    <button className="btn btn-sm btn-ghost" onClick={() => setEditing(n)} disabled={!templates.data?.[n.template]}>
                      Edit
                    </button>
                    <button className="btn btn-sm btn-ghost danger" onClick={() => remove(n)}>
                      Delete
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
        {total > PAGE && (
          <div className="row gap-sm pager">
            <button className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              ← Newer
            </button>
            <span className="muted small">
              {offset + 1}–{Math.min(total, offset + PAGE)} of {total}
            </span>
            <button className="btn btn-sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Older →
            </button>
          </div>
        )}
      </section>

      {editing && templates.data && (
        <Modal title={`Edit note #${editing.id}`} onClose={() => setEditing(null)}>
          <NoteForm
            templates={templates.data}
            libraries={libraries.data ?? []}
            initialTemplate={editing.template}
            initialSlots={editing.slots}
            fixedTemplate
            submitLabel="Save"
            onCancel={() => setEditing(null)}
            onSubmit={async (_tpl, slots) => {
              await api.memory.update(system.id, editing.id, slots);
              setEditing(null);
              refresh();
            }}
          />
        </Modal>
      )}
    </div>
  );
}
