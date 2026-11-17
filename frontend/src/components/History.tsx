// Revision history of one definition: the list of saves, each one's content
// and a diff against the editor's draft, and "Load into editor".

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useLoad } from '../lib/hooks';
import { fmtBytes, fmtDateTime } from '../lib/util';
import type { DefKindName, Revision, RevisionAction, RevisionDetail } from '../types';
import { DiffView } from './DiffView';
import { Badge, EmptyState, ErrorBox, Loading, Modal, type Tone } from './ui';

const ACTION: Record<RevisionAction, { label: string; tone: Tone; help: string }> = {
  save: { label: 'saved', tone: 'accent', help: 'Saved in the app' },
  delete: { label: 'deleted', tone: 'danger', help: 'Deleted in the app' },
  baseline: { label: 'original', tone: 'muted', help: 'The file as it was before its first change in the app' },
  external: { label: 'edited on disk', tone: 'warn', help: 'Changed outside the app (captured before the next save)' },
  import: { label: 'imported', tone: 'observe', help: 'Imported from a bundle' },
};

export interface HistoryProps<P> {
  kind: DefKindName;
  id: string;
  /** What to call it in the title ("agent coach"). */
  label?: string;
  /** The editor's draft, compared with each revision. */
  current: P | null;
  /** The version the editor was loaded from (marked in the list). */
  baseVersion?: string | null;
  /** A revision's definition (defaults filled in) → the editor's payload form. */
  toPayload: (data: Record<string, unknown>) => P;
  /** Puts a revision into the draft; omit it for someone who can't save. */
  onLoad?: (payload: P) => void;
  /** Compare plain text (fragments) instead of fields. */
  asText?: (p: P) => string;
}

/**
 * The latest recorded change of a definition without its own stamps
 * (fragments, settings), for "saved … by …". Re-read when `tick` changes.
 */
export function useLastChange(kind: DefKindName, id: string | null, tick: unknown): Revision | null {
  const [last, setLast] = useState<Revision | null>(null);
  useEffect(() => {
    if (!id) {
      setLast(null);
      return;
    }
    let alive = true;
    api.revisions
      .list(kind, id, 1)
      .then((r) => alive && setLast(r[0] ?? null))
      .catch(() => alive && setLast(null));
    return () => {
      alive = false;
    };
  }, [kind, id, tick]);
  return last;
}

export function HistoryButton<P>(props: HistoryProps<P> & { small?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn${props.small ? ' btn-sm' : ''}`} onClick={() => setOpen(true)} title="Earlier versions, who saved them, and what changed">
        History
      </button>
      {open && <HistoryModal {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function HistoryModal<P>({ kind, id, label, current, baseVersion, toPayload, onLoad, asText, onClose }: HistoryProps<P> & { onClose: () => void }) {
  const list = useLoad(() => api.revisions.list(kind, id), [kind, id]);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<RevisionDetail | null>(null);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [view, setView] = useState<'diff' | 'file'>('diff');

  useEffect(() => {
    if (selected == null && list.data?.length) setSelected(list.data[0].id);
  }, [list.data, selected]);

  useEffect(() => {
    if (selected == null) return;
    let alive = true;
    setDetail(null);
    setDetailError(null);
    api.revisions
      .get(kind, id, selected)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setDetailError(e));
    return () => {
      alive = false;
    };
  }, [kind, id, selected]);

  const payload = useMemo(() => (detail?.data ? toPayload(detail.data) : null), [detail, toPayload]);

  return (
    <Modal title={`History — ${label ?? `${kind}/${id}`}`} onClose={onClose} size="xl">
      <div className="rev-layout">
        <aside className="rev-list">
          {list.loading && !list.data && <Loading />}
          {list.error != null && <ErrorBox error={list.error} onRetry={list.reload} />}
          {list.data && list.data.length === 0 && <EmptyState>No recorded changes yet. History starts with the first save in the app.</EmptyState>}
          <ul className="select-list">
            {(list.data ?? []).map((r: Revision) => {
              const a = ACTION[r.action] ?? { label: r.action, tone: 'neutral' as Tone, help: '' };
              return (
                <li key={r.id}>
                  <button type="button" className={r.id === selected ? 'active' : ''} onClick={() => setSelected(r.id)}>
                    <span className="rev-entry">
                      <span>
                        <Badge tone={a.tone} title={a.help}>
                          {a.label}
                        </Badge>{' '}
                        {r.actor ? <strong className="inline">{r.actor}</strong> : <span className="muted">unknown</span>}
                        {baseVersion && r.version === baseVersion && (
                          <Badge tone="ok" title="The version this editor was loaded from">
                            loaded
                          </Badge>
                        )}
                      </span>
                      <span className="muted small">
                        {fmtDateTime(r.ts)}
                        {r.size != null && r.action !== 'delete' && <> · {fmtBytes(r.size)}</>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
        <section className="rev-main">
          {detailError != null && <ErrorBox error={detailError} />}
          {selected != null && !detail && detailError == null && <Loading />}
          {detail && (
            <>
              <div className="row space-between wrap gap-sm">
                <div>
                  <strong className="inline">{ACTION[detail.action]?.label ?? detail.action}</strong>
                  {detail.actor && <> by {detail.actor}</>} · {fmtDateTime(detail.ts)}
                  {detail.version && <code className="muted small"> {detail.version}</code>}
                </div>
                <div className="row gap-sm">
                  <span className="seg">
                    <button type="button" className={view === 'diff' ? 'active' : ''} onClick={() => setView('diff')}>
                      Changes vs your draft
                    </button>
                    <button type="button" className={view === 'file' ? 'active' : ''} onClick={() => setView('file')}>
                      File
                    </button>
                  </span>
                  {onLoad && payload != null && (
                    <button
                      className="btn btn-primary btn-sm"
                      title="Replace the draft with this version (nothing is saved until you save)"
                      onClick={() => {
                        onLoad(payload);
                        onClose();
                      }}
                    >
                      Load into editor
                    </button>
                  )}
                </div>
              </div>
              {detail.action === 'delete' ? (
                <EmptyState>Deleted here — nothing to show.</EmptyState>
              ) : view === 'file' ? (
                <pre className="code-block rev-file">{detail.content}</pre>
              ) : payload == null || current == null ? (
                <EmptyState>Nothing to compare.</EmptyState>
              ) : asText ? (
                <DiffView a={asText(current)} b={asText(payload)} aLabel="your draft" bLabel="this version" text />
              ) : (
                <DiffView a={current} b={payload} aLabel="your draft" bLabel="this version" />
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
