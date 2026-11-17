import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { fmtDateTime, fmtDuration, fmtTime } from '../lib/util';
import type { SimRunSummary } from '../types';
import { fmtScore, isActiveRun, ProgressBar, progressText, SIM_HELP, SimStatusBadge, SimTabs } from './sim/simUi';

const POLL_MS = 3000;

/** /simulations — the Runs tab: every run with live progress. */
export function SimulationsPage() {
  const runs = useLoad(api.simulations.list, []);
  const [q, setQ] = useState('');
  const [error, setError] = useState<unknown>(null);
  const navigate = useNavigate();
  const canEdit = useAuth().can('editor');

  // Poll while any run is queued / running.
  const live = (runs.data ?? []).some(isActiveRun);
  const { reload } = runs;
  useEffect(() => {
    if (!live || runs.loading) return;
    const t = setTimeout(reload, runs.error ? POLL_MS * 3 : POLL_MS);
    return () => clearTimeout(t);
  }, [live, runs.loading, runs.error, reload]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (runs.data ?? []).filter(
      (r) =>
        !needle ||
        `${r.id} ${r.name} ${r.status} ${r.config.systems.join(' ')} ${r.config.scenarios.join(' ')} ${r.config.rubric} ${r.created_by ?? ''}`.toLowerCase().includes(needle),
    );
  }, [runs.data, q]);

  const remove = async (r: SimRunSummary) => {
    const { total } = progressText(r.counts);
    if (!window.confirm(`Delete run "${r.name || r.id}" with its ${total} conversation(s), their chats and throwaway profiles? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.simulations.remove(r.id);
      runs.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="page page-wide">
      <PageHeader
        title="Simulations"
        subtitle={SIM_HELP.runs}
        actions={
          <>
            <input className="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
            {canEdit && (
              <Link className="btn btn-primary" to="/simulations/new">
                + New run
              </Link>
            )}
          </>
        }
      />
      <SimTabs />
      {error != null && <ErrorBox error={error} title="Not deleted" />}
      {runs.loading && !runs.data && <Loading />}
      {runs.error != null && <ErrorBox error={runs.error} onRetry={runs.reload} title="Could not list runs" />}
      {runs.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Systems</th>
                <th>Plan</th>
                <th>Rubric</th>
                <th className="num">Mean score</th>
                <th>Created</th>
                <th>Took</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const { done, total, failed } = progressText(r.counts);
                const active = isActiveRun(r);
                return (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/simulations/runs/${r.id}`)}>
                    <td>
                      <Link to={`/simulations/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                        <strong>{r.name || r.id}</strong>
                      </Link>
                      <div>
                        <code className="muted small">{r.id}</code>
                      </div>
                      {r.error && <div className="small text-danger clamp-2" title={r.error}>{r.error}</div>}
                    </td>
                    <td>
                      <SimStatusBadge status={r.status} />
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <ProgressBar counts={r.counts} />
                      <div className="small muted">
                        {done} / {total} done
                        {failed > 0 && <span className="text-danger"> · {failed} failed</span>}
                        {(r.counts.running ?? 0) > 0 && <span> · {r.counts.running} running</span>}
                      </div>
                    </td>
                    <td>
                      <div className="badges">
                        {r.config.systems.map((s) => (
                          <Badge key={s} tone="neutral" title={r.systems[s] ? `snapshot ${r.systems[s]}` : undefined}>
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="small nowrap">
                      {r.config.scenarios.length} scen.
                      {r.config.personas.length > 0 && <> × {r.config.personas.length} pers.</>} × {r.config.repetitions} rep
                      {r.config.max_turns != null && <div className="muted">≤ {r.config.max_turns} turns</div>}
                    </td>
                    <td className="small nowrap">{r.config.rubric || <span className="muted">—</span>}</td>
                    <td className="num">
                      <strong>{fmtScore(r.mean_score)}</strong>
                    </td>
                    <td className="small muted nowrap">
                      {fmtDateTime(r.created_at)}
                      {r.created_by && <div>by {r.created_by}</div>}
                    </td>
                    <td className="small nowrap">
                      {r.started_at && r.finished_at ? (
                        fmtDuration(r.started_at, r.finished_at)
                      ) : r.started_at ? (
                        <span className="muted">since {fmtTime(r.started_at)}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      {canEdit && (
                        <button
                          className="btn btn-ghost btn-icon danger"
                          title={active ? 'Cancel the run before deleting it' : 'Delete run'}
                          disabled={active}
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove(r);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState>
              {runs.data.length ? (
                'No runs match the filter.'
              ) : (
                <>
                  No runs yet. Set up <Link to="/simulations/personas">personas</Link> and <Link to="/simulations/scenarios">scenarios</Link>{' '}
                  (and optionally a <Link to="/simulations/rubrics">rubric</Link>), then start a <Link to="/simulations/new">new run</Link>.
                </>
              )}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
