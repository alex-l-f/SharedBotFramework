import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton } from '../../components/History';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { EmptyState, ErrorBox, Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { invalidate } from '../../lib/refdata';
import { SLUG_RE } from '../../lib/util';
import type { MemorySchema } from '../../types';

const SKELETON = {
  name: '',
  description: '',
  vocabularies: { level: ['low', 'medium', 'high'] },
  labels: {},
  templates: {
    example_note: {
      description: 'An example template.',
      slots: { level: { enum: 'level', required: true } },
      follow_up: false,
      render: 'Reported a {{ level }} level.',
    },
  },
  snapshot_max_chars: 1200,
};

type SchemaBody = Record<string, unknown>;

/** The editable part of a schema (no id, stamps or version). */
function body(schema: Record<string, unknown>): SchemaBody {
  const { id: _id, updated_at: _u, updated_by: _b, version: _v, ...rest } = schema;
  return rest;
}

const asText = (b: SchemaBody) => JSON.stringify(b, null, 2);

function parse(text: string): SchemaBody | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as SchemaBody) : null;
  } catch {
    return null;
  }
}

/** Raw JSON editor for memory schemas (vocabularies + note templates). */
export function MemorySchemasSection({ onDirty, active }: { onDirty: (d: boolean) => void; active: boolean }) {
  const list = useLoad(api.memorySchemas.list, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [newId, setNewId] = useState('');
  const [text, setText] = useState('');
  const [savedText, setSavedText] = useState('');
  // The stored schema the editor was loaded from (its version is what a save is based on).
  const [base, setBase] = useState<MemorySchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const canEdit = useAuth().can('editor');

  const dirty = text !== savedText;
  useEffect(() => onDirty(dirty && canEdit), [dirty, canEdit, onDirty]);
  const others = usePresence(active && selected && !isNew ? `memory_schemas/${selected}` : null, dirty && canEdit);
  const current = useMemo(() => parse(text), [text]);

  const adopt = (schema: MemorySchema) => {
    const t = asText(body(schema as unknown as Record<string, unknown>));
    setBase(schema);
    setText(t);
    setSavedText(t);
  };

  const load = async (id: string) => {
    setLoading(true);
    setError(null);
    setParseError(null);
    try {
      adopt(await api.memorySchemas.get(id));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selected && !isNew && list.data && list.data.length) {
      setSelected(list.data[0].id);
      void load(list.data[0].id);
    }
  }, [list.data, selected, isNew]);

  const pick = (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes to this schema?')) return;
    setIsNew(false);
    setSelected(id);
    void load(id);
  };

  const startNew = () => {
    if (dirty && !window.confirm('Discard unsaved changes to this schema?')) return;
    setIsNew(true);
    setSelected(null);
    setBase(null);
    setNewId('');
    const t = JSON.stringify(SKELETON, null, 2);
    setText(t);
    setSavedText('');
    setError(null);
    setParseError(null);
  };

  const id = isNew ? newId : selected;
  const idProblem = isNew && (!newId ? 'Id required' : !SLUG_RE.test(newId) ? 'Lowercase letters, digits, - and _' : (list.data ?? []).some((s) => s.id === newId) ? 'Exists already' : null);

  /** Saves `data` as schema `id` based on `version` (null: unconditionally). */
  const persist = async (data: SchemaBody, version: string | null) => {
    if (!id) return;
    adopt(await api.memorySchemas.put(id, data, version));
    setIsNew(false);
    setSelected(id);
    setError(null);
    list.reload();
    invalidate('memory-schemas');
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
  };
  const conflicts = useConflicts<SchemaBody>({
    what: `memory schema “${id}”`,
    toPayload: body,
    persist,
    reload: () => id && void load(id),
    discard: () => {
      setSelected(null);
      setBase(null);
      setText('');
      setSavedText('');
      list.reload();
    },
  });

  const save = async () => {
    if (!id || idProblem || busy || !canEdit) return;
    let data: SchemaBody;
    try {
      data = JSON.parse(text) as SchemaBody;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Invalid JSON');
      return;
    }
    setParseError(null);
    setBusy(true);
    setError(null);
    try {
      await persist(data, isNew ? null : base?.version ?? null);
    } catch (e) {
      const basePayload = base ? body(base as unknown as Record<string, unknown>) : {};
      if (!conflicts.catchConflict(e, basePayload, data)) setError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && active && canEdit);

  const remove = async () => {
    if (!selected || !window.confirm(`Delete memory schema "${selected}"? Systems using it will fail validation; stored notes are kept.`)) return;
    try {
      await api.memorySchemas.remove(selected, base?.version);
      setSelected(null);
      setBase(null);
      setText('');
      setSavedText('');
      list.reload();
      invalidate('memory-schemas');
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="split-editor">
      <aside className="panel split-list">
        <div className="row space-between">
          <h2 className="panel-title">Memory schemas</h2>
          {canEdit && (
            <button className="btn btn-sm" onClick={startNew}>
              + New
            </button>
          )}
        </div>
        {list.loading && !list.data && <Loading />}
        {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
        <ul className="select-list">
          {(list.data ?? []).map((s) => (
            <li key={s.id}>
              <button type="button" className={s.id === selected && !isNew ? 'active' : ''} onClick={() => pick(s.id)}>
                <span>
                  <code>{s.id}</code> {s.name && <span className="small">{s.name}</span>}
                </span>
                <span className="muted small">{s.templates} templates</span>
              </button>
            </li>
          ))}
        </ul>
        {list.data && list.data.length === 0 && <EmptyState>No memory schemas.</EmptyState>}
      </aside>
      <section className="panel split-main">
        {selected || isNew ? (
          <>
            <div className="row space-between wrap gap-sm">
              {isNew ? (
                <input className="mono" autoFocus placeholder="schema-id" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
              ) : (
                <div>
                  <h2 className="panel-title">
                    <code>{selected}</code>
                  </h2>
                  {base && (base.updated_at || base.updated_by) && (
                    <span className="muted small">
                      <SavedBy at={base.updated_at} by={base.updated_by} />
                    </span>
                  )}
                  <PresenceChips others={others} />
                </div>
              )}
              <div className="row gap-sm">
                {flash && <span className="flash">{flash}</span>}
                {idProblem && newId && <span className="text-danger small">{idProblem}</span>}
                {selected && !isNew && (
                  <HistoryButton
                    small
                    kind="memory_schemas"
                    id={selected}
                    label={`memory schema ${selected}`}
                    current={current}
                    baseVersion={base?.version}
                    toPayload={body}
                    onLoad={canEdit ? (p) => setText(asText(p)) : undefined}
                  />
                )}
                {!isNew && canEdit && (
                  <button className="btn btn-danger-ghost btn-sm" onClick={remove}>
                    Delete
                  </button>
                )}
                <button className="btn btn-sm" disabled={!dirty || isNew} onClick={() => setText(savedText)}>
                  Revert
                </button>
                {canEdit ? (
                  <button className="btn btn-primary btn-sm" disabled={busy || !!idProblem || !dirty} onClick={save}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                ) : (
                  <ReadOnlyNote />
                )}
              </div>
            </div>
            <p className="muted small">
              Fields: name, description, vocabularies (name → values), labels (value → display label), templates (key → {'{description, slots, follow_up, render}'}; a slot is{' '}
              <code>{'{enum: "<vocabulary>" | [values], required}'}</code> or <code>{'{ref: "resource", required}'}</code>), snapshot_max_chars.
            </p>
            {parseError && <div className="notice notice-error">JSON: {parseError}</div>}
            {error != null && <ErrorBox error={error} title="Not saved" />}
            {loading ? (
              <Loading />
            ) : (
              <textarea className="mono code-editor" spellCheck={false} rows={32} value={text} onChange={(e) => {
                setText(e.target.value);
                setParseError(null);
              }} />
            )}
          </>
        ) : (
          <EmptyState>Select a schema.</EmptyState>
        )}
      </section>
      {conflicts.dialog}
    </div>
  );
}
