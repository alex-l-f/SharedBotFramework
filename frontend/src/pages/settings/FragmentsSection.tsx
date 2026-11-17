import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton, useLastChange } from '../../components/History';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { EmptyState, ErrorBox, Loading, PromptArea } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { SLUG_RE } from '../../lib/util';
import type { Fragment } from '../../types';

type FragmentText = { text: string };
// Revisions keep the file's bytes, which may have Windows line ends; the editor (and GET) use \n.
const toPayload = (d: Record<string, unknown>): FragmentText => ({ text: String(d.text ?? '').replace(/\r\n?/g, '\n') });

/** Shared prompt fragments (workspace/fragments/*.md), used as {{ fragments.<id> }}. */
export function FragmentsSection({ onDirty, active }: { onDirty: (d: boolean) => void; active: boolean }) {
  const list = useLoad(api.fragments.list, []);
  // The fragment as loaded into the editor (its version is what a save is based on).
  const [base, setBase] = useState<Fragment | null>(null);
  const [text, setText] = useState('');
  const [isNew, setIsNew] = useState(false);
  const [newId, setNewId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const canEdit = useAuth().can('editor');

  const selected = isNew ? null : base?.id ?? null;
  const dirty = isNew ? text.length > 0 : base != null && text !== base.text;
  useEffect(() => onDirty(dirty && canEdit), [dirty, canEdit, onDirty]);
  const others = usePresence(active && selected ? `fragments/${selected}` : null, dirty && canEdit);
  const last = useLastChange('fragments', selected, base?.version);

  useEffect(() => {
    if (!base && !isNew && list.data && list.data.length) {
      setBase(list.data[0]);
      setText(list.data[0].text);
    }
  }, [list.data, base, isNew]);

  const pick = (id: string) => {
    if (dirty && !window.confirm('Discard unsaved changes to this fragment?')) return;
    const f = (list.data ?? []).find((x) => x.id === id) ?? null;
    setIsNew(false);
    setBase(f);
    setText(f?.text ?? '');
    setError(null);
  };

  const startNew = () => {
    if (dirty && !window.confirm('Discard unsaved changes to this fragment?')) return;
    setIsNew(true);
    setBase(null);
    setNewId('');
    setText('');
    setError(null);
  };

  /** Re-reads the list and loads `id` from it (theirs, after a conflict). */
  const reloadFragment = (id: string) => {
    api.fragments.list().then((fs) => {
      list.setData(fs);
      const f = fs.find((x) => x.id === id) ?? null;
      setBase(f);
      setText(f?.text ?? '');
    }, setError);
  };

  const id = isNew ? newId : selected;
  const idProblem = isNew && (!newId ? 'Id required' : !SLUG_RE.test(newId) ? 'Lowercase letters, digits, - and _' : (list.data ?? []).some((f) => f.id === newId) ? 'Exists already' : null);

  /** Saves `body` as fragment `id` based on `version` (null: unconditionally). */
  const persist = async (body: FragmentText, version: string | null) => {
    if (!id) return;
    const result = await api.fragments.put(id, body.text, version);
    setBase(result);
    setText(result.text);
    setIsNew(false);
    setError(null);
    list.reload();
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
  };
  const conflicts = useConflicts<FragmentText>({
    what: `fragment “${id}”`,
    toPayload,
    persist,
    reload: () => id && reloadFragment(id),
    discard: () => {
      setBase(null);
      setText('');
      list.reload();
    },
  });

  const save = async () => {
    if (!id || idProblem || busy || !canEdit) return;
    setBusy(true);
    setError(null);
    try {
      await persist({ text }, isNew ? null : base?.version ?? null);
    } catch (e) {
      if (!conflicts.catchConflict(e, { text: base?.text ?? '' }, { text })) setError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && active && canEdit);

  const remove = async () => {
    if (!selected || !window.confirm(`Delete fragment "${selected}"? Prompts that use it will render it as empty.`)) return;
    setError(null);
    try {
      await api.fragments.remove(selected, base?.version);
      setBase(null);
      setText('');
      list.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="split-editor">
      <aside className="panel split-list">
        <div className="row space-between">
          <h2 className="panel-title">Fragments</h2>
          {canEdit && (
            <button className="btn btn-sm" onClick={startNew}>
              + New
            </button>
          )}
        </div>
        {list.loading && !list.data && <Loading />}
        {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
        <ul className="select-list">
          {(list.data ?? []).map((f) => (
            <li key={f.id}>
              <button type="button" className={f.id === selected ? 'active' : ''} onClick={() => pick(f.id)}>
                <code>{f.id}</code>
                <span className="muted small">{f.text.length.toLocaleString()} chars</span>
              </button>
            </li>
          ))}
        </ul>
        {list.data && list.data.length === 0 && <EmptyState>No shared fragments.</EmptyState>}
      </aside>
      <section className="panel split-main">
        {selected || isNew ? (
          <>
            <div className="row space-between wrap gap-sm">
              {isNew ? (
                <input className="mono" autoFocus placeholder="fragment-id" value={newId} onChange={(e) => setNewId(e.target.value.trim())} />
              ) : (
                <div>
                  <h2 className="panel-title">
                    <code>{selected}</code> <span className="muted small">{'{{ fragments.' + selected + ' }}'}</span>
                  </h2>
                  {last && (
                    <span className="muted small">
                      <SavedBy at={last.ts} by={last.actor} prefix="Last saved" />
                    </span>
                  )}
                  <PresenceChips others={others} />
                </div>
              )}
              <div className="row gap-sm">
                {flash && <span className="flash">{flash}</span>}
                {idProblem && newId && <span className="text-danger small">{idProblem}</span>}
                {selected && (
                  <HistoryButton
                    small
                    kind="fragments"
                    id={selected}
                    label={`fragment ${selected}`}
                    current={{ text }}
                    baseVersion={base?.version}
                    toPayload={toPayload}
                    asText={(p) => p.text}
                    onLoad={canEdit ? (p) => setText(p.text) : undefined}
                  />
                )}
                {!isNew && canEdit && (
                  <button className="btn btn-danger-ghost btn-sm" onClick={remove}>
                    Delete
                  </button>
                )}
                <button className="btn btn-sm" disabled={!dirty} onClick={() => setText(isNew ? '' : base?.text ?? '')}>
                  Revert
                </button>
                {canEdit ? (
                  <button className="btn btn-primary btn-sm" disabled={busy || !!idProblem || (!dirty && !isNew)} onClick={save}>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                ) : (
                  <ReadOnlyNote />
                )}
              </div>
            </div>
            {error != null && <ErrorBox error={error} />}
            <PromptArea value={text} onChange={setText} rows={30} />
            <span className="field-hint">Fragments are Jinja templates rendered with the same variables as the prompt that includes them.</span>
          </>
        ) : (
          <EmptyState>Select a fragment.</EmptyState>
        )}
      </section>
      {conflicts.dialog}
    </div>
  );
}
