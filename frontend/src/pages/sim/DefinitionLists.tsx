import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { modelSummary } from '../../components/ModelSpecEditor';
import { WhenBy } from '../../components/team';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { clipText, isEmptyModel } from '../../lib/util';
import type { PersonaSummary, RubricDef, ScenarioDef } from '../../types';
import { CreateDefinitionModal, type DefBase, type DefKind } from './defs';
import { PERSONA_KIND, RUBRIC_KIND, SCENARIO_KIND } from './kinds';
import { SIM_HELP, SimTabs } from './simUi';

/** Page frame shared by the three lists: header (filter, + New), tabs, error/loading. */
function ListFrame({
  help,
  newLabel,
  q,
  setQ,
  onNew,
  children,
}: {
  help: ReactNode;
  newLabel: string;
  q: string;
  setQ: (q: string) => void;
  onNew: () => void;
  children: ReactNode;
}) {
  const canEdit = useAuth().can('editor');
  return (
    <div className="page page-wide">
      <PageHeader
        title="Simulations"
        subtitle={help}
        actions={
          <>
            <input className="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
            {canEdit && (
              <button className="btn btn-primary" onClick={onNew}>
                + {newLabel}
              </button>
            )}
          </>
        }
      />
      <SimTabs />
      {children}
    </div>
  );
}

function useFiltered<T>(items: T[] | undefined, q: string, text: (t: T) => string): T[] {
  return useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (items ?? []).filter((t) => !needle || text(t).toLowerCase().includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, q]);
}

function DefCell({ d, path, description }: { d: DefBase; path: string; description?: string }) {
  return (
    <td style={{ minWidth: 200, maxWidth: 320 }}>
      <Link to={`${path}/${d.id}`} onClick={(e) => e.stopPropagation()}>
        <strong>{d.name || d.id}</strong>
      </Link>{' '}
      <code className="muted small">{d.id}</code>
      {description && <div className="muted small clamp-2">{description}</div>}
    </td>
  );
}

function Tags({ tags }: { tags: string[] }) {
  return (
    <div className="badges">
      {tags.map((t) => (
        <Badge key={t}>{t}</Badge>
      ))}
    </div>
  );
}

function DeleteButton({ title, onClick }: { title: string; onClick: () => void }) {
  const canEdit = useAuth().can('editor');
  if (!canEdit) return null;
  return (
    <button
      className="btn btn-ghost btn-icon danger"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      ×
    </button>
  );
}

function useListActions<T extends DefBase, S extends T>(kind: DefKind<T, S>, reload: () => void) {
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const remove = async (d: DefBase, extra = '') => {
    if (!window.confirm(`Delete ${kind.label} "${d.id}"?${extra}`)) return;
    setError(null);
    try {
      await kind.remove(d.id, d.version);
      reload();
    } catch (e) {
      setError(e);
    }
  };
  const modal = (existing: string[]) =>
    creating && (
      <CreateDefinitionModal
        kind={kind}
        existing={existing}
        onClose={() => setCreating(false)}
        onCreated={(d) => navigate(`${kind.path}/${d.id}`)}
        placeholder={`e.g. ${kind.label === 'persona' ? 'tired-night-nurse' : kind.label === 'scenario' ? 'sleep-after-shift' : 'coach-quality'}`}
      />
    );
  return { error, remove, open: () => setCreating(true), modal, navigate };
}

// ------------------------------------------------------------------ personas

const USED_BY_SHOWN = 8;

export function PersonasList() {
  const personas = useLoad(api.personas.list, []);
  const [q, setQ] = useState('');
  const { error, remove, open, modal, navigate } = useListActions(PERSONA_KIND, personas.reload);
  const rows = useFiltered(personas.data, q, (p: PersonaSummary) => `${p.id} ${p.name} ${p.description} ${p.tags.join(' ')} ${p.profile}`);

  return (
    <ListFrame help={SIM_HELP.personas} newLabel="New persona" q={q} setQ={setQ} onNew={open}>
      {error != null && <ErrorBox error={error} title="Not deleted" />}
      {personas.loading && !personas.data && <Loading />}
      {personas.error != null && <ErrorBox error={personas.error} onRetry={personas.reload} />}
      {personas.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Persona</th>
                <th>Tags</th>
                <th>Profile</th>
                <th>Model</th>
                <th>Default persona of</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/simulations/personas/${p.id}`)}>
                  <DefCell d={p} path="/simulations/personas" description={p.description} />
                  <td>
                    <Tags tags={p.tags} />
                  </td>
                  <td className="small" style={{ minWidth: 220, maxWidth: 420 }}>
                    {p.profile ? <span className="clamp-2">{clipText(p.profile, 300)}</span> : <span className="muted">—</span>}
                  </td>
                  <td className="small mono">{isEmptyModel(p.model) ? <span className="muted">default</span> : modelSummary(p.model)}</td>
                  <td style={{ maxWidth: 380 }}>
                    {p.used_by.length ? (
                      <div className="badges" title={p.used_by.join(', ')}>
                        {p.used_by.slice(0, USED_BY_SHOWN).map((s) => (
                          <Link key={s} to={`/simulations/scenarios/${s}`} className="badge badge-accent" onClick={(e) => e.stopPropagation()}>
                            {s}
                          </Link>
                        ))}
                        {p.used_by.length > USED_BY_SHOWN && <span className="muted small">+{p.used_by.length - USED_BY_SHOWN} more</span>}
                      </div>
                    ) : (
                      <span className="muted small">—</span>
                    )}
                  </td>
                  <td className="small muted nowrap">
                    <WhenBy at={p.updated_at} by={p.updated_by} />
                  </td>
                  <td className="num">
                    <DeleteButton title="Delete persona" onClick={() => void remove(p)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState>{personas.data.length ? 'No personas match the filter.' : 'No personas yet. Create one: who the simulated user is and how they type.'}</EmptyState>
          )}
        </div>
      )}
      {modal((personas.data ?? []).map((p) => p.id))}
    </ListFrame>
  );
}

// ----------------------------------------------------------------- scenarios

export function ScenariosList() {
  const scenarios = useLoad(api.scenarios.list, []);
  const personas = useLoad(api.personas.list, []);
  const [q, setQ] = useState('');
  const { error, remove, open, modal, navigate } = useListActions(SCENARIO_KIND, scenarios.reload);
  const rows = useFiltered(
    scenarios.data,
    q,
    (s: ScenarioDef) => `${s.id} ${s.name} ${s.description} ${s.tags.join(' ')} ${s.persona} ${s.opening} ${s.goal}`,
  );
  const personaIds = new Set((personas.data ?? []).map((p) => p.id));

  return (
    <ListFrame help={SIM_HELP.scenarios} newLabel="New scenario" q={q} setQ={setQ} onNew={open}>
      {error != null && <ErrorBox error={error} title="Not deleted" />}
      {scenarios.loading && !scenarios.data && <Loading />}
      {scenarios.error != null && <ErrorBox error={scenarios.error} onRetry={scenarios.reload} />}
      {scenarios.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Tags</th>
                <th>Opening</th>
                <th>Persona</th>
                <th className="num">Max turns</th>
                <th className="num" title="Expectations (with a regex check)">Expectations</th>
                <th>Profile</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const checks = s.expectations.filter((e) => e.pattern).length;
                return (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/simulations/scenarios/${s.id}`)}>
                    <DefCell d={s} path="/simulations/scenarios" description={s.description} />
                    <td>
                      <Tags tags={s.tags} />
                    </td>
                    <td className="small" style={{ minWidth: 220, maxWidth: 380 }}>
                      {s.opening ? (
                        <>
                          <Badge tone="muted" title={s.opening_mode === 'exact' ? 'Sent verbatim' : 'The simulator writes its own, close to it'}>
                            {s.opening_mode}
                          </Badge>{' '}
                          <span className="clamp-2">“{clipText(s.opening, 200)}”</span>
                        </>
                      ) : (
                        <span className="muted">(simulator opens)</span>
                      )}
                    </td>
                    <td>
                      {s.persona ? (
                        <Link
                          to={`/simulations/personas/${s.persona}`}
                          className={`badge ${!personas.data || personaIds.has(s.persona) ? 'badge-neutral' : 'badge-danger'}`}
                          title={personas.data && !personaIds.has(s.persona) ? 'Persona not found' : undefined}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.persona}
                        </Link>
                      ) : (
                        <span className="muted small">none</span>
                      )}
                    </td>
                    <td className="num">{s.max_turns}</td>
                    <td className="num">
                      {s.expectations.length}
                      {checks > 0 && <span className="muted small"> ({checks} regex)</span>}
                    </td>
                    <td className="small">{s.profile || <span className="muted">—</span>}</td>
                    <td className="num">
                      <DeleteButton title="Delete scenario" onClick={() => void remove(s)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState>{scenarios.data.length ? 'No scenarios match the filter.' : 'No scenarios yet. Create one: what the simulated user is dealing with and wants.'}</EmptyState>
          )}
        </div>
      )}
      {modal((scenarios.data ?? []).map((s) => s.id))}
    </ListFrame>
  );
}

// ------------------------------------------------------------------- rubrics

export function RubricsList() {
  const rubrics = useLoad(api.rubrics.list, []);
  const [q, setQ] = useState('');
  const { error, remove, open, modal, navigate } = useListActions(RUBRIC_KIND, rubrics.reload);
  const rows = useFiltered(
    rubrics.data,
    q,
    (r: RubricDef) => `${r.id} ${r.name} ${r.description} ${r.tags.join(' ')} ${r.criteria.map((c) => `${c.key} ${c.title}`).join(' ')}`,
  );

  return (
    <ListFrame help={SIM_HELP.rubrics} newLabel="New rubric" q={q} setQ={setQ} onNew={open}>
      {error != null && <ErrorBox error={error} title="Not deleted" />}
      {rubrics.loading && !rubrics.data && <Loading />}
      {rubrics.error != null && <ErrorBox error={rubrics.error} onRetry={rubrics.reload} />}
      {rubrics.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rubric</th>
                <th>Tags</th>
                <th>Criteria</th>
                <th>Expectations</th>
                <th>Judge model</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/simulations/rubrics/${r.id}`)}>
                  <DefCell d={r} path="/simulations/rubrics" description={r.description} />
                  <td>
                    <Tags tags={r.tags} />
                  </td>
                  <td>
                    <div className="badges">
                      {r.criteria.map((c) => (
                        <Badge key={c.key} tone="neutral" title={`${c.title || c.key}: ${c.min}–${c.max}, weight ${c.weight}`}>
                          {c.key}
                          {c.weight !== 1 && <span className="muted"> ×{c.weight}</span>}
                        </Badge>
                      ))}
                      {r.criteria.length === 0 && <span className="muted small">none</span>}
                    </div>
                  </td>
                  <td className="small">{r.grade_expectations ? 'graded 0–3' : <span className="muted">not graded</span>}</td>
                  <td className="small mono">{isEmptyModel(r.model) ? <span className="muted">default</span> : modelSummary(r.model)}</td>
                  <td className="small muted nowrap">
                    <WhenBy at={r.updated_at} by={r.updated_by} />
                  </td>
                  <td className="num">
                    <DeleteButton title="Delete rubric" onClick={() => void remove(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState>{rubrics.data.length ? 'No rubrics match the filter.' : 'No rubrics yet. Create one to have an LLM judge grade the conversations.'}</EmptyState>
          )}
        </div>
      )}
      {modal((rubrics.data ?? []).map((r) => r.id))}
    </ListFrame>
  );
}
