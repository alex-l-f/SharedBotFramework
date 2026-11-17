// Shared plumbing of the persona / scenario / rubric editors: load, draft,
// Save / Revert / Ctrl+S / unsaved-guard, delete, duplicate, and the team
// parts (version-checked saves with the conflict dialog, history, presence).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton } from '../../components/History';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { DirtyDot, ErrorBox, Field, Modal } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut, useUnsavedGuard, type Loaded } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { isEqual, SLUG_RE } from '../../lib/util';
import type { DefKindName, PresenceEntry } from '../../types';

export interface DefBase {
  id: string;
  name: string;
  updated_at?: string | null;
  updated_by?: string | null;
  version?: string | null;
}

export interface DefKind<T extends DefBase, S extends T = T> {
  /** "persona" */
  label: string;
  /** "/simulations/personas" */
  path: string;
  /** Revision / presence kind ("personas"). */
  kind: DefKindName;
  get: (id: string) => Promise<S>;
  create: (d: T) => Promise<S>;
  /** `ifMatch`: the version the edit is based on. */
  update: (id: string, d: T, ifMatch?: string | null) => Promise<S>;
  remove: (id: string, ifMatch?: string | null) => Promise<unknown>;
  /** Exactly the definition fields (no used_by / updated_at). */
  payload: (d: T) => T;
  /** A blank definition. */
  blank: (id: string, name: string) => T;
}

/** What the editor header needs (covariant in T). */
export interface EditorControls<T extends DefBase> {
  draft: T | null;
  saved: T | null;
  dirty: boolean;
  busy: boolean;
  saveError: unknown;
  flash: string | null;
  save: () => Promise<void>;
  revert: () => void;
  remove: (confirmText?: string) => Promise<void>;
  /** The user's role may save here. */
  canSave: boolean;
  /** Others with this definition open. */
  others: PresenceEntry[];
  /** The History button (revisions, load one into the draft). */
  history: ReactNode;
  /** The conflict dialog when a save hit a newer version. */
  conflictDialog: ReactNode;
}

export interface DefEditor<T extends DefBase, S extends T> extends EditorControls<T> {
  loaded: Loaded<S>;
  /** The last loaded / saved response (e.g. used_by). */
  summary: S | null;
  setDraft: (d: T) => void;
  payload: T | null;
}

export function useDefinitionEditor<T extends DefBase, S extends T>(kind: DefKind<T, S>, id: string): DefEditor<T, S> {
  const navigate = useNavigate();
  const loaded = useLoad(() => kind.get(id), [id]);
  const [summary, setSummary] = useState<S | null>(null);
  const [saved, setSaved] = useState<T | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const canSave = useAuth().can('editor');

  // The editable fields plus the stored version's stamps (updated_at/by, version).
  const clean = (d: S): T => ({ ...kind.payload(d), updated_at: d.updated_at, updated_by: d.updated_by, version: d.version });

  useEffect(() => {
    if (!loaded.data) return;
    setSummary(loaded.data);
    setSaved(clean(loaded.data));
    setDraft(clean(loaded.data));
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data]);

  const payload = useMemo(() => (draft ? kind.payload(draft) : null), [draft, kind]);
  const dirty = useMemo(() => !!payload && !!saved && !isEqual(payload, kind.payload(saved)), [payload, saved, kind]);
  const { allowNext } = useUnsavedGuard(dirty && canSave);
  const others = usePresence(`${kind.kind}/${id}`, dirty && canSave);

  /** Saves `body` based on `version`; the result becomes the saved state. */
  const persist = async (body: T, version: string | null) => {
    const result = await kind.update(id, body, version);
    setSummary(result);
    setSaved(clean(result));
    setDraft(clean(result));
    setSaveError(null);
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
  };
  const conflicts = useConflicts<T>({
    what: `${kind.label} “${id}”`,
    toPayload: (current) => kind.payload(current as unknown as T),
    persist,
    reload: loaded.reload,
    discard: () => {
      allowNext();
      navigate(kind.path);
    },
  });

  const save = async () => {
    if (!draft || !saved || busy || !dirty || !canSave) return;
    setBusy(true);
    setSaveError(null);
    const mine = kind.payload(draft);
    try {
      await persist(mine, saved.version ?? null);
    } catch (e) {
      if (!conflicts.catchConflict(e, kind.payload(saved), mine)) setSaveError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && canSave);

  const remove = async (confirmText?: string) => {
    if (!draft) return;
    if (!window.confirm(confirmText ?? `Delete ${kind.label} "${draft.id}"?`)) return;
    setSaveError(null);
    try {
      await kind.remove(draft.id, saved?.version);
      allowNext();
      navigate(kind.path);
    } catch (e) {
      setSaveError(e);
    }
  };

  return {
    loaded,
    summary,
    saved,
    draft,
    setDraft,
    payload,
    dirty,
    busy,
    saveError,
    flash,
    save,
    revert: () => {
      if (saved) setDraft(saved);
      setSaveError(null);
    },
    remove,
    canSave,
    others,
    history: (
      <HistoryButton
        kind={kind.kind}
        id={id}
        label={`${kind.label} ${id}`}
        current={payload}
        baseVersion={saved?.version}
        toPayload={(d) => kind.payload(d as unknown as T)}
        onLoad={canSave && draft ? (p) => setDraft({ ...draft, ...p }) : undefined}
      />
    ),
    conflictDialog: conflicts.dialog,
  };
}

/** Sticky editor header: crumbs, title, subtitle and Save / Revert / Duplicate / Delete. */
export function EditorHeader({
  kindLabel,
  listPath,
  listLabel,
  ed,
  subtitle,
  onDuplicate,
  onDelete,
  extraActions,
  section = { to: '/simulations', label: 'Simulations' },
}: {
  kindLabel: string;
  listPath: string;
  listLabel: string;
  /** The first crumb (null: none, when the list is the section itself). */
  section?: { to: string; label: string } | null;
  ed: EditorControls<DefBase>;
  subtitle?: ReactNode;
  /** Replaces the default Delete action (e.g. to confirm with details). */
  onDelete?: () => void;
  onDuplicate: () => void;
  extraActions?: ReactNode;
}) {
  const { draft, saved, dirty, busy, flash } = ed;
  const errorRef = useRef<HTMLDivElement>(null);
  // A failed save (e.g. a 422 from Ctrl+S far down the page) scrolls its error into view.
  useEffect(() => {
    if (ed.saveError != null) errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [ed.saveError]);
  if (!draft) return null;
  return (
    <>
      <div className="page-header sticky-header">
        <div>
          <div className="crumbs">
            {section && (
              <>
                <Link to={section.to}>{section.label}</Link> /{' '}
              </>
            )}
            <Link to={listPath}>{listLabel}</Link> /
          </div>
          <h1>
            {draft.name || draft.id} <code className="muted small">{draft.id}</code> <DirtyDot dirty={dirty} />
          </h1>
          <div className="page-subtitle row gap-sm wrap">
            <span>{kindLabel}</span>
            {(saved?.updated_at || saved?.updated_by) && (
              <span>
                · <SavedBy at={saved.updated_at} by={saved.updated_by} prefix="saved" />
              </span>
            )}
            {subtitle}
          </div>
          <PresenceChips others={ed.others} />
        </div>
        <div className="page-actions">
          {flash && <span className="flash">{flash}</span>}
          {extraActions}
          {ed.history}
          <button className="btn" disabled={!dirty} onClick={ed.revert}>
            Revert
          </button>
          {ed.canSave ? (
            <>
              <button className="btn" onClick={onDuplicate}>
                Duplicate…
              </button>
              <button className="btn btn-danger-ghost" onClick={onDelete ?? (() => void ed.remove())}>
                Delete
              </button>
              <button className="btn btn-primary" disabled={!dirty || busy} onClick={() => void ed.save()} title="Ctrl+S">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <ReadOnlyNote />
          )}
        </div>
      </div>
      <div ref={errorRef} className="sim-save-error">
        {ed.saveError != null && <ErrorBox error={ed.saveError} title="Not saved" />}
      </div>
      {ed.conflictDialog}
    </>
  );
}

/** Load error / loading states of an editor page. */
export function EditorFallback({
  loaded,
  label,
  id,
  listPath,
  listLabel,
}: {
  loaded: { error: unknown; reload: () => void };
  label: string;
  id: string;
  listPath: string;
  listLabel: string;
}) {
  if (loaded.error != null)
    return (
      <div className="page">
        <ErrorBox error={loaded.error} onRetry={loaded.reload} title={`Could not load ${label} "${id}"`} />
        <Link to={listPath}>← {listLabel}</Link>
      </div>
    );
  return null;
}

/** Asks for an id (immutable afterwards) and a name, then creates the definition (blank or a copy). */
export function CreateDefinitionModal<T extends DefBase, S extends T>({
  kind,
  existing,
  base,
  onClose,
  onCreated,
  placeholder,
  idHint,
}: {
  kind: DefKind<T, S>;
  existing: string[];
  /** Duplicate from this definition. */
  base?: T | null;
  onClose: () => void;
  onCreated: (d: S) => void;
  placeholder?: string;
  idHint?: string;
}) {
  const [id, setId] = useState(base ? `${base.id}-copy` : '');
  const [name, setName] = useState(base ? `${base.name || base.id} (copy)` : '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const idProblem = !id
    ? 'Required'
    : !SLUG_RE.test(id)
      ? 'Lowercase letters, digits, - and _ (must start with a letter or digit)'
      : existing.includes(id)
        ? `A ${kind.label} with this id exists`
        : null;

  const submit = async () => {
    if (idProblem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = base ? { ...kind.payload(base), id, name } : kind.blank(id, name);
      onCreated(await kind.create(body));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={base ? `Duplicate ${base.id}` : `New ${kind.label}`}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!idProblem || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
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
        <Field label="Id" hint={idProblem && id ? <span className="text-danger">{idProblem}</span> : (idHint ?? 'Referenced by runs; cannot be changed later.')}>
          <input className="mono" autoFocus value={id} onChange={(e) => setId(e.target.value.trim())} placeholder={placeholder} />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
        </Field>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
