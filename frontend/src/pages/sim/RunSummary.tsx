import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Badge, ErrorBox, Loading, Notice, Spinner } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { fmtCost } from '../../lib/util';
import type { RubricDef, SimRunDetail, SimSummary, SimSystemSummary, Stats } from '../../types';
import { heatStyle, MeterBar, StatValue } from './simUi';

type Col = {
  key: string;
  label: ReactNode;
  title?: string;
  /** Which mean is best (for the highlight); omit for no highlight. */
  best?: 'max' | 'min';
  stat?: (s: SimSystemSummary) => Stats | null;
  render: (s: SimSystemSummary) => ReactNode;
};

const COLUMNS: Col[] = [
  {
    key: 'conversations',
    label: 'Conversations',
    render: (s) => (
      <>
        {s.conversations}
        <div className="muted small">
          {s.status.completed ?? 0} done
          {s.status.failed ? <span className="text-danger"> · {s.status.failed} failed</span> : null}
          {s.status.cancelled ? <span className="text-warn"> · {s.status.cancelled} cancelled</span> : null}
        </div>
      </>
    ),
  },
  {
    key: 'score',
    label: 'Score',
    title: 'Judge score 0–100: mean ± half the 95% CI',
    best: 'max',
    stat: (s) => s.score,
    render: (s) => <StatValue s={s.score} />,
  },
  {
    key: 'expectation_score',
    label: 'Expectations',
    title: 'Judged expectation level / 3, as %',
    best: 'max',
    stat: (s) => s.expectation_score,
    render: (s) => <StatValue s={s.expectation_score} scale={100} digits={0} suffix="%" />,
  },
  {
    key: 'check_recall',
    label: 'Check recall',
    title: 'Share of expectation regex checks that matched, per conversation',
    best: 'max',
    stat: (s) => s.check_recall,
    render: (s) => <StatValue s={s.check_recall} scale={100} digits={0} suffix="%" />,
  },
  { key: 'turns', label: 'Turns', title: 'User turns per completed conversation', stat: (s) => s.turns, render: (s) => <StatValue s={s.turns} /> },
  {
    key: 'seconds_per_turn',
    label: 'Sec / turn',
    title: 'Seconds the system took per turn',
    best: 'min',
    stat: (s) => s.seconds_per_turn,
    render: (s) => <StatValue s={s.seconds_per_turn} />,
  },
  {
    key: 'llm_calls',
    label: 'LLM calls',
    title: "The system's LLM calls per conversation",
    best: 'min',
    stat: (s) => s.llm_calls,
    render: (s) => <StatValue s={s.llm_calls} />,
  },
  {
    key: 'tokens',
    label: 'Tokens',
    title: "The system's prompt + output tokens per conversation (thousands)",
    best: 'min',
    stat: (s) => s.tokens,
    render: (s) => <StatValue s={s.tokens} scale={0.001} suffix="k" />,
  },
  {
    key: 'ended_by',
    label: 'Ended by',
    render: (s) => (
      <span className="small">
        {Object.entries(s.ended_by)
          .map(([k, n]) => `${k} ${n}`)
          .join(' · ') || <span className="muted">—</span>}
      </span>
    ),
  },
  {
    key: 'issues',
    label: 'Issues',
    title: 'Recovery / error events in the traces',
    render: (s) =>
      Object.keys(s.issues).length ? (
        <div className="badges">
          {Object.entries(s.issues).map(([ev, n]) => (
            <Badge key={ev} tone={ev === 'run_error' || ev === 'context_error' ? 'danger' : 'warn'}>
              {ev} {n}
            </Badge>
          ))}
        </div>
      ) : (
        <span className="muted small">none</span>
      ),
  },
];

/** The value each highlighted column considers best (null when fewer than two systems have one). */
function bestValues(systems: SimSystemSummary[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const c of COLUMNS) {
    if (!c.best || !c.stat) continue;
    const vals = systems.map((s) => c.stat?.(s)?.mean).filter((v): v is number => v != null);
    out[c.key] = vals.length > 1 ? (c.best === 'max' ? Math.max(...vals) : Math.min(...vals)) : null;
  }
  return out;
}

/**
 * The run's results per system (from /summary): comparison table, criteria
 * and expectation means, the system × scenario score matrix and costs.
 */
export function RunSummary({
  run,
  rubric,
  onRubric,
  refreshKey,
  onRejudge,
}: {
  run: SimRunDetail;
  /** Selected rubric (null = the run's own / latest judgments). */
  rubric: string | null;
  onRubric: (r: string | null) => void;
  refreshKey: string;
  onRejudge?: () => void;
}) {
  const [data, setData] = useState<SimSummary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const rubrics = useLoad(api.rubrics.list, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.simulations
      .summary(run.id, rubric)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [run.id, rubric, refreshKey]);

  // Titles and ranges of the shown rubric's criteria (frozen copy when it is the run's own).
  const rubricDef: RubricDef | undefined = useMemo(() => {
    const id = data?.rubric;
    if (!id) return undefined;
    if (run.definitions.rubric?.id === id) return run.definitions.rubric;
    return rubrics.data?.find((r) => r.id === id);
  }, [data?.rubric, run.definitions.rubric, rubrics.data]);

  if (error != null && !data) return <ErrorBox error={error} title="Could not load the summary" />;
  if (!data) return <Loading label="Summarizing…" />;

  const systems = data.systems;
  const best = bestValues(systems);
  const scored = systems.some((s) => s.score || s.expectation_score);
  const noRubric = !data.rubric && data.rubrics.length === 0;
  const critKeys = Array.from(new Set([...(rubricDef?.criteria.map((c) => c.key) ?? []), ...systems.flatMap((s) => Object.keys(s.criteria))])).filter(
    (k) => systems.some((s) => s.criteria[k]),
  );
  const expNames = Array.from(new Set(systems.flatMap((s) => Object.keys(s.expectations))));
  const scenarioIds = Array.from(new Set([...run.config.scenarios, ...Object.values(data.by_scenario).flatMap((m) => Object.keys(m))]));
  const hasMatrix = Object.values(data.by_scenario).some((m) => Object.keys(m).length > 0);
  const rubricOptions = Array.from(new Set([...(run.config.rubric ? [run.config.rubric] : []), ...data.rubrics]));

  return (
    <section className="panel sim-summary">
      <div className="panel-title row space-between wrap">
        <span className="row gap-sm">
          Summary {loading && <Spinner />}
        </span>
        <span className="row gap-sm small">
          {rubricOptions.length > 1 || (rubricOptions.length === 1 && !run.config.rubric) ? (
            <label className="field-inline">
              scores from
              <select value={rubric ?? ''} onChange={(e) => onRubric(e.target.value || null)}>
                <option value="">{run.config.rubric ? `${run.config.rubric} (run's rubric)` : 'latest judgment of each'}</option>
                {rubricOptions
                  .filter((r) => r !== run.config.rubric)
                  .map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
              </select>
            </label>
          ) : data.rubric ? (
            <span className="muted">
              judged with <strong>{data.rubric}</strong>
            </span>
          ) : null}
        </span>
      </div>

      {noRubric && (
        <Notice tone="info">
          No rubric was used, so there are no scores — below are the metrics from the chats and the regex checks.{' '}
          {onRejudge && (
            <button className="link-btn" onClick={onRejudge}>
              Re-judge with a rubric…
            </button>
          )}
        </Notice>
      )}

      <div className="table-wrap">
        <table className="table compare-summary sim-systems">
          <thead>
            <tr>
              <th>System</th>
              {COLUMNS.filter((c) => scored || (c.key !== 'score' && c.key !== 'expectation_score')).map((c) => (
                <th key={c.key} className={c.stat ? 'num' : undefined} title={c.title}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {systems.map((s) => (
              <tr key={s.system}>
                <td>
                  <strong>{s.system}</strong>
                  {s.snapshot && (
                    <div>
                      <code className="muted small" title={`Snapshot ${s.snapshot}`}>
                        {s.snapshot.slice(0, 10)}
                      </code>
                    </div>
                  )}
                </td>
                {COLUMNS.filter((c) => scored || (c.key !== 'score' && c.key !== 'expectation_score')).map((c) => {
                  const v = c.stat?.(s)?.mean;
                  const isBest = best[c.key] != null && v != null && v === best[c.key];
                  return (
                    <td key={c.key} className={`${c.stat ? 'num' : ''}${isBest ? ' best' : ''}`}>
                      {c.render(s)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {systems.length === 0 && <div className="empty">No conversations.</div>}
      </div>
      {systems.length > 1 && <div className="field-hint">Green = best mean in the column (± = half the 95% confidence interval; overlapping intervals mean the difference may be noise).</div>}

      <div className="sim-summary-grid">
        {critKeys.length > 0 && (
          <div>
            <div className="subsection-title">Criteria (mean score)</div>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Criterion</th>
                  {systems.map((s) => (
                    <th key={s.system} className="num">
                      {s.system}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {critKeys.map((k) => {
                  const def = rubricDef?.criteria.find((c) => c.key === k);
                  return (
                    <tr key={k}>
                      <td title={def?.description}>
                        {def?.title || k}
                        {def && (
                          <span className="muted small">
                            {' '}
                            {def.min}–{def.max}
                            {def.weight !== 1 && ` ×${def.weight}`}
                          </span>
                        )}
                      </td>
                      {systems.map((s) => {
                        const st = s.criteria[k];
                        return (
                          <td key={s.system} className="num">
                            <StatValue s={st} digits={2} />
                            {def && st && <MeterBar value={(st.mean - def.min) / (def.max - def.min)} />}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {expNames.length > 0 && (
          <div>
            <div className="subsection-title">Expectations (mean level 0–3)</div>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Expectation</th>
                  {systems.map((s) => (
                    <th key={s.system} className="num">
                      {s.system}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {expNames.map((n) => (
                  <tr key={n}>
                    <td>{n}</td>
                    {systems.map((s) => {
                      const st = s.expectations[n];
                      return (
                        <td key={s.system} className="num">
                          <StatValue s={st} digits={2} />
                          {st && <MeterBar value={st.mean / 3} />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {hasMatrix && (
        <>
          <div className="subsection-title">Score by scenario</div>
          <div className="table-wrap">
            <table className="table table-compact sim-heat">
              <thead>
                <tr>
                  <th>Scenario</th>
                  {systems.map((s) => (
                    <th key={s.system} className="num">
                      {s.system}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scenarioIds.map((sc) => (
                  <tr key={sc}>
                    <td>{run.definitions.scenarios[sc]?.name || sc}</td>
                    {systems.map((s) => {
                      const st = data.by_scenario[s.system]?.[sc] ?? null;
                      return (
                        <td key={s.system} className="num" style={heatStyle(st?.mean)}>
                          <StatValue s={st} />
                          {st && <span className="muted small"> n={st.n}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="muted small sim-costs">
        Costs: simulator <strong>{fmtCost(data.costs.simulator, '$0')}</strong> · retrieval <strong>{fmtCost(data.costs.retrieval, '$0')}</strong> · judge{' '}
        <strong>{fmtCost(data.costs.judge, '$0')}</strong>
        <span> — the systems&apos; own agent calls are counted in tokens above, not priced here.</span>
      </div>
    </section>
  );
}
