import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { Badge, Collapsible, EmptyState, ErrorBox, Field, Loading, Modal, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { useSettings } from '../../lib/refdata';
import { fmtDateTime, fmtDuration, fmtSeconds, fmtTime, isEmptyModel, pluralize } from '../../lib/util';
import type { ModelSpec, SimConversationRow, SimRunDetail } from '../../types';
import { ConversationDetail } from './ConversationDetail';
import { RunSummary } from './RunSummary';
import { ChecksChips, ENDED_BY_HELP, fmtPct, fmtScore, heatStyle, isActiveRun, ProgressBar, progressText, SimStatusBadge, SimTabs, STATUS_TONE } from './simUi';

const POLL_MS = 3000;

/** /simulations/runs/:runId — progress, summary and conversations of one run. */
export function RunPage() {
  const { runId = '' } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [run, setRun] = useState<SimRunDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [rubric, setRubric] = useState<string | null>(null);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [full, setFull] = useState(true);
  const canEdit = useAuth().can('editor');
  const current = useRef(runId);
  current.current = runId;
  const rubricRef = useRef(rubric);
  rubricRef.current = rubric;
  const hasRun = useRef(false);
  hasRun.current = !!run;

  const refresh = useCallback(async () => {
    const id = runId;
    try {
      const r = await api.simulations.get(id, rubricRef.current);
      if (current.current !== id) return;
      setRun(r);
      setPollError(null);
      setLoadError(null);
    } catch (e) {
      if (current.current !== id) return;
      if (hasRun.current) setPollError(e);
      else setLoadError(e);
    } finally {
      if (current.current === id) setTick((t) => t + 1);
    }
  }, [runId]);

  useEffect(() => {
    setRun(null);
    hasRun.current = false;
    setLoadError(null);
    setRubric(null);
    void refresh();
  }, [refresh]);

  // The conversations table scores by the rubric the summary shows.
  useEffect(() => {
    if (hasRun.current) void refresh();
  }, [rubric, refresh]);

  const live = !!run && isActiveRun(run);
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => void refresh(), pollError ? POLL_MS * 3 : POLL_MS);
    return () => clearTimeout(t);
  }, [live, tick, pollError, refresh]);

  const showFlash = (text: string) => {
    setFlash(text);
    setTimeout(() => setFlash(null), 4000);
  };

  // Changes whenever something the summary depends on changes.
  const summaryKey = useMemo(
    () => (run ? `${run.status}|${run.judging}|${run.conversations.map((c) => `${c.status}:${c.score}:${c.judge_status}`).join(',')}` : ''),
    [run],
  );

  const convParam = params.get('conv');
  const openConv = convParam ? Number(convParam) : null;
  const setOpenConv = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id == null) next.delete('conv');
    else next.set('conv', String(id));
    setParams(next, { replace: id == null });
  };

  if (loadError != null)
    return (
      <div className="page">
        <ErrorBox error={loadError} title={`Could not load run "${runId}"`} onRetry={() => void refresh()} />
        <Link to="/simulations">← Runs</Link>
      </div>
    );
  if (!run)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const c = run.config;
  const { done, total, failed } = progressText(run.counts);
  const retryable = (run.counts.failed ?? 0) + (run.counts.cancelled ?? 0);
  const completed = run.counts.completed ?? 0;

  const act = async (fn: () => Promise<void>) => {
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e);
    }
  };
  const cancel = () =>
    act(async () => {
      if (!window.confirm('Cancel the run? Queued conversations are cancelled; running ones stop after their current turn.')) return;
      setRun(await api.simulations.cancel(run.id));
      showFlash('Cancelling…');
    });
  const retry = (ids?: number[]) =>
    act(async () => {
      const n = ids?.length ?? retryable;
      if (!window.confirm(`Run ${pluralize(n, 'failed / cancelled conversation')} again in fresh chats? This makes real LLM calls.`)) return;
      const r = await api.simulations.retry(run.id, ids);
      showFlash(`Retrying ${r.retried}`);
      await refresh();
    });
  const remove = () =>
    act(async () => {
      if (!window.confirm(`Delete run "${run.name || run.id}" with its ${total} conversation(s), their chats and throwaway profiles? This cannot be undone.`))
        return;
      await api.simulations.remove(run.id);
      navigate('/simulations');
    });

  return (
    <div className="page page-wide">
      <div className="page-header sticky-header">
        <div>
          <div className="crumbs">
            <Link to="/simulations">Simulations</Link> / <Link to="/simulations">Runs</Link> /
          </div>
          <h1 className="row gap-sm wrap">
            {run.name || run.id} <SimStatusBadge status={run.status} />
            {run.judging && <SimStatusBadge status="judging" title="Re-judging in the background" />}
          </h1>
          <div className="page-subtitle row gap-sm wrap">
            <code>{run.id}</code>
            <span>
              · created {fmtDateTime(run.created_at)}
              {run.created_by && <> by {run.created_by}</>}
            </span>
            {run.started_at && (
              <span>
                {/* Server timestamps are naive local time: only durations between two of them are reliable. */}
                · {run.finished_at ? `took ${fmtDuration(run.started_at, run.finished_at)}` : `started ${fmtTime(run.started_at)}`}
              </span>
            )}
            <span>
              · {c.scenarios.length} scenario(s){c.personas.length ? ` × ${c.personas.length} persona(s)` : ''} × {c.repetitions} rep · concurrency{' '}
              {c.concurrency}
              {c.max_turns != null && ` · ≤ ${c.max_turns} turns`} · profile {c.profile_mode}
            </span>
            <span>
              · rubric{' '}
              {c.rubric ? <Link to={`/simulations/rubrics/${c.rubric}`}>{c.rubric}</Link> : <span className="muted">none</span>}
            </span>
          </div>
        </div>
        <div className="page-actions" hidden={!canEdit}>
          {flash && <span className="flash">{flash}</span>}
          {run.active && (
            <button className="btn btn-danger-ghost" onClick={() => void cancel()}>
              Cancel run
            </button>
          )}
          {!run.active && retryable > 0 && (
            <button className="btn" onClick={() => void retry()} title="Re-runs failed / cancelled conversations in fresh chats">
              Retry {retryable} {run.counts.cancelled ? (run.counts.failed ? 'failed / cancelled' : 'cancelled') : 'failed'}
            </button>
          )}
          <button
            className="btn"
            disabled={run.judging || completed === 0}
            onClick={() => setJudgeOpen(true)}
            title={run.judging ? 'Already judging' : completed === 0 ? 'No completed conversations yet' : 'Grade the completed conversations with a rubric'}
          >
            Re-judge…
          </button>
          <button className="btn" onClick={() => navigate('/simulations/new', { state: { config: { ...c, name: c.name ? `${c.name} (again)` : '' } } })}>
            Run again…
          </button>
          <button className="btn btn-danger-ghost" disabled={run.active || run.judging} onClick={() => void remove()} title={run.active ? 'Cancel the run first' : 'Delete'}>
            Delete
          </button>
        </div>
      </div>
      <SimTabs />
      {actionError != null && <ErrorBox error={actionError} title="Action failed" />}
      {pollError != null && <ErrorBox error={pollError} title="Could not refresh the run" onRetry={() => void refresh()} />}
      {run.error && (
        <div className="notice notice-error">
          <strong>The run failed</strong>
          <div className="pre-wrap small">{run.error}</div>
        </div>
      )}

      <section className="panel sim-run-status">
        <div className="row gap-sm wrap space-between">
          <div className="grow" style={{ minWidth: 260 }}>
            <ProgressBar counts={run.counts} large />
            <div className="small row gap-sm wrap" style={{ marginTop: 4 }}>
              <span>
                <strong>
                  {done} / {total}
                </strong>{' '}
                done
              </span>
              {Object.entries(run.counts)
                .filter(([, n]) => n > 0)
                .map(([s, n]) => (
                  <span key={s} className={`status-${STATUS_TONE[s] ?? 'neutral'}`}>
                    · {n} {s}
                  </span>
                ))}
              {failed > 0 && !run.active && <span className="muted">— see the errors in the table; “Retry” runs them again</span>}
            </div>
          </div>
          <div className="row gap-sm wrap">
            <span className="small muted">Systems (pinned):</span>
            {c.systems.map((s) => (
              <Badge key={s} tone="neutral" title={run.systems[s] ? `snapshot ${run.systems[s]}` : 'not compiled yet'}>
                {s}
                {run.systems[s] && <code className="muted"> {run.systems[s].slice(0, 8)}</code>}
              </Badge>
            ))}
          </div>
        </div>
        <div className="row gap-sm wrap sim-export">
          <span className="small muted">Export:</span>
          <a className="btn btn-sm" href={api.simulations.exportUrl(run.id, 'jsonl', full, rubric)} download>
            JSONL
          </a>
          <a className="btn btn-sm" href={api.simulations.exportUrl(run.id, 'csv', full, rubric)} download>
            CSV
          </a>
          <label className="check small" title="JSONL only: adds every chat output, trace event and the frozen scenario / persona definitions">
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> full (outputs, traces, definitions)
          </label>
          <span className="muted small">JSONL: one record per conversation (transcript, metrics, judgments). CSV: one row each with scores.</span>
        </div>
      </section>

      <RunSummary run={run} rubric={rubric} onRubric={setRubric} refreshKey={summaryKey} onRejudge={canEdit && completed > 0 && !run.judging ? () => setJudgeOpen(true) : undefined} />

      <Conversations run={run} onOpen={setOpenConv} />

      {openConv != null && (
        <ConversationDrawer
          convId={openConv}
          row={run.conversations.find((x) => x.id === openConv)}
          onClose={() => setOpenConv(null)}
          onRetry={canEdit && !run.active ? (id) => void retry([id]) : undefined}
        />
      )}

      {judgeOpen && (
        <RejudgeModal
          run={run}
          onClose={() => setJudgeOpen(false)}
          onStarted={(rubricId, n) => {
            setJudgeOpen(false);
            setRubric(rubricId === run.config.rubric ? null : rubricId);
            showFlash(`Judging ${pluralize(n, 'conversation')}…`);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- conversations

function Conversations({ run, onOpen }: { run: SimRunDetail; onOpen: (id: number) => void }) {
  const [system, setSystem] = useState('');
  const [scenario, setScenario] = useState('');
  const [persona, setPersona] = useState('');
  const [status, setStatus] = useState('');
  const convs = run.conversations;
  const uniq = (f: (c: SimConversationRow) => string) => Array.from(new Set(convs.map(f)));
  const systems = uniq((c) => c.system_id);
  const scenarios = uniq((c) => c.scenario_id);
  const personas = uniq((c) => c.persona_id);
  const statuses = uniq((c) => c.status);
  const rows = convs.filter(
    (c) => (!system || c.system_id === system) && (!scenario || c.scenario_id === scenario) && (!persona || c.persona_id === persona) && (!status || c.status === status),
  );
  const select = (label: string, value: string, set: (v: string) => void, options: string[]) =>
    options.length > 1 || value ? (
      <label className="field-inline small">
        {label}
        <select value={value} onChange={(e) => set(e.target.value)}>
          <option value="">all</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  return (
    <>
      <div className="row space-between wrap section-title">
        <h2>
          Conversations <Badge tone="muted">{rows.length === convs.length ? convs.length : `${rows.length} / ${convs.length}`}</Badge>
        </h2>
        <div className="row gap-sm wrap">
          {select('system', system, setSystem, systems)}
          {select('scenario', scenario, setScenario, scenarios)}
          {select('persona', persona, setPersona, personas)}
          {select('status', status, setStatus, statuses)}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table sim-convs">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>System</th>
              <th>Scenario</th>
              <th>Persona</th>
              <th className="num">Rep</th>
              <th>Status</th>
              <th className="num">Turns</th>
              <th>Ended by</th>
              <th className="num">Time</th>
              <th className="num" title="Judge score 0–100 (the rubric selected in the summary)">
                Score
              </th>
              <th className="num" title="Judged expectation level / 3">
                Exp.
              </th>
              <th>Checks</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => onOpen(c.id)}>
                <td className="num muted">{c.idx + 1}</td>
                <td>{c.system_id}</td>
                <td>{run.definitions.scenarios[c.scenario_id]?.name || c.scenario_id}</td>
                <td className="small">{c.persona_id}</td>
                <td className="num">{c.rep}</td>
                <td>
                  <SimStatusBadge status={c.status} title={c.error ?? undefined} />
                  {c.judge_status === 'failed' && (
                    <div>
                      <Badge tone="danger" title="The judge failed; see the details">
                        judge failed
                      </Badge>
                    </div>
                  )}
                  {c.error && <div className="small text-danger clamp-1" title={c.error}>{c.error}</div>}
                </td>
                <td className="num">{c.turns}</td>
                <td className="small" title={c.ended_by ? ENDED_BY_HELP[c.ended_by] : undefined}>
                  {c.ended_by ?? <span className="muted">—</span>}
                </td>
                <td className="num small nowrap">{c.seconds ? fmtSeconds(c.seconds) : <span className="muted">—</span>}</td>
                <td className="num" style={heatStyle(c.score)}>
                  <strong>{fmtScore(c.score)}</strong>
                </td>
                <td className="num">{fmtPct(c.expectation_score)}</td>
                <td>
                  <ChecksChips checks={c.checks} compact />
                </td>
                <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                  <button className="btn btn-sm btn-ghost" onClick={() => onOpen(c.id)}>
                    Details
                  </button>
                  {c.chat_id && (
                    <Link className="btn btn-sm btn-ghost" to={`/chat/${c.system_id}/${c.chat_id}`} title="Open in the chat view (live while running, with traces)">
                      Chat ↗
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <EmptyState>{convs.length ? 'No conversations match the filters.' : 'No conversations.'}</EmptyState>}
      </div>
    </>
  );
}

function ConversationDrawer({
  convId,
  row,
  onClose,
  onRetry,
}: {
  convId: number;
  row: SimConversationRow | undefined;
  onClose: () => void;
  onRetry?: (id: number) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  const key = row ? `${row.status}|${row.turns}|${row.score}|${row.judge_status}|${row.chat_id}` : '';
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer drawer-wide sim-drawer" role="dialog" aria-modal="true">
        <div className="drawer-header">
          <h3>Conversation {row ? `#${row.idx + 1}` : ''}</h3>
          <span className="row gap-sm">
            <Link className="btn btn-sm btn-ghost" to={`/simulations/conversations/${convId}`}>
              Open as page
            </Link>
            <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
              ×
            </button>
          </span>
        </div>
        <div className="drawer-body">
          <ConversationDetail convId={convId} refreshKey={key} onRetry={onRetry} />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ re-judge

function RejudgeModal({ run, onClose, onStarted }: { run: SimRunDetail; onClose: () => void; onStarted: (rubric: string, n: number) => void }) {
  const rubrics = useLoad(api.rubrics.list, []);
  const settings = useSettings();
  const [rubric, setRubric] = useState(run.config.rubric);
  const [model, setModel] = useState<ModelSpec>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const list = rubrics.data ?? [];
  const chosen = rubric || list[0]?.id || '';
  const completed = run.counts.completed ?? 0;

  const submit = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.simulations.judge(run.id, { rubric: chosen, model: isEmptyModel(model) ? null : model });
      onStarted(chosen, r.judging);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Re-judge the run"
      onClose={onClose}
      size="md"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!chosen || busy} onClick={() => void submit()}>
            {busy ? 'Starting…' : `Judge ${pluralize(completed, 'conversation')}`}
          </button>
        </>
      }
    >
      <p className="muted small" style={{ marginTop: 0 }}>
        Grades every completed conversation with a rubric (the current saved version), in the background — one judge LLM call each. Earlier
        judgments are kept; the summary can switch between rubrics.
      </p>
      {rubrics.loading && !rubrics.data && <Loading />}
      {rubrics.error != null && <ErrorBox error={rubrics.error} onRetry={rubrics.reload} />}
      {rubrics.data && list.length === 0 && (
        <EmptyState>
          No rubrics yet — <Link to="/simulations/rubrics">create one</Link>.
        </EmptyState>
      )}
      {list.length > 0 && (
        <Field label="Rubric">
          <select value={chosen} onChange={(e) => setRubric(e.target.value)}>
            {list.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.id} ({r.criteria.length} criteria{r.grade_expectations ? ' + expectations' : ''})
                {r.id === run.config.rubric ? ' — the run’s rubric' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Collapsible title="Judge model override" right={<span className="muted small">{isEmptyModel(model) ? "rubric's own" : 'custom'}</span>}>
        <ModelSpecEditor value={model} onChange={setModel} presets={Object.keys(settings.data?.models ?? {})} inheritNote="Blank fields keep the rubric's model." />
      </Collapsible>
      {error != null && <ErrorBox error={error} title="Not started" />}
      {busy && <Spinner />}
    </Modal>
  );
}
