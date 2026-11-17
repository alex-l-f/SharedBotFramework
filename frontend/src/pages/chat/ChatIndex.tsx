import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ScopeToggle, useScope } from '../../components/team';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui';
import { useLoad, useLocalStorage } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/util';

/** /chat without a system: pick one, or reopen a recent chat. */
export function ChatIndex() {
  const systems = useLoad(api.systems.list, []);
  const [scopePref, setScopePref] = useLocalStorage<'mine' | 'all'>('sbf.chat.scope', 'mine');
  const scope = useScope(scopePref);
  const recent = useLoad(() => api.chats.list(undefined, 15, scope), [scope]);
  const names = new Map((systems.data ?? []).map((s) => [s.id, s.ui.title || s.name || s.id]));

  return (
    <div className="page">
      <PageHeader title="Chat" subtitle="Talk to a system as its end user, with optional debug tooling." />
      {systems.loading && !systems.data && <Loading />}
      {systems.error != null && <ErrorBox error={systems.error} onRetry={systems.reload} />}
      <div className="card-grid">
        {(systems.data ?? []).map((s) => (
          <Link key={s.id} to={`/chat/${s.id}`} className="card card-link">
            <div className="card-head">
              <span className="card-title">{s.ui.title || s.name || s.id}</span>
              {s.ui.require_profile && <Badge tone="muted">profile required</Badge>}
            </div>
            {s.description && <p className="muted small clamp-3">{s.description}</p>}
            <span className="small">Start chatting →</span>
          </Link>
        ))}
      </div>
      {systems.data && systems.data.length === 0 && <EmptyState>No systems defined yet.</EmptyState>}

      <div className="row space-between">
        <h2 className="section-title">Recent chats</h2>
        <ScopeToggle value={scope} onChange={setScopePref} />
      </div>
      {recent.error != null && <ErrorBox error={recent.error} onRetry={recent.reload} />}
      {recent.data && recent.data.length === 0 && <EmptyState>No chats yet.</EmptyState>}
      {recent.data && recent.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Chat</th>
                <th>System</th>
                {scope === 'all' && <th>Owner</th>}
                <th className="num">Turns</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {recent.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/chat/${c.system_id}/${c.id}`}>{c.title || <span className="muted">(empty chat)</span>}</Link>
                  </td>
                  <td>{names.get(c.system_id) ?? c.system_id}</td>
                  {scope === 'all' && <td className="small">{c.owner ?? <span className="muted">no owner</span>}</td>}
                  <td className="num">{c.turns}</td>
                  <td className="muted small nowrap">{fmtDateTime(c.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
