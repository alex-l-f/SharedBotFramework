import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton } from '../../components/History';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { ToolBindingsEditor } from '../../components/ToolBindingsEditor';
import { Badge, DirtyDot, ErrorBox, Field, FieldGroup, Loading, NumberInput, PromptArea, TagsInput } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut, useUnsavedGuard } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { invalidate, useSettings, useTools } from '../../lib/refdata';
import { agentPayload, isEqual } from '../../lib/util';
import type { AgentDef, AgentUsage, ReplyMode } from '../../types';
import { CreateAgentModal } from './CreateAgentModal';

/** The editable fields plus the stamps of the stored version (updated_at/by, version). */
const withStamps = (a: AgentDef): AgentDef => ({ ...agentPayload(a), updated_at: a.updated_at, updated_by: a.updated_by, version: a.version });
const toPayload = (d: Record<string, unknown>) => agentPayload(d as unknown as AgentDef);

export function AgentEditor() {
  const { agentId = '' } = useParams();
  const loaded = useLoad(() => api.agents.get(agentId), [agentId]);
  const tools = useTools();
  const settings = useSettings();
  const navigate = useNavigate();

  const [saved, setSaved] = useState<AgentDef | null>(null);
  const [draft, setDraft] = useState<AgentDef | null>(null);
  const [usedBy, setUsedBy] = useState<AgentUsage[]>([]);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const canSave = useAuth().can('editor');

  useEffect(() => {
    if (!loaded.data) return;
    const { used_by, ...agent } = loaded.data;
    setSaved(withStamps(agent));
    setDraft(withStamps(agent));
    setUsedBy(used_by);
    setSaveError(null);
  }, [loaded.data]);

  const dirty = useMemo(() => !!draft && !!saved && !isEqual(agentPayload(draft), agentPayload(saved)), [draft, saved]);
  const { allowNext } = useUnsavedGuard(dirty && canSave);
  const others = usePresence(`agents/${agentId}`, dirty && canSave);

  /** Saves `payload` based on `version`; the result becomes the saved state. */
  const persist = async (payload: AgentDef, version: string | null) => {
    const result = await api.agents.update(agentId, payload, version);
    setSaved(withStamps(result));
    setDraft(withStamps(result));
    setSaveError(null);
    invalidate('agents');
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
  };
  const conflicts = useConflicts<AgentDef>({
    what: `agent “${agentId}”`,
    toPayload,
    persist,
    reload: loaded.reload,
    discard: () => {
      allowNext();
      navigate('/agents');
    },
  });

  const save = async () => {
    if (!draft || !saved || busy || !canSave) return;
    setBusy(true);
    setSaveError(null);
    const mine = agentPayload(draft);
    try {
      await persist(mine, saved.version ?? null);
    } catch (e) {
      if (!conflicts.catchConflict(e, agentPayload(saved), mine)) setSaveError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && canSave);

  const remove = async () => {
    if (!draft) return;
    if (!window.confirm(`Delete agent "${draft.id}"? This removes its definition file.`)) return;
    setSaveError(null);
    try {
      await api.agents.remove(draft.id, saved?.version);
      invalidate('agents');
      allowNext();
      navigate('/agents');
    } catch (e) {
      setSaveError(e);
    }
  };

  if (loaded.error != null)
    return (
      <div className="page">
        <ErrorBox error={loaded.error} onRetry={loaded.reload} title={`Could not load agent "${agentId}"`} />
        <Link to="/agents">← Agents</Link>
      </div>
    );
  if (!draft || !saved) return <div className="page"><Loading /></div>;

  const set = <K extends keyof AgentDef>(key: K, value: AgentDef[K]) => setDraft({ ...draft, [key]: value });
  const presets = Object.keys(settings.data?.models ?? {});

  return (
    <div className="page page-wide">
      <div className="page-header sticky-header">
        <div>
          <div className="crumbs">
            <Link to="/agents">Agents</Link> /
          </div>
          <h1>
            {draft.name || draft.id} <code className="muted small">{draft.id}</code> <DirtyDot dirty={dirty} />
          </h1>
          <div className="page-subtitle">
            {(saved.updated_at || saved.updated_by) && (
              <>
                <SavedBy at={saved.updated_at} by={saved.updated_by} /> ·{' '}
              </>
            )}
            {usedBy.length ? (
              <>
                Used by{' '}
                {usedBy.map((u, i) => (
                  <span key={u.system}>
                    {i > 0 && ', '}
                    <Link to={`/systems/${u.system}`}>{u.name || u.system}</Link>
                    <span className="muted"> ({u.nodes.join(', ')})</span>
                  </span>
                ))}
              </>
            ) : (
              <span className="muted">Not used by any system</span>
            )}
          </div>
          <PresenceChips others={others} />
        </div>
        <div className="page-actions">
          {flash && <span className="flash">{flash}</span>}
          <HistoryButton
            kind="agents"
            id={agentId}
            label={`agent ${agentId}`}
            current={agentPayload(draft)}
            baseVersion={saved.version}
            toPayload={toPayload}
            onLoad={canSave ? (p) => setDraft({ ...draft, ...p }) : undefined}
          />
          <button className="btn" disabled={!dirty} onClick={() => setDraft(saved)}>
            Revert
          </button>
          {canSave ? (
            <>
              <button className="btn" onClick={() => setDuplicating(true)}>
                Duplicate…
              </button>
              <button className="btn btn-danger-ghost" onClick={remove}>
                Delete
              </button>
              <button className="btn btn-primary" disabled={!dirty || busy} onClick={save} title="Ctrl+S">
                {busy ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <ReadOnlyNote />
          )}
        </div>
      </div>
      {saveError != null && <ErrorBox error={saveError} title="Not saved" />}
      {conflicts.dialog}

      <div className="editor-columns">
        <section className="panel">
          <div className="grid-2">
            <Field label="Name">
              <input value={draft.name} onChange={(e) => set('name', e.target.value)} />
            </Field>
            <Field label="Tags">
              <TagsInput value={draft.tags} onChange={(v) => set('tags', v)} />
            </Field>
          </div>
          <Field label="Description" hint="What the agent does; used for handoff/delegation descriptions.">
            <textarea rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
          </Field>
          <FieldGroup label="Prompt" hint="Jinja template. Systems may wrap it via a node's prompt_template ({{ agent_prompt }}).">
            <PromptArea value={draft.prompt} onChange={(v) => set('prompt', v)} rows={28} />
          </FieldGroup>
        </section>

        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Behaviour</h2>
            <div className="grid-2">
              <Field
                label="Reply mode"
                hint={draft.reply_mode === 'text' ? 'Visible model text is delivered to the user (when user-facing).' : 'Only send_message reaches the user.'}
              >
                <select value={draft.reply_mode} onChange={(e) => set('reply_mode', e.target.value as ReplyMode)}>
                  <option value="text">text</option>
                  <option value="tool">tool</option>
                </select>
              </Field>
              <Field label="Max LLM calls" hint="Per run">
                <NumberInput integer min={1} value={draft.max_llm_calls} onChange={(v) => set('max_llm_calls', v ?? 20)} />
              </Field>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Model</h2>
            <ModelSpecEditor value={draft.model} onChange={(v) => set('model', v)} presets={presets} inheritNote={`Blank fields inherit from the default preset (${settings.data?.default_model ?? 'default'}).`} />
          </section>

          <section className="panel">
            <h2 className="panel-title">
              Tools <Badge tone="muted">{draft.tools.length}</Badge>
            </h2>
            {tools.error != null && <ErrorBox error={tools.error} title="Tool catalog unavailable" />}
            <ToolBindingsEditor value={draft.tools} onChange={(v) => set('tools', v)} catalog={tools.data ?? []} emptyText="This agent has no tools." />
          </section>

          <section className="panel">
            <h2 className="panel-title">Notes</h2>
            <Field label="Designer notes" hint="Never sent to the model.">
              <textarea rows={4} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </section>
        </div>
      </div>

      {duplicating && (
        <CreateAgentModal
          existing={[draft.id]}
          base={draft}
          onClose={() => setDuplicating(false)}
          onCreated={(a) => {
            setDuplicating(false);
            invalidate('agents');
            navigate(`/agents/${a.id}`);
          }}
        />
      )}
    </div>
  );
}
