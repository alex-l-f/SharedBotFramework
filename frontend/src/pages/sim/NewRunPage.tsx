import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { ModelSpecEditor, modelSummary } from '../../components/ModelSpecEditor';
import { ReadOnlyNote } from '../../components/team';
import { Badge, Collapsible, EmptyState, ErrorBox, Field, Loading, MessageList, NumberInput, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useLocalStorage, type Loaded } from '../../lib/hooks';
import { useSettings } from '../../lib/refdata';
import { isEmptyModel, newSimConfig, pluralize, simConfigPayload, stableStringify } from '../../lib/util';
import type { ProfileMode, ScenarioDef, SimPlan, SimRunConfig } from '../../types';
import { SimTabs } from './simUi';

const DRAFT_KEY = 'sbf.sim.newRun';

const PROFILE_MODE_HELP: Record<ProfileMode, string> = {
  fresh:
    'Each conversation gets a new throwaway profile, so memory agents run (and remember within the conversation); a scenario\'s memory profile is copied in first.',
  none: 'No profile: memory agents and profile-gated tools are skipped.',
};

/** /simulations/new — configure a run with a live plan; location.state.config prefills it. */
export function NewRunPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const settings = useSettings();
  const systems = useLoad(api.systems.list, []);
  const scenarios = useLoad(api.scenarios.list, []);
  const personas = useLoad(api.personas.list, []);
  const rubrics = useLoad(api.rubrics.list, []);
  // Viewers may plan a run (see what it would do) but not start one.
  const canStart = useAuth().can('editor');
  const [stored, setStored] = useLocalStorage<SimRunConfig>(DRAFT_KEY, newSimConfig());
  const prefill = (location.state as { config?: Partial<SimRunConfig> } | null)?.config;
  const [config, setConfigState] = useState<SimRunConfig>(() => ({ ...newSimConfig(), ...(prefill ?? stored) }));
  const setConfig = (c: SimRunConfig) => {
    setConfigState(c);
    setStored(c);
  };
  const set = <K extends keyof SimRunConfig>(key: K, value: SimRunConfig[K]) => setConfig({ ...config, [key]: value });

  // A prefilled config becomes the stored draft; drop it from the history entry so a reload keeps later edits.
  useEffect(() => {
    if (!prefill) return;
    setStored(config);
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const payload = useMemo(() => simConfigPayload(config), [config]);
  const plan = usePlan(payload);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>(null);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setStartError(null);
    try {
      const run = await api.simulations.start(payload);
      setStored(newSimConfig());
      navigate(`/simulations/runs/${run.id}`);
    } catch (e) {
      setStartError(e);
      setStarting(false);
    }
  };

  const presets = Object.keys(settings.data?.models ?? {});
  const missingPick = !config.systems.length || !config.scenarios.length;
  const ready = !missingPick && !!plan.data && !plan.loading && !plan.error && plan.data.problems.length === 0 && plan.data.conversations > 0;

  return (
    <div className="page page-wide">
      <div className="page-header">
        <div>
          <div className="crumbs">
            <Link to="/simulations">Simulations</Link> / <Link to="/simulations">Runs</Link> /
          </div>
          <h1>New run</h1>
          <div className="page-subtitle">
            Every system × scenario × persona × repetition becomes one simulated conversation. Systems are compiled once at the start and
            pinned for the whole run; the personas, scenarios and rubric are frozen with it.
          </div>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => window.confirm('Reset the form?') && setConfig(newSimConfig())}>
            Reset
          </button>
          {canStart ? (
            <button className="btn btn-primary" disabled={!ready || starting} onClick={() => void start()} title={ready ? undefined : 'Fix the plan first'}>
              {starting ? (
                <>
                  <Spinner /> Starting…
                </>
              ) : (
                'Start run'
              )}
            </button>
          ) : (
            <ReadOnlyNote />
          )}
        </div>
      </div>
      <SimTabs />
      {startError != null && <ErrorBox error={startError} title="Not started" />}

      <div className="editor-columns" style={{ marginTop: 0 }}>
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Run</h2>
            <div className="grid-2">
              <Field label="Name" hint="Default: the systems and the scenario count.">
                <input value={config.name} placeholder="e.g. coach vs single — sleep scenarios" onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Notes" hint="Stored with the run.">
                <input value={config.notes} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">
              Systems <Badge tone="muted">{config.systems.length}</Badge>
            </h2>
            {systems.loading && !systems.data && <Loading />}
            {systems.error != null && <ErrorBox error={systems.error} onRetry={systems.reload} title="Could not list systems" />}
            <div className="choice-list">
              {(systems.data ?? []).map((s) => {
                const on = config.systems.includes(s.id);
                return (
                  <label key={s.id} className={`choice${on ? ' active' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => set('systems', toggle(config.systems, s.id))} />
                    <span>
                      <strong>{s.name || s.id}</strong> <code className="muted small">{s.id}</code>{' '}
                      <span className="muted small">
                        · {pluralize(s.nodes.length, 'node')}
                        {s.memory?.enabled && ' · memory'}
                      </span>
                      {s.description && <div className="muted small clamp-1">{s.description}</div>}
                    </span>
                  </label>
                );
              })}
            </div>
            <MissingIds ids={config.systems} known={systems.data?.map((s) => s.id)} what="system" onRemove={(id) => set('systems', config.systems.filter((x) => x !== id))} />
          </section>

          <ScenarioPicker
            value={config.scenarios}
            onChange={(v) => set('scenarios', v)}
            scenarios={scenarios}
            explicitPersonas={config.personas.length > 0}
          />

          <section className="panel">
            <h2 className="panel-title">
              Personas <Badge tone="muted">{config.personas.length || 'scenario defaults'}</Badge>
            </h2>
            <p className="muted small">
              Optional. <strong>Empty = each scenario&apos;s own persona.</strong> Picking personas plays every chosen scenario with each of them
              instead.
            </p>
            {personas.error != null && <ErrorBox error={personas.error} onRetry={personas.reload} title="Could not list personas" />}
            {personas.data?.length === 0 && (
              <EmptyState>
                No personas yet — <Link to="/simulations/personas">create one</Link>.
              </EmptyState>
            )}
            <div className="choice-list sim-pick-list">
              {(personas.data ?? []).map((p) => {
                const on = config.personas.includes(p.id);
                return (
                  <label key={p.id} className={`choice${on ? ' active' : ''}`}>
                    <input type="checkbox" checked={on} onChange={() => set('personas', toggle(config.personas, p.id))} />
                    <span>
                      <strong>{p.name || p.id}</strong> <code className="muted small">{p.id}</code>
                      {p.description && <span className="muted small"> — {p.description}</span>}
                      {!isEmptyModel(p.model) && <div className="muted small mono">{modelSummary(p.model)}</div>}
                    </span>
                  </label>
                );
              })}
            </div>
            {config.personas.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => set('personas', [])}>
                Clear (use scenario defaults)
              </button>
            )}
            <MissingIds ids={config.personas} known={personas.data?.map((p) => p.id)} what="persona" onRemove={(id) => set('personas', config.personas.filter((x) => x !== id))} />
          </section>
        </div>

        <div className="stack">
          <PlanPanel plan={plan} missingPick={missingPick} config={config} />

          <section className="panel">
            <h2 className="panel-title">Settings</h2>
            <div className="grid-3">
              <Field label="Repetitions" hint="Each combination this many times (1–200).">
                <NumberInput integer min={1} max={200} value={config.repetitions} onChange={(n) => set('repetitions', n ?? 1)} />
              </Field>
              <Field label="Max turns" hint="Overrides the scenarios' max turns (blank = theirs).">
                <NumberInput integer min={1} max={50} value={config.max_turns} placeholder="scenario's" onChange={(n) => set('max_turns', n)} />
              </Field>
              <Field label="Concurrency" hint="Conversations at once (1–64).">
                <NumberInput integer min={1} max={64} value={config.concurrency} onChange={(n) => set('concurrency', n ?? 4)} />
              </Field>
            </div>
            <Field
              label="Rubric"
              hint={
                <>
                  The LLM judge grading each finished conversation (one extra call each). Optional — you can <em>re-judge</em> a finished run with
                  any rubric later.
                </>
              }
            >
              <select value={config.rubric} onChange={(e) => set('rubric', e.target.value)}>
                <option value="">(no judge — metrics and regex checks only)</option>
                {(rubrics.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id} ({r.criteria.length} criteria)
                  </option>
                ))}
                {config.rubric && rubrics.data && !rubrics.data.some((r) => r.id === config.rubric) && (
                  <option value={config.rubric}>{config.rubric} (missing)</option>
                )}
              </select>
            </Field>
            <Field label="Profile mode" hint={PROFILE_MODE_HELP[config.profile_mode]}>
              <div className="seg">
                {(['fresh', 'none'] as ProfileMode[]).map((m) => (
                  <button key={m} type="button" className={config.profile_mode === m ? 'active' : ''} onClick={() => set('profile_mode', m)}>
                    {m}
                  </button>
                ))}
              </div>
            </Field>
            <Collapsible
              title="Simulator model override"
              defaultOpen={!isEmptyModel(config.simulator_model)}
              right={<span className="muted small">{isEmptyModel(config.simulator_model) ? "personas' own" : modelSummary(config.simulator_model)}</span>}
            >
              <div className="field-hint" style={{ marginBottom: 6 }}>
                Replaces every persona&apos;s model for this run (fields set here win). Thinking stays off unless you set a reasoning effort.
              </div>
              <ModelSpecEditor value={config.simulator_model} onChange={(m) => set('simulator_model', isEmptyModel(m) ? null : m)} presets={presets} inheritNote="Blank fields keep the persona's." />
            </Collapsible>
            <Collapsible
              title="Judge model override"
              defaultOpen={!isEmptyModel(config.judge_model)}
              right={<span className="muted small">{isEmptyModel(config.judge_model) ? "rubric's own" : modelSummary(config.judge_model)}</span>}
            >
              <div className="field-hint" style={{ marginBottom: 6 }}>
                Replaces the rubric&apos;s judge model for this run. Prefer another model family than the systems&apos; bots.
              </div>
              <ModelSpecEditor value={config.judge_model} onChange={(m) => set('judge_model', isEmptyModel(m) ? null : m)} presets={presets} inheritNote="Blank fields keep the rubric's." />
            </Collapsible>
          </section>
        </div>
      </div>
    </div>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Selected ids that no longer exist (e.g. from a copied config). */
function MissingIds({ ids, known, what, onRemove }: { ids: string[]; known: string[] | undefined; what: string; onRemove: (id: string) => void }) {
  if (!known) return null;
  const missing = ids.filter((id) => !known.includes(id));
  if (!missing.length) return null;
  return (
    <div className="notice notice-warn small">
      Selected {what}(s) not found:{' '}
      {missing.map((id) => (
        <span key={id} className="chip">
          {id}
          <button type="button" onClick={() => onRemove(id)} aria-label={`Remove ${id}`}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function ScenarioPicker({
  value,
  onChange,
  scenarios,
  explicitPersonas,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  scenarios: Loaded<ScenarioDef[]>;
  explicitPersonas: boolean;
}) {
  const [q, setQ] = useState('');
  const list = scenarios.data ?? [];
  const needle = q.trim().toLowerCase();
  const shown = list.filter((s) => !needle || `${s.id} ${s.name} ${s.description} ${s.tags.join(' ')} ${s.persona}`.toLowerCase().includes(needle));
  const allShown = shown.length > 0 && shown.every((s) => value.includes(s.id));
  return (
    <section className="panel">
      <h2 className="panel-title">
        Scenarios <Badge tone="muted">{value.length}</Badge>
      </h2>
      <div className="row gap-sm" style={{ marginBottom: 6 }}>
        <input className="search" placeholder="Search scenarios…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button
          className="btn btn-sm"
          disabled={!shown.length}
          onClick={() =>
            onChange(allShown ? value.filter((id) => !shown.some((s) => s.id === id)) : Array.from(new Set([...value, ...shown.map((s) => s.id)])))
          }
        >
          {allShown ? 'Unselect' : 'Select'} {needle ? 'matching' : 'all'}
        </button>
      </div>
      {scenarios.loading && !scenarios.data && <Loading />}
      {scenarios.error != null && <ErrorBox error={scenarios.error} onRetry={scenarios.reload} title="Could not list scenarios" />}
      {scenarios.data?.length === 0 && (
        <EmptyState>
          No scenarios yet — <Link to="/simulations/scenarios">create one</Link>.
        </EmptyState>
      )}
      <div className="choice-list sim-pick-list">
        {shown.map((s) => {
          const on = value.includes(s.id);
          return (
            <label key={s.id} className={`choice${on ? ' active' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => onChange(toggle(value, s.id))} />
              <span>
                <strong>{s.name || s.id}</strong> <code className="muted small">{s.id}</code>{' '}
                <span className="muted small">
                  · persona{' '}
                  {s.persona ? <span className={explicitPersonas ? 'strike' : ''}>{s.persona}</span> : <span className="text-warn">none</span>} · ≤{' '}
                  {s.max_turns} turns · {pluralize(s.expectations.length, 'expectation')}
                </span>
                {s.description && <div className="muted small clamp-1">{s.description}</div>}
              </span>
            </label>
          );
        })}
      </div>
      {explicitPersonas && <div className="field-hint">Personas are picked for the run, so the scenarios&apos; default personas are not used.</div>}
      <MissingIds ids={value} known={scenarios.data?.map((s) => s.id)} what="scenario" onRemove={(id) => onChange(value.filter((x) => x !== id))} />
    </section>
  );
}

// ---------------------------------------------------------------------- plan

type PlanState = { data: SimPlan | null; error: unknown; loading: boolean };

/** POST /simulations/plan, debounced, whenever the config changes. */
function usePlan(config: SimRunConfig): PlanState {
  const [state, setState] = useState<PlanState>({ data: null, error: null, loading: false });
  const key = stableStringify(config);
  useEffect(() => {
    if (!config.systems.length || !config.scenarios.length) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(() => {
      api.simulations
        .plan(config)
        .then((data) => alive && setState({ data, error: null, loading: false }))
        .catch((error: unknown) => alive && setState({ data: null, error, loading: false }));
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

function PlanPanel({ plan, missingPick, config }: { plan: PlanState; missingPick: boolean; config: SimRunConfig }) {
  const d = plan.data;
  return (
    <section className="panel sim-plan">
      <h2 className="panel-title">
        Plan {plan.loading && <Spinner />}
      </h2>
      {missingPick && <div className="muted">Pick at least one system and one scenario.</div>}
      {plan.error != null && <ErrorBox error={plan.error} title="The configuration is invalid" />}
      {d && !missingPick && (
        <>
          <div className="sim-plan-numbers">
            <div>
              <div className="sim-big">{d.conversations}</div>
              <div className="muted small">conversations</div>
            </div>
            <div>
              <div className="sim-big">≤ {d.max_turns}</div>
              <div className="muted small">user turns in total</div>
            </div>
            <div>
              <div className="sim-big">{config.concurrency}</div>
              <div className="muted small">at once</div>
            </div>
            <div>
              <div className="sim-big">{d.judged ? 'yes' : 'no'}</div>
              <div className="muted small">judged</div>
            </div>
          </div>
          <MessageList tone="error" title="Problems — fix them to start" items={d.problems} />
          {d.problems.length === 0 && d.conversations > 0 && (
            <div className="notice notice-warn small">
              <strong className="inline">Runs make real LLM calls.</strong> Each user turn is one simulator call plus the system&apos;s own agent
              calls{d.judged ? ', and every finished conversation one judge call' : ''}: up to ~{d.max_turns} system turns here. Try 1 repetition
              and few turns first.
            </div>
          )}
          {d.sample.length > 0 && (
            <Collapsible className="compact" title={`First ${d.sample.length} of ${d.conversations} conversations`}>
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>System</th>
                    <th>Scenario</th>
                    <th>Persona</th>
                    <th className="num">Rep</th>
                  </tr>
                </thead>
                <tbody>
                  {d.sample.map((c, i) => (
                    <tr key={i}>
                      <td className="muted">{i + 1}</td>
                      <td>{c.system_id}</td>
                      <td>{c.scenario_id}</td>
                      <td>{c.persona_id || <span className="text-danger">none</span>}</td>
                      <td className="num">{c.rep}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Collapsible>
          )}
        </>
      )}
    </section>
  );
}
