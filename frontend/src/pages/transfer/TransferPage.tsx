// /transfer — Import / Export: bundles (zip) of definitions, optionally with
// what they depend on and the datasets' contents.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { DiffView } from '../../components/DiffView';
import { modelSummary } from '../../components/ModelSpecEditor';
import { Badge, EmptyState, ErrorBox, Loading, MessageList, Modal, Notice, PageHeader, type Tone } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useLocalStorage } from '../../lib/hooks';
import { invalidateAll } from '../../lib/refdata';
import { fmtBytes, fmtDateTime, pluralize, SLUG_RE } from '../../lib/util';
import { BUNDLE_KINDS, type BundleKind, type BundlePlan, type BundleRef, type ImportItem, type ImportPreview, type ImportResult } from '../../types';

const KINDS: Record<BundleKind, { label: string; one: string; link: (id: string) => string }> = {
  systems: { label: 'Systems', one: 'system', link: (id) => `/systems/${id}` },
  agents: { label: 'Agents', one: 'agent', link: (id) => `/agents/${id}` },
  classifiers: { label: 'Safety classifiers', one: 'classifier', link: (id) => `/safety/${id}` },
  memory_schemas: { label: 'Memory schemas', one: 'memory schema', link: () => '/settings#schemas' },
  fragments: { label: 'Fragments', one: 'fragment', link: () => '/settings#fragments' },
  datasets: { label: 'Datasets', one: 'dataset', link: (id) => `/data/datasets/${id}` },
  retrievers: { label: 'Retrievers', one: 'retriever', link: (id) => `/data/retrievers/${id}` },
  personas: { label: 'Personas', one: 'persona', link: (id) => `/simulations/personas/${id}` },
  scenarios: { label: 'Scenarios', one: 'scenario', link: (id) => `/simulations/scenarios/${id}` },
  rubrics: { label: 'Rubrics', one: 'rubric', link: (id) => `/simulations/rubrics/${id}` },
};

const keyOf = (kind: string, id: string) => `${kind}/${id}`;

interface DefEntry {
  kind: BundleKind;
  id: string;
  name: string;
  updated_at?: string | null;
  updated_by?: string | null;
}

type Listed = { id: string; name?: string; updated_at?: string | null; updated_by?: string | null };

/** Every definition here, from the list endpoints (a failing kind is reported, not fatal). */
function useAllDefinitions() {
  return useLoad(async () => {
    const loaders: Record<BundleKind, () => Promise<Listed[]>> = {
      systems: api.systems.list,
      agents: api.agents.list,
      classifiers: api.classifiers.list,
      memory_schemas: api.memorySchemas.list,
      fragments: api.fragments.list,
      datasets: api.datasets.list,
      retrievers: api.retrievers.list,
      personas: api.personas.list,
      scenarios: api.scenarios.list,
      rubrics: api.rubrics.list,
    };
    const results = await Promise.allSettled(BUNDLE_KINDS.map((k) => loaders[k]()));
    const entries: DefEntry[] = [];
    const errors: Partial<Record<BundleKind, unknown>> = {};
    results.forEach((r, i) => {
      const kind = BUNDLE_KINDS[i];
      if (r.status === 'fulfilled')
        entries.push(...r.value.map((d) => ({ kind, id: d.id, name: d.name ?? '', updated_at: d.updated_at, updated_by: d.updated_by })));
      else errors[kind] = r.reason;
    });
    return { entries, errors };
  }, []);
}

function Stamp({ at, by }: { at?: string | null; by?: string | null }) {
  if (!at && !by) return <span className="muted">—</span>;
  return (
    <span className="nowrap">
      {fmtDateTime(at)}
      {by && <span className="muted"> · {by}</span>}
    </span>
  );
}

export function TransferPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'export' | 'import'>(() => (window.location.hash === '#import' ? 'import' : 'export'));
  const defs = useAllDefinitions();
  const switchTab = (t: 'export' | 'import') => {
    setTab(t);
    window.history.replaceState(window.history.state, '', `#${t}`);
  };

  return (
    <div className="page page-wide">
      <PageHeader
        title="Import / Export"
        subtitle="Move definitions between SBF workspaces as a zip bundle: export a selection (with what it depends on), import it elsewhere and choose per definition what to do."
      />
      <div className="tabs">
        <button type="button" className={`tab${tab === 'export' ? ' active' : ''}`} onClick={() => switchTab('export')}>
          Export
        </button>
        <button type="button" className={`tab${tab === 'import' ? ' active' : ''}`} onClick={() => switchTab('import')}>
          Import
        </button>
      </div>
      {defs.error != null && <ErrorBox error={defs.error} onRetry={defs.reload} />}
      <div hidden={tab !== 'export'}>
        {defs.loading && !defs.data ? <Loading /> : <ExportSection entries={defs.data?.entries ?? []} errors={defs.data?.errors ?? {}} />}
      </div>
      <div hidden={tab !== 'import'}>
        {can('editor') ? (
          <ImportSection entries={defs.data?.entries ?? []} onImported={defs.reload} />
        ) : (
          <Notice>Importing bundles needs the editor role. You can export.</Notice>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- export

function ExportSection({ entries, errors }: { entries: DefEntry[]; errors: Partial<Record<BundleKind, unknown>> }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [deps, setDeps] = useLocalStorage('sbf.export.deps', true);
  const [withData, setWithData] = useLocalStorage('sbf.export.data', false);
  const [plan, setPlan] = useState<BundlePlan | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [planning, setPlanning] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);

  const items: BundleRef[] = useMemo(
    () =>
      Array.from(selected)
        .sort()
        .map((k) => {
          const i = k.indexOf('/');
          return { kind: k.slice(0, i) as BundleKind, id: k.slice(i + 1) };
        }),
    [selected],
  );
  const itemsKey = JSON.stringify(items);

  // Live plan of the selection.
  useEffect(() => {
    if (!items.length) {
      setPlan(null);
      setPlanError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      setPlanning(true);
      api.bundles
        .plan(items, deps)
        .then((p) => {
          if (!alive) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e: unknown) => alive && setPlanError(e))
        .finally(() => alive && setPlanning(false));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, deps]);

  const needle = q.trim().toLowerCase();
  const shown = (kind: BundleKind) =>
    entries.filter((e) => e.kind === kind && (!needle || `${e.id} ${e.name}`.toLowerCase().includes(needle)));

  const toggle = (key: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(key);
    else next.delete(key);
    setSelected(next);
    setDone(null);
  };
  const toggleAll = (list: DefEntry[], on: boolean) => {
    const next = new Set(selected);
    for (const e of list) {
      if (on) next.add(keyOf(e.kind, e.id));
      else next.delete(keyOf(e.kind, e.id));
    }
    setSelected(next);
    setDone(null);
  };

  const datasetsInPlan = (plan?.items ?? []).filter((i) => i.kind === 'datasets').length;

  const download = async () => {
    if (!items.length || downloading) return;
    setDownloading(true);
    setError(null);
    setDone(null);
    try {
      const { blob, filename } = await api.bundles.export(items, deps, withData);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? 'sbf-bundle.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(`Downloaded ${a.download} (${fmtBytes(blob.size)}).`);
    } catch (e) {
      setError(e);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="transfer-columns">
      <div className="stack">
        <div className="row gap-sm">
          <input className="search" placeholder="Filter definitions…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted small nowrap">{pluralize(selected.size, 'selected', 'selected')}</span>
          {selected.size > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
        {needle && !entries.some((e) => `${e.id} ${e.name}`.toLowerCase().includes(needle)) && <EmptyState>Nothing matches the filter.</EmptyState>}
        {BUNDLE_KINDS.map((kind) => {
          const list = shown(kind);
          const total = entries.filter((e) => e.kind === kind).length;
          const on = list.filter((e) => selected.has(keyOf(kind, e.id))).length;
          // Kinds without matches step aside while filtering.
          if ((!total || (needle && !list.length)) && errors[kind] == null) return null;
          return (
            <section key={kind} className="panel transfer-kind">
              <div className="row space-between">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={list.length > 0 && on === list.length}
                    ref={(el) => {
                      if (el) el.indeterminate = on > 0 && on < list.length;
                    }}
                    disabled={!list.length}
                    onChange={(e) => toggleAll(list, e.target.checked)}
                  />
                  <strong className="inline">{KINDS[kind].label}</strong>
                  <span className="muted small">
                    {needle ? `${list.length} of ${total}` : total}
                  </span>
                </label>
              </div>
              {errors[kind] != null && <ErrorBox error={errors[kind]} title={`Could not list ${KINDS[kind].label.toLowerCase()}`} />}
              {list.length === 0 && total > 0 && <div className="muted small">None match the filter.</div>}
              <ul className="transfer-list">
                {list.map((e) => {
                  const key = keyOf(kind, e.id);
                  return (
                    <li key={key}>
                      <label className="check">
                        <input type="checkbox" checked={selected.has(key)} onChange={(ev) => toggle(key, ev.target.checked)} />
                        <span className="transfer-name">
                          {e.name && e.name !== e.id ? <>{e.name} </> : null}
                          <code className="muted small">{e.id}</code>
                        </span>
                      </label>
                      <span className="muted small">
                        <Stamp at={e.updated_at} by={e.updated_by} />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>

      <div className="stack transfer-side">
        <section className="panel">
          <h2 className="panel-title">Bundle</h2>
          <label className="check">
            <input type="checkbox" checked={deps} onChange={(e) => setDeps(e.target.checked)} />
            Include what they depend on
          </label>
          <div className="field-hint">Agents of a system, the retrievers and datasets they search, memory schemas, fragments, default personas…</div>
          <label className="check">
            <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
            Include dataset contents (items and uploaded files)
          </label>
          <div className="field-hint">
            {withData
              ? 'Datasets carry their files and processed items (the zip can get large); importing them replaces the contents there.'
              : 'Datasets travel as definitions only; their files would have to be uploaded and processed again.'}
          </div>
          <div className="row gap-sm transfer-download">
            <button className="btn btn-primary" disabled={!items.length || downloading || !!planError} onClick={() => void download()}>
              {downloading ? 'Preparing…' : 'Download bundle'}
            </button>
            {planning && <span className="spinner" />}
          </div>
          {done && <Notice tone="ok">{done}</Notice>}
          {error != null && <ErrorBox error={error} title="Export failed" />}
        </section>

        <section className="panel">
          <h2 className="panel-title">
            Contents {plan && <Badge tone="muted">{plan.items.length}</Badge>}
          </h2>
          {!items.length && <EmptyState>Select definitions on the left.</EmptyState>}
          {planError != null && <ErrorBox error={planError} title="Could not plan the bundle" />}
          {plan && items.length > 0 && (
            <>
              <table className="table table-compact">
                <tbody>
                  {plan.items.map((i) => (
                    <tr key={keyOf(i.kind, i.id)}>
                      <td className="nowrap small muted">{KINDS[i.kind]?.one ?? i.kind}</td>
                      <td>
                        <Link to={KINDS[i.kind]?.link(i.id) ?? '#'}>{i.name || i.id}</Link> {i.name && i.name !== i.id && <code className="muted small">{i.id}</code>}
                        {i.reason === 'dependency' && (
                          <div className="muted small">
                            needed by {i.required_by.join(', ')}
                          </div>
                        )}
                      </td>
                      <td>{i.reason === 'dependency' ? <Badge tone="accent">dependency</Badge> : <Badge tone="neutral">selected</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {plan.presets.length > 0 && (
                <div className="small transfer-presets">
                  Model presets included: {plan.presets.map((p) => <code key={p}>{p}</code>)}
                </div>
              )}
              {withData && datasetsInPlan > 0 && (
                <div className="muted small">With the contents of {pluralize(datasetsInPlan, 'dataset')}.</div>
              )}
              <MessageList
                tone="warn"
                title="Model presets that aren't defined here (not included)"
                items={plan.unknown_presets}
              />
              <MessageList
                tone="warn"
                title="Missing definitions (referenced but not found here; not included)"
                items={plan.missing.map((m) => `${m.kind}/${m.id}${m.required_by.length ? ` — needed by ${m.required_by.join(', ')}` : ''}`)}
              />
              {!deps && <div className="muted small">Dependencies are left out: the importing side must already have them.</div>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- import

const STATUS_TONE: Record<string, Tone> = { new: 'ok', same: 'muted', changed: 'warn', invalid: 'danger' };
const STATUS_HELP: Record<string, string> = {
  new: 'Not here yet',
  same: 'Identical to the one here',
  changed: 'Differs from the one here',
  invalid: 'Could not be read from the bundle',
};

type Choice = 'create' | 'replace' | 'skip' | 'copy';

function choicesFor(item: ImportItem): Choice[] {
  if (item.status === 'invalid') return ['skip'];
  if (item.status === 'new') return ['create', 'copy', 'skip'];
  return ['replace', 'copy', 'skip'];
}

const CHOICE_LABEL: Record<Choice, string> = { create: 'Create', replace: 'Replace the one here', skip: 'Skip', copy: 'Copy as…' };

function ImportSection({ entries, onImported }: { entries: DefEntry[]; onImported: () => void }) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [actions, setActions] = useState<Record<string, Choice>>({});
  const [copyIds, setCopyIds] = useState<Record<string, string>>({});
  const [presetActions, setPresetActions] = useState<Record<string, string>>({});
  const [importData, setImportData] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [comparing, setComparing] = useState<ImportItem | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const start = (p: ImportPreview) => {
    setPreview(p);
    setResult(null);
    setActions(Object.fromEntries(p.items.map((i) => [i.key, (i.default_action as Choice) ?? 'skip'])));
    setCopyIds(Object.fromEntries(p.items.map((i) => [i.key, `${i.id}-2`])));
    setPresetActions(Object.fromEntries(p.presets.map((x) => [x.name, x.default_action])));
    setImportData(p.items.some((i) => i.has_data));
  };

  const upload = async (file: File | undefined) => {
    if (!file || uploading) return;
    setUploading(true);
    setError(null);
    try {
      if (preview) await api.bundles.discard(preview.token).catch(() => undefined);
      start(await api.bundles.upload(file));
    } catch (e) {
      setError(e);
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const cancel = async () => {
    if (preview) await api.bundles.discard(preview.token).catch(() => undefined);
    setPreview(null);
    setError(null);
  };

  // Local ids per kind (for copies).
  const localIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of entries) {
      if (!m.has(e.kind)) m.set(e.kind, new Set());
      m.get(e.kind)?.add(e.id);
    }
    return m;
  }, [entries]);

  const copyProblem = (item: ImportItem): string | null => {
    const id = (copyIds[item.key] ?? '').trim();
    if (!id) return 'Give the copy an id';
    if (!SLUG_RE.test(id)) return 'Lowercase letters, digits, - and _';
    if (localIds.get(item.kind)?.has(id)) return 'Exists here already';
    const clash = (preview?.items ?? []).some(
      (o) =>
        o.key !== item.key &&
        o.kind === item.kind &&
        ((actions[o.key] === 'copy' && (copyIds[o.key] ?? '').trim() === id) || (actions[o.key] === 'create' && o.id === id)),
    );
    return clash ? 'Another import uses this id' : null;
  };

  const problems = (preview?.items ?? []).filter((i) => actions[i.key] === 'copy' && copyProblem(i));
  const chosen = (preview?.items ?? []).filter((i) => actions[i.key] && actions[i.key] !== 'skip');
  const presetsChosen = (preview?.presets ?? []).filter((p) => presetActions[p.name] && presetActions[p.name] !== 'skip');

  const apply = async () => {
    if (!preview || applying || problems.length) return;
    setApplying(true);
    setError(null);
    try {
      const body = {
        actions: Object.fromEntries(
          preview.items.map((i) => [i.key, actions[i.key] === 'copy' ? `copy:${(copyIds[i.key] ?? '').trim()}` : actions[i.key] ?? 'skip']),
        ),
        presets: presetActions,
        import_data: importData,
      };
      const r = await api.bundles.apply(preview.token, body);
      setResult(r);
      setPreview(null);
      invalidateAll();
      onImported();
    } catch (e) {
      setError(e);
    } finally {
      setApplying(false);
    }
  };

  if (result) {
    const failed = result.items.filter((i) => !i.ok).length + result.presets.filter((p) => !p.ok).length;
    const imported = result.items.filter((i) => i.ok && i.action !== 'skip');
    return (
      <div className="stack">
        <Notice tone={failed ? 'warn' : 'ok'}>
          Imported {pluralize(imported.length, 'definition')}
          {failed > 0 && <>; {failed} failed</>}.
        </Notice>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Definition</th>
                <th>Action</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((i) => (
                <tr key={i.key} className={i.action === 'skip' ? 'row-dim' : undefined}>
                  <td>
                    <span className="muted small">{KINDS[i.kind]?.one ?? i.kind}</span>{' '}
                    {i.ok && i.action !== 'skip' ? <Link to={KINDS[i.kind]?.link(i.target) ?? '#'}>{i.target}</Link> : <code>{i.id}</code>}
                    {i.target !== i.id && <span className="muted small"> (from {i.id})</span>}
                  </td>
                  <td className="small">{i.action.startsWith('copy:') ? 'copy' : i.action}</td>
                  <td className="small">
                    {i.ok ? (
                      <>
                        <Badge tone={i.action === 'skip' ? 'muted' : 'ok'}>{i.action === 'skip' ? 'skipped' : 'done'}</Badge>
                        {i.items != null && <span className="muted"> · {pluralize(i.items, 'item')} imported</span>}
                      </>
                    ) : (
                      <span className="text-danger">{i.error}</span>
                    )}
                  </td>
                </tr>
              ))}
              {result.presets.map((p) => (
                <tr key={`preset/${p.name}`}>
                  <td>
                    <span className="muted small">model preset</span> <Link to="/settings">{p.name}</Link>
                  </td>
                  <td className="small">{p.action}</td>
                  <td className="small">{p.ok ? <Badge tone={p.action === 'add' || p.action === 'replace' ? 'ok' : 'muted'}>{p.action === 'kept' ? 'kept (exists)' : 'done'}</Badge> : <span className="text-danger">{p.error}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <button className="btn" onClick={() => setResult(null)}>
            Import another bundle
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      {!preview && (
        <div
          className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void upload(e.dataTransfer.files[0]);
          }}
        >
          <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          <div>
            <strong>{uploading ? 'Reading the bundle…' : 'Drop a bundle (.zip) here'}</strong> or{' '}
            <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
              Choose file…
            </button>
          </div>
          <div className="muted small">Nothing changes until you review the contents and press Import.</div>
        </div>
      )}
      {error != null && <ErrorBox error={error} title={preview ? 'Import failed' : 'Not a usable bundle'} />}

      {preview && (
        <>
          <section className="panel">
            <div className="row space-between wrap gap-sm">
              <div>
                <h2 className="panel-title">{preview.filename ?? 'Bundle'}</h2>
                <div className="muted small">
                  Exported {fmtDateTime(preview.manifest.exported_at)}
                  {preview.manifest.exported_by && <> by {preview.manifest.exported_by}</>} · SBF {preview.manifest.sbf_version}
                </div>
              </div>
              <div className="row gap-sm">
                <button className="btn" onClick={() => void cancel()} disabled={applying}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  disabled={applying || !!problems.length || (!chosen.length && !presetsChosen.length)}
                  onClick={() => void apply()}
                  title={problems.length ? 'Fix the copy ids first' : undefined}
                >
                  {applying ? 'Importing…' : `Import ${pluralize(chosen.length, 'definition')}`}
                </button>
              </div>
            </div>
            <MessageList tone="warn" title="Warnings from the export" items={preview.manifest.warnings ?? []} />
            {preview.items.some((i) => i.has_data) && (
              <label className="check">
                <input type="checkbox" checked={importData} onChange={(e) => setImportData(e.target.checked)} />
                Import dataset contents (items and files) carried by the bundle
              </label>
            )}
          </section>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Definition</th>
                  <th>Status</th>
                  <th>In the bundle</th>
                  <th>Here</th>
                  <th>Action</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((i) => {
                  const choice = actions[i.key] ?? 'skip';
                  const problem = choice === 'copy' ? copyProblem(i) : null;
                  const writes = choice !== 'skip';
                  return (
                    <tr key={i.key} className={choice === 'skip' ? 'row-dim' : undefined}>
                      <td>
                        <span className="muted small">{KINDS[i.kind]?.one ?? i.kind}</span>{' '}
                        <strong className="inline">{i.name || i.id}</strong> {i.name && i.name !== i.id && <code className="muted small">{i.id}</code>}
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[i.status] ?? 'neutral'} title={STATUS_HELP[i.status]}>
                          {i.status}
                        </Badge>
                        {i.status === 'changed' && (
                          <button type="button" className="link-btn small" onClick={() => setComparing(i)}>
                            Compare
                          </button>
                        )}
                      </td>
                      <td className="small">
                        <Stamp at={i.bundle.updated_at} by={i.bundle.updated_by} />
                      </td>
                      <td className="small">{i.local ? <Stamp at={i.local.updated_at} by={i.local.updated_by} /> : <span className="muted">—</span>}</td>
                      <td>
                        <select value={choice} onChange={(e) => setActions({ ...actions, [i.key]: e.target.value as Choice })} style={{ width: 'auto' }}>
                          {choicesFor(i).map((c) => (
                            <option key={c} value={c}>
                              {CHOICE_LABEL[c]}
                            </option>
                          ))}
                        </select>
                        {choice === 'copy' && (
                          <div className="transfer-copy">
                            <input
                              className={`mono${problem ? ' invalid' : ''}`}
                              value={copyIds[i.key] ?? ''}
                              onChange={(e) => setCopyIds({ ...copyIds, [i.key]: e.target.value.trim() })}
                              placeholder={`${i.id}-2`}
                            />
                            {problem ? (
                              <span className="field-error">{problem}</span>
                            ) : (
                              <span className="field-hint">Other imported definitions that use it are pointed at the copy.</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="small transfer-notes">
                        {i.error && <div className="text-danger">{i.error}</div>}
                        {i.unresolved.length > 0 && (
                          <div className="text-warn" title="Neither in the bundle nor here">
                            Missing references: {i.unresolved.join(', ')}
                          </div>
                        )}
                        {i.kind === 'datasets' &&
                          writes &&
                          (i.has_data ? (
                            importData ? (
                              choice === 'replace' && (i.local_items ?? 0) > 0 ? (
                                <div className="text-warn">Replaces the {pluralize(i.local_items ?? 0, 'item')} here with the bundle&apos;s contents.</div>
                              ) : (
                                <div>With its items and files.</div>
                              )
                            ) : (
                              <div className="muted">Definition only (contents not imported).</div>
                            )
                          ) : (
                            <div className="muted">Definition only (the bundle has no contents).</div>
                          ))}
                        {choice === 'replace' && i.status === 'changed' && <div className="muted">Overwrites the version here (it stays in its history).</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {preview.items.length === 0 && <EmptyState>The bundle has no definitions.</EmptyState>}
          </div>

          {preview.presets.length > 0 && (
            <section className="panel">
              <h2 className="panel-title">Model presets</h2>
              <table className="table table-compact">
                <tbody>
                  {preview.presets.map((p) => (
                    <tr key={p.name}>
                      <td>
                        <code>{p.name}</code>
                      </td>
                      <td>
                        <Badge tone={STATUS_TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
                      </td>
                      <td className="small mono">{modelSummary(p.spec)}</td>
                      <td>
                        <select
                          value={presetActions[p.name] ?? 'skip'}
                          onChange={(e) => setPresetActions({ ...presetActions, [p.name]: e.target.value })}
                          style={{ width: 'auto' }}
                        >
                          {p.status === 'new' ? <option value="add">Add</option> : p.status === 'changed' ? <option value="replace">Replace the one here</option> : null}
                          <option value="skip">Skip</option>
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field-hint">Presets go into the runtime settings (settings.yaml).</div>
            </section>
          )}
        </>
      )}

      {comparing && preview && <CompareModal token={preview.token} item={comparing} onClose={() => setComparing(null)} />}
    </div>
  );
}

function CompareModal({ token, item, onClose }: { token: string; item: ImportItem; onClose: () => void }) {
  const cmp = useLoad(() => api.bundles.compare(token, item.kind, item.id), [token, item.kind, item.id]);
  return (
    <Modal title={`Compare ${KINDS[item.kind]?.one ?? item.kind} ${item.id}`} onClose={onClose} size="xl">
      {cmp.loading && <Loading />}
      {cmp.error != null && <ErrorBox error={cmp.error} onRetry={cmp.reload} />}
      {cmp.data?.error && <Notice tone="error">{cmp.data.error}</Notice>}
      {cmp.data && (
        <DiffView
          a={cmp.data.local}
          b={cmp.data.bundle}
          aLabel={`here${item.local?.updated_by ? ` (${item.local.updated_by})` : ''}`}
          bLabel={`in the bundle${item.bundle.updated_by ? ` (${item.bundle.updated_by})` : ''}`}
        />
      )}
    </Modal>
  );
}
