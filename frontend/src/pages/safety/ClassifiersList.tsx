// /safety — safety classifiers: what checks messages, and which systems'
// guards use each one.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { WhenBy } from '../../components/team';
import { EmptyState, ErrorBox, Field, Loading, Modal, PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { invalidate, useSafetyMeta } from '../../lib/refdata';
import { SLUG_RE } from '../../lib/util';
import { SAFETY_PROVIDERS, type ClassifierSummary, type SafetyProvider } from '../../types';
import { HAS_STATUS, PROVIDER_HELP, ProviderBadge, prefilledClassifier, StatusDot } from './safetyUi';

export function ClassifiersList() {
  const classifiers = useLoad(api.classifiers.list, []);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const navigate = useNavigate();
  const canEdit = useAuth().can('editor');

  const remove = async (c: ClassifierSummary) => {
    if (!window.confirm(`Delete classifier "${c.id}"?`)) return;
    setError(null);
    try {
      await api.classifiers.remove(c.id, c.version);
      invalidate('classifiers');
      classifiers.reload();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="page page-wide">
      <PageHeader
        title="Safety"
        subtitle={
          <>
            Classifiers decide whether a message is safe. Attach one to a system as a <strong>guard</strong> (in the system editor, “+ Add
            guard”) to check what users write or what the agents reply, and choose what happens when something is flagged.
          </>
        }
        actions={
          <>
            <button className="btn" onClick={() => setTick(tick + 1)} title="Check the classifiers' services again">
              Recheck services
            </button>
            {canEdit && (
              <button className="btn btn-primary" onClick={() => setCreating(true)}>
                + New classifier
              </button>
            )}
          </>
        }
      />
      {error != null && <ErrorBox error={error} title="Not deleted" />}
      {classifiers.loading && !classifiers.data && <Loading />}
      {classifiers.error != null && <ErrorBox error={classifiers.error} onRetry={classifiers.reload} />}
      {classifiers.data && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Classifier</th>
                <th>Provider</th>
                <th>Service</th>
                <th>Used by</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {classifiers.data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/safety/${c.id}`)}>
                  <td style={{ minWidth: 200, maxWidth: 360 }}>
                    <Link to={`/safety/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      <strong>{c.name || c.id}</strong>
                    </Link>{' '}
                    <code className="muted small">{c.id}</code>
                    {c.description && <div className="muted small clamp-2">{c.description}</div>}
                  </td>
                  <td>
                    <ProviderBadge provider={c.provider} />
                  </td>
                  <td className="small">{HAS_STATUS.includes(c.provider) ? <StatusDot id={c.id} tick={tick} showText /> : <span className="muted">—</span>}</td>
                  <td>
                    {c.used_by.length ? (
                      <div className="badges">
                        {c.used_by.map((u) => (
                          <Link
                            key={u.system}
                            to={`/systems/${u.system}`}
                            className="badge badge-accent"
                            title={`guards: ${u.guards.join(', ')}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {u.system} · {u.guards.length}
                          </Link>
                        ))}
                      </div>
                    ) : (
                      <span className="muted small">not used</span>
                    )}
                  </td>
                  <td className="small muted nowrap">
                    <WhenBy at={c.updated_at} by={c.updated_by} />
                  </td>
                  <td className="num">
                    {canEdit && (
                      <button
                        className="btn btn-ghost btn-icon danger"
                        title={c.used_by.length ? 'In use: remove its guards first' : 'Delete classifier'}
                        disabled={c.used_by.length > 0}
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(c);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {classifiers.data.length === 0 && (
            <EmptyState>
              No classifiers yet.{canEdit && ' Create one — SAFER is a good start if its service runs on this machine; keyword rules need nothing.'}
            </EmptyState>
          )}
        </div>
      )}
      {creating && (
        <CreateClassifierModal
          existing={(classifiers.data ?? []).map((c) => c.id)}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            invalidate('classifiers');
            navigate(`/safety/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

/** Id, name and provider; the new classifier starts with that provider's defaults. */
function CreateClassifierModal({
  existing,
  onClose,
  onCreated,
}: {
  existing: string[];
  onClose: () => void;
  onCreated: (c: ClassifierSummary) => void;
}) {
  const meta = useSafetyMeta();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<SafetyProvider>('safer');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const idProblem = !id
    ? 'Required'
    : !SLUG_RE.test(id)
      ? 'Lowercase letters, digits, - and _ (must start with a letter or digit)'
      : existing.includes(id)
        ? 'A classifier with this id exists'
        : null;

  const submit = async () => {
    if (idProblem || busy || !meta.data) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.classifiers.create(prefilledClassifier(id, name, provider, meta.data)));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New classifier"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!idProblem || busy || !meta.data} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid-2">
          <Field label="Id" hint={idProblem && id ? <span className="text-danger">{idProblem}</span> : 'Guards refer to it; cannot be changed later.'}>
            <input className="mono" autoFocus value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="e.g. safer" />
          </Field>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
          </Field>
        </div>
        <Field label="How it checks" hint="It starts with this provider's defaults; you can change everything afterwards.">
          <div className="choice-list">
            {SAFETY_PROVIDERS.map((p) => (
              <label key={p} className={`choice${provider === p ? ' active' : ''}`}>
                <input type="radio" name="provider" checked={provider === p} onChange={() => setProvider(p)} />
                <span>
                  <strong>{meta.data?.providers[p]?.label ?? p}</strong>
                  <span className="muted small"> — {PROVIDER_HELP[p]}</span>
                </span>
              </label>
            ))}
          </div>
        </Field>
        {meta.error != null && <ErrorBox error={meta.error} title="Provider defaults unavailable" />}
        {error != null && <ErrorBox error={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
