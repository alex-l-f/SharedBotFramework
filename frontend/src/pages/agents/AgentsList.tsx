import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { WhenBy } from '../../components/team';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { invalidate } from '../../lib/refdata';
import type { AgentDef } from '../../types';
import { CreateAgentModal } from './CreateAgentModal';

export function AgentsList() {
  const agents = useLoad(api.agents.list, []);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const canEdit = useAuth().can('editor');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (agents.data ?? []).filter(
      (a) => !needle || `${a.id} ${a.name} ${a.description} ${a.tags.join(' ')}`.toLowerCase().includes(needle),
    );
  }, [agents.data, q]);

  return (
    <div className="page">
      <PageHeader
        title="Agents"
        subtitle="Reusable agents: prompt, tools, model and limits. Agents know nothing about the systems they are deployed in."
        actions={
          <>
            <input className="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} />
            {canEdit && (
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                + New agent
              </button>
            )}
          </>
        }
      />
      {agents.loading && !agents.data && <Loading />}
      {agents.error != null && <ErrorBox error={agents.error} onRetry={agents.reload} />}
      {agents.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Tags</th>
                <th className="num">Tools</th>
                <th className="num">Prompt</th>
                <th>Model</th>
                <th>Used by</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => navigate(`/agents/${a.id}`)}>
                  <td>
                    <Link to={`/agents/${a.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{a.name || a.id}</strong>
                    </Link>{' '}
                    <code className="muted small">{a.id}</code>
                    {a.description && <div className="muted small clamp-2">{a.description}</div>}
                  </td>
                  <td>
                    <div className="badges">
                      {a.tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="num" title={a.tools.map((t) => t.name || t.tool).join(', ')}>
                    {a.tools.filter((t) => t.enabled).length}
                    {a.tools.some((t) => !t.enabled) && <span className="muted">/{a.tools.length}</span>}
                  </td>
                  <td className="num">{a.prompt_chars.toLocaleString()}</td>
                  <td className="small">{a.model.preset ?? a.model.model ?? <span className="muted">default</span>}</td>
                  <td>
                    {a.used_by.length ? (
                      <div className="badges">
                        {a.used_by.map((s) => (
                          <Link key={s} to={`/systems/${s}`} className="badge badge-accent" onClick={(e) => e.stopPropagation()}>
                            {s}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="muted small">unused</span>
                    )}
                  </td>
                  <td className="small muted nowrap">
                    <WhenBy at={a.updated_at} by={a.updated_by} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <EmptyState>{agents.data.length ? 'No agents match the filter.' : 'No agents yet.'}</EmptyState>}
        </div>
      )}
      {creating && (
        <CreateAgentModal
          existing={(agents.data ?? []).map((a) => a.id)}
          onClose={() => setCreating(false)}
          onCreated={(a: AgentDef) => {
            invalidate('agents');
            navigate(`/agents/${a.id}`);
          }}
        />
      )}
    </div>
  );
}
