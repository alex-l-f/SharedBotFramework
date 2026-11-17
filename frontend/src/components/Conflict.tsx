// One dialog for every editor whose save hit a newer version (409 with
// `conflict`): who changed it and when, a field-by-field three-way
// comparison (what I changed, what they changed, what both changed), and
// merge / overwrite / load theirs / keep editing.

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { conflictOf } from '../api';
import { excerpt, mergeMine, pathLabel, threeWay, type FieldChange } from '../lib/diff';
import { fmtDateTime, pluralize } from '../lib/util';
import type { ConflictInfo } from '../types';
import { ErrorBox, Modal } from './ui';

export interface ConflictOptions<P> {
  /** What is being edited, for the dialog text ("agent “coach”"). */
  what: string;
  /** The stored definition (`conflict.current`) → the editor's payload form. */
  toPayload: (current: Record<string, unknown>) => P;
  /** Saves `payload` based on `version` (null: unconditionally) and makes it the editor's saved state; throws on failure. */
  persist: (payload: P, version: string | null) => Promise<void>;
  /** Drops the draft and reloads from the server. */
  reload: () => void;
  /** After a delete: saves the draft as new (default: persist without a version). */
  recreate?: (payload: P) => Promise<void>;
  /** After a delete: leaves the editor (default: reload). */
  discard?: () => void;
}

interface Pending<P> {
  info: ConflictInfo;
  /** What the editor loaded. */
  base: P;
  /** The draft that was being saved. */
  mine: P;
}

/**
 * Call `catchConflict(err, base, mine)` from a save's catch: it returns true
 * (and opens the dialog) when the save failed on a newer version. Render
 * `dialog` somewhere in the editor.
 */
export function useConflicts<P>(opts: ConflictOptions<P>): {
  catchConflict: (err: unknown, base: P, mine: P) => boolean;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending<P> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const catchConflict = useCallback((err: unknown, base: P, mine: P) => {
    const info = conflictOf(err);
    if (!info) return false;
    setPending({ info, base, mine });
    return true;
  }, []);
  const dialog = pending ? (
    <ConflictDialog
      key={`${pending.info.version}`}
      pending={pending}
      opts={optsRef.current}
      onClose={() => setPending(null)}
      onAgain={(info) => setPending({ ...pending, info })}
    />
  ) : null;
  return { catchConflict, dialog };
}

function ConflictDialog<P>({
  pending,
  opts,
  onClose,
  onAgain,
}: {
  pending: Pending<P>;
  opts: ConflictOptions<P>;
  onClose: () => void;
  onAgain: (info: ConflictInfo) => void;
}) {
  const { info, base, mine } = pending;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const theirs = useMemo(() => (info.current ? opts.toPayload(info.current) : null), [info, opts]);
  const cmp = useMemo(() => (theirs ? threeWay(base, mine, theirs) : null), [base, mine, theirs]);

  const run = async (label: string, fn: () => Promise<void> | void) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      const again = conflictOf(e);
      if (again) onAgain(again);
      else setError(e);
    } finally {
      setBusy(null);
    }
  };

  const who = info.updated_by || 'Someone';
  const when = info.updated_at ? fmtDateTime(info.updated_at) : null;

  if (info.deleted || !cmp || !theirs) {
    return (
      <Modal
        title="Deleted while you were editing"
        onClose={onClose}
        size="md"
        footer={
          <>
            <button className="btn" disabled={!!busy} onClick={onClose}>
              Keep editing
            </button>
            <button className="btn btn-danger-ghost" disabled={!!busy} onClick={() => void run('discard', () => (opts.discard ?? opts.reload)())}>
              Discard my edits
            </button>
            <button
              className="btn btn-primary"
              disabled={!!busy}
              onClick={() => void run('recreate', () => (opts.recreate ? opts.recreate(mine) : opts.persist(mine, null)))}
            >
              {busy === 'recreate' ? 'Saving…' : 'Recreate it with my version'}
            </button>
          </>
        }
      >
        <div className="notice notice-warn">
          <strong>
            {who} deleted {opts.what}
            {when && <> ({when})</>}.
          </strong>
          Your draft is still here: save it again under the same id, or discard it.
        </div>
        {error != null && <ErrorBox error={error} title="Not saved" />}
      </Modal>
    );
  }

  const canMerge = cmp.conflicts.length === 0 && cmp.mine.length > 0;
  const merged = canMerge ? mergeMine(theirs, cmp.mine) : null;

  return (
    <Modal
      title="Changed while you were editing"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button className="btn" disabled={!!busy} onClick={onClose} title="Close this; nothing is saved">
            Keep editing
          </button>
          <button className="btn btn-danger-ghost" disabled={!!busy} onClick={() => void run('load', opts.reload)} title="Discard your edits and load the saved version">
            Load theirs
          </button>
          <button
            className="btn"
            disabled={!!busy}
            onClick={() => void run('overwrite', () => opts.persist(mine, info.version))}
            title="Save your draft as it is, replacing their changes"
          >
            {busy === 'overwrite' ? 'Saving…' : 'Save mine anyway'}
          </button>
          <button
            className="btn btn-primary"
            disabled={!!busy || !merged}
            onClick={() => merged && void run('merge', () => opts.persist(merged, info.version))}
            title={
              cmp.conflicts.length
                ? 'Not possible: some fields were changed on both sides'
                : !cmp.mine.length
                  ? 'You have no changes of your own left'
                  : 'Their version plus your changes'
            }
          >
            {busy === 'merge' ? 'Saving…' : 'Merge and save'}
          </button>
        </>
      }
    >
      <div className="notice notice-warn">
        <strong>
          {who} saved {opts.what}
          {when && <> at {when}</>} while you were editing it.
        </strong>
        {cmp.conflicts.length
          ? `${pluralize(cmp.conflicts.length, 'field')} changed on both sides, so the edits can't be merged automatically. Save yours anyway (theirs are lost), or load theirs and redo your edits.`
          : cmp.mine.length
            ? 'No field was changed on both sides: merging keeps their changes and adds yours.'
            : 'Your draft has no changes of your own beyond theirs.'}
      </div>
      {error != null && <ErrorBox error={error} title="Not saved" />}
      <ChangeTable title="Changed on both sides" tone="danger" changes={cmp.conflicts} three />
      <ChangeTable title="Your changes" tone="accent" changes={cmp.mine} side="mine" />
      <ChangeTable title={`${who}'s changes`} tone="warn" changes={cmp.theirs} side="theirs" />
      <ChangeTable title="Same change on both sides" tone="muted" changes={cmp.same} side="mine" />
    </Modal>
  );
}

function ChangeTable({
  title,
  tone,
  changes,
  side,
  three,
}: {
  title: string;
  tone: 'danger' | 'accent' | 'warn' | 'muted';
  changes: FieldChange[];
  side?: 'mine' | 'theirs';
  three?: boolean;
}) {
  if (!changes.length) return null;
  return (
    <div className="conflict-section">
      <div className={`conflict-title tone-${tone}`}>
        {title} <span className="muted small">({changes.length})</span>
      </div>
      <table className="table table-compact conflict-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Before</th>
            {three ? (
              <>
                <th>Yours</th>
                <th>Theirs</th>
              </>
            ) : (
              <th>{side === 'mine' ? 'Yours' : 'Now'}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {changes.map((c) => (
            <tr key={pathLabel(c.path)}>
              <td>
                <code>{pathLabel(c.path)}</code>
              </td>
              <td className="conflict-value muted">{excerpt(c.base, side === 'theirs' ? c.theirs : c.mine)}</td>
              {three ? (
                <>
                  <td className="conflict-value">{excerpt(c.mine, c.base)}</td>
                  <td className="conflict-value">{excerpt(c.theirs, c.base)}</td>
                </>
              ) : (
                <td className="conflict-value">{excerpt(side === 'mine' ? c.mine : c.theirs, c.base)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
