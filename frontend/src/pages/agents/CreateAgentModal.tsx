import { useState } from 'react';
import { api } from '../../api';
import { ErrorBox, Field, Modal } from '../../components/ui';
import { agentPayload, SLUG_RE } from '../../lib/util';
import type { AgentDef } from '../../types';

const BLANK: Omit<AgentDef, 'id'> = {
  name: '',
  description: '',
  tags: [],
  prompt: '',
  tools: [],
  model: {},
  max_llm_calls: 20,
  reply_mode: 'text',
  notes: '',
};

/** Asks for an id (immutable afterwards) and name, then POSTs the agent. */
export function CreateAgentModal({
  existing,
  base,
  onClose,
  onCreated,
}: {
  existing: string[];
  /** Duplicate from this agent. */
  base?: AgentDef;
  onClose: () => void;
  onCreated: (a: AgentDef) => void;
}) {
  const [id, setId] = useState(base ? `${base.id}-copy` : '');
  const [name, setName] = useState(base ? `${base.name || base.id} (copy)` : '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const idProblem = !id ? 'Required' : !SLUG_RE.test(id) ? 'Lowercase letters, digits, - and _ (must start with a letter or digit)' : existing.includes(id) ? 'An agent with this id exists' : null;

  const submit = async () => {
    if (idProblem) return;
    setBusy(true);
    setError(null);
    try {
      const src = base ?? { ...BLANK, id };
      onCreated(await api.agents.create(agentPayload({ ...src, id, name })));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={base ? `Duplicate ${base.id}` : 'New agent'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!!idProblem || busy} onClick={submit}>
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
        <Field label="Id" hint={idProblem && id ? <span className="text-danger">{idProblem}</span> : 'File name; cannot be changed later.'}>
          <input className="mono" autoFocus value={id} onChange={(e) => setId(e.target.value.trim())} placeholder="e.g. research_helper" />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Display name" />
        </Field>
        {error != null && <ErrorBox error={error} />}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
