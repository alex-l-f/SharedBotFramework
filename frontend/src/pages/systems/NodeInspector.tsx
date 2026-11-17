import { useEffect, useState } from 'react';
import { ModelSpecEditor, modelSummary } from '../../components/ModelSpecEditor';
import { ToolBindingsEditor, functionName } from '../../components/ToolBindingsEditor';
import { Badge, Collapsible, ErrorBox, Field, Loading, NumberInput, PromptArea } from '../../components/ui';
import { IDENT_RE, isEmptyModel, userFacingNodes } from '../../lib/util';
import type { AgentDef, AgentSummary, NodeDef, SystemDef, ToolInfo } from '../../types';
import { ModesEditor } from './ModesEditor';
import { NodeContextEditor } from './NodeContextEditor';
import { PROMPT_VARS_HELP, removeNode, renameNode, updateNode, type Selection } from './systemOps';
import { ToolConfigOverrides } from './ToolConfigOverrides';

export function NodeInspector({
  system,
  node,
  agents,
  agentDef,
  agentError,
  catalog,
  presets,
  onChange,
  onSelect,
  onPreview,
}: {
  system: SystemDef;
  node: NodeDef;
  agents: AgentSummary[];
  agentDef: AgentDef | undefined;
  agentError: unknown;
  catalog: ToolInfo[];
  presets: string[];
  onChange: (s: SystemDef) => void;
  onSelect: (s: Selection) => void;
  onPreview: (nodeId: string) => void;
}) {
  const set = (patch: Partial<NodeDef>) => onChange(updateNode(system, node.id, patch));
  const isEntry = system.entry === node.id;
  const facing = userFacingNodes(system).has(node.id);
  const linksIn = system.links.filter((l) => l.target === node.id);
  const linksOut = system.links.filter((l) => l.source === node.id);

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <div>
          <span className="muted small">Node</span>
          <h2>{node.label || node.id}</h2>
        </div>
        <button className="btn btn-sm" onClick={() => onPreview(node.id)}>
          Preview prompt
        </button>
      </div>
      <div className="badges">
        {isEntry ? <Badge tone="accent">entry</Badge> : (
          <button className="btn btn-sm" onClick={() => onChange({ ...system, entry: node.id })}>
            Set as entry
          </button>
        )}
        {facing && <Badge tone="ok">user-facing</Badge>}
        <Badge tone="muted">
          {linksIn.length} in · {linksOut.length} out
        </Badge>
      </div>

      <NodeIdField
        value={node.id}
        taken={system.nodes.filter((n) => n.id !== node.id).map((n) => n.id)}
        onCommit={(id) => {
          onChange(renameNode(system, node.id, id));
          onSelect({ kind: 'node', id });
        }}
      />
      <Field label="Label">
        <input value={node.label} placeholder={node.id} onChange={(e) => set({ label: e.target.value })} />
      </Field>
      <Field
        label={
          <span className="row space-between">
            Agent
            {node.agent && (
              <a href={`/agents/${node.agent}`} target="_blank" rel="noreferrer" className="small">
                open agent ↗
              </a>
            )}
          </span>
        }
      >
        <select value={node.agent} onChange={(e) => set({ agent: e.target.value })}>
          {!agents.some((a) => a.id === node.agent) && <option value={node.agent}>{node.agent} (missing)</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name || a.id} ({a.id})
            </option>
          ))}
        </select>
      </Field>

      <div className="grid-2">
        <Field label="Max LLM calls" hint="Blank = agent's value">
          <NumberInput integer min={1} value={node.max_llm_calls} placeholder={agentDef ? String(agentDef.max_llm_calls) : ''} onChange={(v) => set({ max_llm_calls: v })} />
        </Field>
        <Field label="Memory">
          <label className="check">
            <input type="checkbox" checked={node.inject_memory} onChange={(e) => set({ inject_memory: e.target.checked })} />
            Inject memory snapshot
          </label>
        </Field>
      </div>

      <Collapsible title="Prompt template" defaultOpen={!!node.prompt_template} right={node.prompt_template ? <Badge tone="warn">custom</Badge> : <span className="muted small">default</span>}>
        <PromptArea value={node.prompt_template} onChange={(v) => set({ prompt_template: v })} rows={6} placeholder="{{ agent_prompt }}" />
        <span className="field-hint">{PROMPT_VARS_HELP}</span>
      </Collapsible>

      <Collapsible
        title="Modes"
        defaultOpen={node.modes.length > 0}
        right={node.modes.length ? <Badge tone="neutral">{node.modes.length}</Badge> : null}
      >
        <ModesEditor modes={node.modes} initialMode={node.initial_mode} onChange={(modes, initial_mode) => set({ modes, initial_mode })} />
      </Collapsible>

      <Collapsible
        title="Context (retrieval)"
        defaultOpen={(node.context ?? []).length > 0}
        right={(node.context ?? []).length ? <Badge tone="neutral">{(node.context ?? []).length}</Badge> : null}
      >
        <NodeContextEditor value={node.context ?? []} onChange={(context) => set({ context })} />
      </Collapsible>

      <Collapsible
        title="Model override"
        defaultOpen={!isEmptyModel(node.model)}
        right={!isEmptyModel(node.model) ? <Badge tone="warn">{modelSummary(node.model)}</Badge> : <span className="muted small">inherit</span>}
      >
        <ModelSpecEditor
          value={node.model ?? {}}
          onChange={(v) => set({ model: isEmptyModel(v) ? null : v })}
          presets={presets}
          inheritNote={`Blank fields inherit from the agent (${agentDef ? modelSummary(agentDef.model) : '…'}).`}
        />
      </Collapsible>

      <Collapsible
        title="Tool config overrides"
        defaultOpen={Object.keys(node.tool_config).length > 0}
        right={Object.keys(node.tool_config).length ? <Badge tone="warn">{Object.keys(node.tool_config).length}</Badge> : null}
      >
        {agentError != null ? (
          <ErrorBox error={agentError} title="Could not load the agent" />
        ) : agentDef ? (
          <ToolConfigOverrides agent={agentDef} catalog={catalog} value={node.tool_config} onChange={(tool_config) => set({ tool_config })} />
        ) : (
          <Loading />
        )}
      </Collapsible>

      <Collapsible title="Extra tools (system-specific)" defaultOpen={node.tools.length > 0} right={node.tools.length ? <Badge tone="neutral">{node.tools.length}</Badge> : null}>
        <ToolBindingsEditor
          value={node.tools}
          onChange={(tools) => set({ tools })}
          catalog={catalog}
          reservedNames={agentDef ? agentDef.tools.map(functionName) : []}
          emptyText="No extra tools; the node uses the agent's tools."
        />
      </Collapsible>

      <div className="inspector-danger">
        <button
          className="btn btn-danger-ghost btn-sm"
          onClick={() => {
            const n = linksIn.length + linksOut.length;
            if (!window.confirm(`Remove node "${node.id}"${n ? ` and its ${n} link(s)` : ''}?`)) return;
            onChange(removeNode(system, node.id));
            onSelect(null);
          }}
        >
          Remove node
        </button>
      </div>
    </div>
  );
}

function NodeIdField({ value, taken, onCommit }: { value: string; taken: string[]; onCommit: (id: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const problem = !IDENT_RE.test(text) ? 'Must match ^[A-Za-z_][A-Za-z0-9_]*$' : taken.includes(text) ? 'Another node has this id' : null;
  const commit = () => {
    if (text === value) return;
    if (problem) setText(value);
    else onCommit(text);
  };
  return (
    <Field
      label="Node id"
      hint={problem && text !== value ? <span className="text-danger">{problem}</span> : 'Also the ADK agent name. Renaming updates links and entry.'}
    >
      <input
        className="mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setText(value);
        }}
      />
    </Field>
  );
}
