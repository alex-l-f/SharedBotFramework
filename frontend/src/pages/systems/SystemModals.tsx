import { useState } from 'react';
import { Badge, ErrorBox, Field, Modal } from '../../components/ui';
import { IDENT_RE, SLUG_RE, uniqueId } from '../../lib/util';
import { LINK_TYPES, type AgentSummary, type LinkType, type SystemDef } from '../../types';
import { LINK_HELP } from './systemOps';

/** Pick an agent for a new node. */
export function AddNodeModal({
  system,
  agents,
  onClose,
  onAdd,
}: {
  system: SystemDef;
  agents: AgentSummary[];
  onClose: () => void;
  onAdd: (nodeId: string, agentId: string, label: string) => void;
}) {
  const taken = system.nodes.map((n) => n.id);
  const suggest = (agentId: string) => uniqueId(agentId.replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'node', taken);
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [nodeId, setNodeId] = useState(agents[0] ? suggest(agents[0].id) : '');
  const [label, setLabel] = useState(agents[0]?.name ?? '');
  const [touched, setTouched] = useState(false);

  const problem = !agentId ? 'Pick an agent' : !IDENT_RE.test(nodeId) ? 'Node id must match ^[A-Za-z_][A-Za-z0-9_]*$' : taken.includes(nodeId) ? 'A node with this id exists' : null;

  return (
    <Modal
      title="Add node"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!problem} onClick={() => onAdd(nodeId, agentId, label)}>
            Add
          </button>
        </>
      }
    >
      <div className="agent-pick-list">
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            className={`picker-item${a.id === agentId ? ' selected' : ''}`}
            onClick={() => {
              setAgentId(a.id);
              if (!touched) {
                setNodeId(suggest(a.id));
                setLabel(a.name);
              }
            }}
          >
            <div className="picker-item-head">
              <strong>{a.name || a.id}</strong> <code className="muted">{a.id}</code>
              {a.tags.map((t) => (
                <Badge key={t} tone="muted">
                  {t}
                </Badge>
              ))}
            </div>
            {a.description && <div className="muted small clamp-2">{a.description}</div>}
          </button>
        ))}
        {agents.length === 0 && <div className="muted">No agents defined yet — create one on the Agents page first.</div>}
      </div>
      <div className="grid-2">
        <Field label="Node id" hint={problem && agentId ? <span className="text-danger">{problem}</span> : 'Also the ADK agent name'}>
          <input
            className="mono"
            value={nodeId}
            onChange={(e) => {
              setTouched(true);
              setNodeId(e.target.value.trim());
            }}
          />
        </Field>
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** Asked after dragging a connection between two nodes. */
export function LinkTypeModal({
  source,
  target,
  onClose,
  onPick,
}: {
  source: string;
  target: string;
  onClose: () => void;
  onPick: (t: LinkType) => void;
}) {
  return (
    <Modal title={`Link ${source} → ${target}`} onClose={onClose} size="sm">
      <div className="link-type-choices">
        {LINK_TYPES.map((t) => (
          <button key={t} type="button" className="picker-item" onClick={() => onPick(t)}>
            <div className="picker-item-head">
              <Badge tone={t}>{t}</Badge>
            </div>
            <div className="small muted">{LINK_HELP[t]}</div>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** New system: id + name, created immediately (empty). */
export function CreateSystemModal({
  existing,
  onClose,
  onCreate,
}: {
  existing: string[];
  onClose: () => void;
  onCreate: (id: string, name: string) => Promise<void>;
}) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const problem = !id ? 'Required' : !SLUG_RE.test(id) ? 'Lowercase letters, digits, - and _' : existing.includes(id) ? 'A system with this id exists' : null;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(id, name);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New system"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!problem || busy} onClick={submit}>
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
        <Field label="Id" hint={problem && id ? <span className="text-danger">{problem}</span> : 'File name; cannot be changed later.'}>
          <input className="mono" autoFocus value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="e.g. my-system" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
