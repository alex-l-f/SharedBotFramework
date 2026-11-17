import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Badge, Collapsible, ErrorBox, Loading, MessageList, Modal } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { systemPayload, toDisplay } from '../../lib/util';
import type { PreviewResult, SystemDef } from '../../types';

/** The node's full instruction as the model would see it (from the unsaved draft). */
export function PreviewModal({ systemId, draft, nodeId, onClose }: { systemId: string; draft: SystemDef; nodeId: string; onClose: () => void }) {
  const node = draft.nodes.find((n) => n.id === nodeId);
  const [mode, setMode] = useState<string>(node?.initial_mode ?? node?.modes[0]?.id ?? '');
  const [profileId, setProfileId] = useState<number | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const profiles = useLoad(api.profiles.list, []);
  // The draft is captured when the modal opens.
  const [snapshot] = useState(() => systemPayload(draft));

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api.systems
      .preview(systemId, { node: nodeId, draft: snapshot, mode: mode || null, profile_id: profileId })
      .then((r) => alive && setResult(r))
      .catch((e: unknown) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [systemId, nodeId, snapshot, mode, profileId]);

  return (
    <Modal title={`Prompt preview — ${node?.label || nodeId}`} onClose={onClose} size="xl">
      <div className="preview-toolbar">
        {node && node.modes.length > 0 && (
          <label className="field-inline">
            Mode{' '}
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              {node.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                  {m.label ? ` — ${m.label}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft.memory.enabled && node?.inject_memory && (
          <label className="field-inline">
            Memory of{' '}
            <select value={profileId ?? ''} onChange={(e) => setProfileId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">(no profile)</option>
              {(profiles.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="grow" />
        {loading && <Loading label="Rendering…" />}
        {result && (
          <>
            <Badge tone="muted">{result.chars.toLocaleString()} chars</Badge>
            <button
              className="btn btn-sm"
              onClick={() => {
                void navigator.clipboard.writeText(result.instruction).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        )}
      </div>
      {error != null && <ErrorBox error={error} />}
      {result && (
        <div className="preview-layout">
          <pre className="preview-instruction mono">{result.instruction}</pre>
          <div className="preview-side">
            <MessageList tone="warn" title="Warnings" items={result.warnings} />
            <h4>Tools ({result.tools.length})</h4>
            {result.tools.length === 0 && <div className="muted small">No tools.</div>}
            {result.tools.map((t, i) => (
              <div key={`${t.name}-${i}`} className="preview-tool">
                <div className="row gap-sm wrap">
                  <code className="tool-fname">{t.name}</code>
                  {t.terminal && <Badge tone="accent">terminal</Badge>}
                  {t.delegate_to && <Badge tone="delegate">→ {t.delegate_to}</Badge>}
                  {t.error && <Badge tone="danger">error</Badge>}
                </div>
                {t.error && <div className="text-danger small pre-line">{t.error}</div>}
                {t.description && <div className="small muted clamp-3" title={t.description}>{t.description}</div>}
                {t.parameters && (
                  <Collapsible title={<span className="small">parameters</span>} className="compact">
                    <pre className="code-block">{toDisplay(t.parameters)}</pre>
                  </Collapsible>
                )}
              </div>
            ))}
            {result.handoffs.length > 0 && (
              <>
                <h4>Handoffs</h4>
                <div className="badges">
                  {result.handoffs.map((h) => (
                    <Badge key={h} tone="handoff">
                      {h}
                    </Badge>
                  ))}
                </div>
              </>
            )}
            <Collapsible title={<span>State used</span>}>
              <pre className="code-block">{toDisplay(result.state)}</pre>
            </Collapsible>
          </div>
        </div>
      )}
    </Modal>
  );
}
