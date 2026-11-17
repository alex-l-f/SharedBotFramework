import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { EmptyState, ErrorBox, Loading, Notice, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { fmtDateTime } from '../../lib/util';
import type { ChatLink } from '../../types';
import { CopyButton, LinkStatusBadge, linkUrl, PrivacyBadges } from './linkParts';

/** /links (?system=<id>) — chat links (editors): systems published at a secret URL for visitors without an account. */
export function LinksPage() {
  const canEdit = useAuth().can('editor');
  const [params, setParams] = useSearchParams();
  const systemId = params.get('system') ?? '';
  const links = useLoad(() => (canEdit ? api.links.list(systemId || undefined) : Promise.resolve([] as ChatLink[])), [systemId, canEdit]);
  const systems = useLoad(api.systems.list, []);
  const flash = (useLocation().state as { flash?: string } | null)?.flash;
  const names = new Map((systems.data ?? []).map((s) => [s.id, s.name || s.id]));

  if (!canEdit)
    return (
      <div className="page">
        <PageHeader title="Chat links" />
        <Notice tone="warn">Only editors and admins manage chat links.</Notice>
      </div>
    );

  const newPath = `/links/new${systemId ? `?system=${encodeURIComponent(systemId)}` : ''}`;
  return (
    <div className="page page-wide">
      <PageHeader
        title="Chat links"
        subtitle="Publish a system at a secret address for people without an account. They get a plain chat page, none of this interface, with the privacy, access and limits you choose per link."
        actions={
          <>
            <select
              aria-label="System"
              style={{ width: 'auto' }}
              value={systemId}
              onChange={(e) => setParams(e.target.value ? { system: e.target.value } : {}, { replace: true })}
            >
              <option value="">All systems</option>
              {(systems.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                </option>
              ))}
              {systemId && systems.data && !names.has(systemId) && <option value={systemId}>{systemId} (not found)</option>}
            </select>
            <Link className="btn btn-primary" to={newPath}>
              + New link
            </Link>
          </>
        }
      />
      {flash && <Notice tone="ok">{flash}</Notice>}
      {links.loading && !links.data && <Loading />}
      {links.error != null && <ErrorBox error={links.error} onRetry={links.reload} />}
      {links.data && links.data.length === 0 && (
        <EmptyState>
          {systemId ? `No links for ${names.get(systemId) ?? systemId} yet.` : 'No chat links yet.'}{' '}
          <Link to={newPath}>Create one</Link> to let people chat with {systemId ? 'it' : 'a system'} without an account.
        </EmptyState>
      )}
      {links.data && links.data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Link</th>
                <th>Status</th>
                <th className="num">Conversations</th>
                <th className="num">Visitors</th>
                <th className="num">Messages</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {links.data.map((l) => (
                <tr key={l.id} className={l.status === 'disabled' ? 'row-dim' : undefined}>
                  <td>
                    <Link to={`/links/${l.id}`} title={l.created_by ? `Created by ${l.created_by}` : undefined}>
                      <strong>{l.label}</strong>
                    </Link>
                    <div className="small">
                      <Link className="muted" to={`/systems/${l.system_id}`}>
                        {names.get(l.system_id) ?? l.system_id}
                      </Link>
                    </div>
                    <div className="link-row-badges">
                      <PrivacyBadges link={l} />
                    </div>
                  </td>
                  <td>
                    <LinkStatusBadge status={l.status} />
                  </td>
                  <td className="num">{l.stats.conversations}</td>
                  <td className="num">{l.stats.visitors}</td>
                  <td className="num">{l.stats.turns}</td>
                  <td className="small muted">{l.stats.last_used ? fmtDateTime(l.stats.last_used) : 'never'}</td>
                  <td className="nowrap num">
                    <span className="row gap-sm">
                      <CopyButton text={linkUrl(l)} />
                      <a className="btn btn-sm btn-ghost" href={linkUrl(l)} target="_blank" rel="noreferrer" title="Open the chat page in a new tab">
                        ↗
                      </a>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
