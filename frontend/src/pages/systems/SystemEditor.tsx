import { useCallback, useEffect, useMemo, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorLines } from '../../api';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton } from '../../components/History';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { DirtyDot, ErrorBox, Loading } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useDragResize, useLoad, useLocalStorage, useSaveShortcut, useUnsavedGuard } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { invalidate, useAgents, useClassifiers, useMemorySchemas, useSafetyMeta, useSettings, useTools } from '../../lib/refdata';
import { isEqual, newNode, stableStringify, systemPayload } from '../../lib/util';
import type { AgentDef, SystemDef, ValidateResult } from '../../types';
import { AddGuardModal, GuardInspector } from './GuardInspector';
import { LinkInspector } from './LinkInspector';
import { NodeInspector } from './NodeInspector';
import { PreviewModal } from './PreviewModal';
import { EdgeLegend, SystemCanvas, USER_NODE } from './SystemCanvas';
import { AddNodeModal, LinkTypeModal } from './SystemModals';
import { SystemSettingsPanel } from './SystemSettingsPanel';
import { addLink, addNode, nextPosition, type Selection } from './systemOps';
import { ValidationPanel } from './ValidationPanel';

type AgentEntry = { def?: AgentDef; error?: unknown };

const toPayload = (d: Record<string, unknown>) => systemPayload(withGuards(d as unknown as SystemDef));

/** Older definitions (and history revisions) may lack `guards`. */
const withGuards = (s: SystemDef): SystemDef => (s.guards ? s : { ...s, guards: [] });

export function SystemEditor() {
  const { systemId = '' } = useParams();
  const navigate = useNavigate();
  const loaded = useLoad(() => api.systems.get(systemId), [systemId]);
  const agents = useAgents();
  const tools = useTools();
  const settings = useSettings();
  const schemas = useMemorySchemas();

  const [saved, setSaved] = useState<SystemDef | null>(null);
  const [draft, setDraft] = useState<SystemDef | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [validation, setValidation] = useState<{ result: ValidateResult; of: string } | null>(null);
  const [validating, setValidating] = useState(false);
  const [previewNode, setPreviewNode] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingGuard, setAddingGuard] = useState(false);
  const classifiers = useClassifiers();
  const safetyMeta = useSafetyMeta();
  const [pendingLink, setPendingLink] = useState<{ source: string; target: string } | null>(null);
  const [agentDefs, setAgentDefs] = useState<Record<string, AgentEntry>>({});
  const [inspectorWidth, setInspectorWidth] = useLocalStorage('sbf.inspectorWidth', 440);
  const onResize = useDragResize(inspectorWidth, setInspectorWidth, 'x', -1, 320, 900);

  useEffect(() => {
    if (!loaded.data) return;
    const sys = withGuards(loaded.data);
    setSaved(sys);
    setDraft(sys);
    setSelection(null);
    setValidation(null);
  }, [loaded.data]);

  const canSave = useAuth().can('editor');
  const payload = useMemo(() => (draft ? systemPayload(draft) : null), [draft]);
  const dirty = useMemo(() => !!draft && !!saved && !isEqual(payload, systemPayload(saved)), [payload, draft, saved]);
  const { allowNext } = useUnsavedGuard(dirty && canSave);
  const others = usePresence(`systems/${systemId}`, dirty && canSave);

  // Full agent definitions, fetched on demand (tool config overrides need the agent's bindings).
  const selectedNode = selection?.kind === 'node' ? draft?.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedLink = selection?.kind === 'link' ? draft?.links.find((l) => l.id === selection.id) : undefined;
  const selectedGuard = selection?.kind === 'guard' ? draft?.guards.find((g) => g.id === selection.id) : undefined;
  const neededAgent = selectedNode?.agent;
  useEffect(() => {
    if (!neededAgent || agentDefs[neededAgent]) return;
    setAgentDefs((m) => ({ ...m, [neededAgent]: {} }));
    api.agents
      .get(neededAgent)
      .then((a) => setAgentDefs((m) => ({ ...m, [neededAgent]: { def: a } })))
      .catch((error: unknown) => setAgentDefs((m) => ({ ...m, [neededAgent]: { error } })));
  }, [neededAgent, agentDefs]);

  const validate = useCallback(
    async (target?: SystemDef) => {
      const sys = target ?? payload;
      if (!sys) return;
      setValidating(true);
      try {
        const result = await api.systems.validate(systemId, sys);
        setValidation({ result, of: stableStringify(sys) });
      } catch (e) {
        // A draft that fails schema validation comes back as a 422 detail list.
        setValidation({ result: { ok: false, problems: errorLines(e), warnings: [], hash: null }, of: stableStringify(sys) });
      } finally {
        setValidating(false);
      }
    },
    [payload, systemId],
  );

  /** Saves `body` based on `version`; the result becomes the saved state. */
  const persist = async (body: SystemDef, version: string | null) => {
    const result = withGuards(await api.systems.update(systemId, body, version));
    setSaved(result);
    setDraft(result);
    setSaveError(null);
    invalidate('agents');
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
    void validate(systemPayload(result));
  };
  const conflicts = useConflicts<SystemDef>({
    what: `system “${systemId}”`,
    toPayload,
    persist,
    reload: loaded.reload,
    discard: () => {
      allowNext();
      navigate('/systems');
    },
  });

  const save = async () => {
    if (!payload || !saved || busy || !canSave) return;
    setBusy(true);
    setSaveError(null);
    try {
      await persist(payload, saved.version ?? null);
    } catch (e) {
      if (!conflicts.catchConflict(e, systemPayload(saved), payload)) setSaveError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && canSave);

  const remove = async () => {
    if (!window.confirm(`Delete system "${systemId}"? This removes its definition file (chats are kept).`)) return;
    try {
      await api.systems.remove(systemId, saved?.version);
      invalidate('agents');
      allowNext();
      navigate('/systems');
    } catch (e) {
      setSaveError(e);
    }
  };

  if (loaded.error != null)
    return (
      <div className="page">
        <ErrorBox error={loaded.error} onRetry={loaded.reload} title={`Could not load system "${systemId}"`} />
        <Link to="/systems">← Systems</Link>
      </div>
    );
  if (!draft || !saved)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const presets = Object.keys(settings.data?.models ?? {});
  const catalog = tools.data ?? [];
  const agentList = agents.data ?? [];
  const stale = !!validation && !!payload && validation.of !== stableStringify(payload);

  return (
    <div className="system-editor">
      <div className="editor-topbar">
        <div className="editor-topbar-title">
          <div className="crumbs">
            <Link to="/systems">Systems</Link> /
          </div>
          <h1>
            {draft.name || draft.id} <code className="muted small">{draft.id}</code> <DirtyDot dirty={dirty} />
          </h1>
          <span className="muted small">
            <SavedBy at={saved.updated_at} by={saved.updated_by} prefix="saved" />
          </span>
          <PresenceChips others={others} />
        </div>
        <div className="page-actions">
          {flash && <span className="flash">{flash}</span>}
          <button className="btn" onClick={() => setAdding(true)} title={canSave ? undefined : 'Try it in the draft (you cannot save)'}>
            + Add node
          </button>
          <button className="btn" onClick={() => setAddingGuard(true)} title="Attach a safety classifier to a node">
            + Add guard
          </button>
          <HistoryButton
            kind="systems"
            id={systemId}
            label={`system ${systemId}`}
            current={payload}
            baseVersion={saved.version}
            toPayload={toPayload}
            onLoad={canSave ? (p) => setDraft({ ...draft, ...p }) : undefined}
          />
          <button className="btn" disabled={!dirty} onClick={() => setDraft(saved)}>
            Revert
          </button>
          <button className="btn" onClick={() => void validate()} disabled={validating}>
            {validating ? 'Validating…' : 'Validate'}
          </button>
          {canSave ? (
            <button className="btn btn-primary" disabled={!dirty || busy} onClick={save} title="Ctrl+S">
              {busy ? 'Saving…' : 'Save'}
            </button>
          ) : (
            <ReadOnlyNote />
          )}
          {canSave && (
            <Link className="btn" to={`/links?system=${encodeURIComponent(systemId)}`} title="Chat links: publish this system for people without an account">
              Share…
            </Link>
          )}
          <button className="btn" onClick={() => navigate(`/chat/${systemId}`)} title={dirty ? 'Chats run the saved definition' : undefined}>
            Chat →
          </button>
        </div>
      </div>
      {saveError != null && (
        <div className="editor-messages">
          <ErrorBox error={saveError} title="Not saved" />
        </div>
      )}
      {conflicts.dialog}
      {validation && (
        <div className="editor-messages">
          <ValidationPanel result={validation.result} stale={stale} onClose={() => setValidation(null)} />
        </div>
      )}
      {(agents.error != null || tools.error != null) && (
        <div className="editor-messages">
          <ErrorBox error={agents.error ?? tools.error} title="Reference data unavailable" />
        </div>
      )}

      <div className="system-body">
        <div className="canvas-wrap">
          <ReactFlowProvider>
            <SystemCanvas
              key={systemId}
              system={draft}
              agents={agentList}
              classifiers={classifiers.data ?? null}
              selection={selection}
              onSelect={setSelection}
              onMoveGuards={(moves) =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        guards: d.guards.map((g) => {
                          const m = moves.find((x) => x.id === g.id);
                          return m && (m.position.x !== g.position.x || m.position.y !== g.position.y) ? { ...g, position: m.position } : g;
                        }),
                      }
                    : d,
                )
              }
              onMoveNodes={(moves) =>
                setDraft((d) =>
                  d
                    ? {
                        ...d,
                        nodes: d.nodes.map((n) => {
                          const m = moves.find((x) => x.id === n.id);
                          return m && (m.position.x !== n.position.x || m.position.y !== n.position.y) ? { ...n, position: m.position } : n;
                        }),
                      }
                    : d,
                )
              }
              onConnect={(source, target) => {
                if (source === USER_NODE) {
                  setDraft({ ...draft, entry: target });
                  return;
                }
                setPendingLink({ source, target });
              }}
            />
          </ReactFlowProvider>
          <EdgeLegend />
          {draft.nodes.length === 0 && (
            <div className="canvas-empty">
              <p>This system has no nodes yet.</p>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                + Add node
              </button>
            </div>
          )}
        </div>
        <div className="splitter-x" onMouseDown={onResize} title="Drag to resize" />
        <aside className="inspector" style={{ width: inspectorWidth }}>
          {selectedNode ? (
            <NodeInspector
              key={`node-${selectedNode.id}`}
              system={draft}
              node={selectedNode}
              agents={agentList}
              agentDef={agentDefs[selectedNode.agent]?.def}
              agentError={agentDefs[selectedNode.agent]?.error ?? null}
              catalog={catalog}
              presets={presets}
              onChange={setDraft}
              onSelect={setSelection}
              onPreview={setPreviewNode}
            />
          ) : selectedLink ? (
            <LinkInspector key={`link-${selection?.kind === 'link' ? selection.id : ''}`} system={draft} link={selectedLink} onChange={setDraft} onSelect={setSelection} />
          ) : selectedGuard ? (
            <GuardInspector
              system={draft}
              guard={selectedGuard}
              classifiers={classifiers.data ?? []}
              meta={safetyMeta.data}
              onChange={setDraft}
              onSelect={setSelection}
            />
          ) : (
            <SystemSettingsPanel system={draft} schemas={schemas.data ?? []} onChange={setDraft} onDelete={canSave ? remove : undefined} />
          )}
        </aside>
      </div>

      {adding && (
        <AddNodeModal
          system={draft}
          agents={agentList}
          onClose={() => setAdding(false)}
          onAdd={(nodeId, agentId, label) => {
            setDraft(addNode(draft, newNode(nodeId, agentId, nextPosition(draft), label)));
            setSelection({ kind: 'node', id: nodeId });
            setAdding(false);
          }}
        />
      )}
      {addingGuard && (
        <AddGuardModal
          system={draft}
          classifiers={classifiers.data ?? []}
          onClose={() => setAddingGuard(false)}
          onAdd={(guards) => {
            setDraft({ ...draft, guards: [...draft.guards, ...guards] });
            if (guards.length) setSelection({ kind: 'guard', id: guards[0].id });
            setAddingGuard(false);
          }}
        />
      )}
      {pendingLink && (
        <LinkTypeModal
          source={pendingLink.source}
          target={pendingLink.target}
          onClose={() => setPendingLink(null)}
          onPick={(type) => {
            const { system, link } = addLink(draft, type, pendingLink.source, pendingLink.target);
            setDraft(system);
            setSelection({ kind: 'link', id: link.id });
            setPendingLink(null);
          }}
        />
      )}
      {previewNode && <PreviewModal systemId={systemId} draft={draft} nodeId={previewNode} onClose={() => setPreviewNode(null)} />}
    </div>
  );
}
