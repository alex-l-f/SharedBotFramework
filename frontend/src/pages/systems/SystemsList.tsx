import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Badge, EmptyState, ErrorBox, Loading, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { fmtDateTime, newSystem } from '../../lib/util';
import { CreateSystemModal } from './SystemModals';

export function SystemsList() {
  const systems = useLoad(api.systems.list, []);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const canEdit = useAuth().can('editor');

  return (
    <div className="page">
      <PageHeader
        title="Systems"
        subtitle="Multi-agent systems: nodes (agent instances), links between them, the user-facing entry, memory and chat UI."
        actions={
          canEdit && (
            <>
              <button className="btn" onClick={() => setCreating(true)} title="An empty system, built in the editor">
                + Blank system
              </button>
              <Link className="btn btn-primary" to="/setup">
                ✦ Set up a new system
              </Link>
            </>
          )
        }
      />
      {systems.loading && !systems.data && <Loading />}
      {systems.error != null && <ErrorBox error={systems.error} onRetry={systems.reload} />}
      {systems.data && systems.data.length === 0 && (
        <EmptyState>
          <p>No systems yet.</p>
          {canEdit && (
            <p>
              <Link className="btn btn-primary" to="/setup">
                ✦ Set up a new system
              </Link>{' '}
              <span className="muted small">A few questions; the wizard creates the agents and wires them together.</span>
            </p>
          )}
        </EmptyState>
      )}
      <div className="card-grid">
        {(systems.data ?? []).map((s) => (
          <div key={s.id} className="card system-card">
            <div className="card-head">
              <Link to={`/systems/${s.id}`} className="card-title">
                {s.name || s.id}
              </Link>
              <code className="muted small">{s.id}</code>
            </div>
            {s.description && <p className="muted small clamp-3">{s.description}</p>}
            <div className="badges">
              {s.tags.map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>
            <div className="small system-card-nodes">
              {s.nodes.map((n) => (
                <span key={n.id} className={n.id === s.entry ? 'node-chip entry' : 'node-chip'} title={`agent: ${n.agent}`}>
                  {n.id}
                </span>
              ))}
              <span className="muted">
                {' '}
                · {s.links} link{s.links === 1 ? '' : 's'}
              </span>
            </div>
            <div className="card-foot">
              <span className="muted small">
                {fmtDateTime(s.updated_at)}
                {s.updated_by && <> · {s.updated_by}</>}
              </span>
              <span className="row gap-sm">
                {canEdit && (
                  <Link className="btn btn-sm btn-ghost" to={`/links?system=${encodeURIComponent(s.id)}`} title="Chat links: publish this system for people without an account">
                    Share
                  </Link>
                )}
                <Link className="btn btn-sm" to={`/systems/${s.id}`}>
                  {canEdit ? 'Edit' : 'Open'}
                </Link>
                <Link className="btn btn-sm btn-primary" to={`/chat/${s.id}`}>
                  Chat →
                </Link>
              </span>
            </div>
          </div>
        ))}
      </div>
      {creating && (
        <CreateSystemModal
          existing={(systems.data ?? []).map((s) => s.id)}
          onClose={() => setCreating(false)}
          onCreate={async (id, name) => {
            const created = await api.systems.create({ ...newSystem(id), name });
            navigate(`/systems/${created.id}`);
          }}
        />
      )}
    </div>
  );
}
