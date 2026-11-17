import { toolWidgets } from '../../components/RetrieverSelect';
import { SchemaForm } from '../../components/SchemaForm';
import { functionName } from '../../components/ToolBindingsEditor';
import { Badge, Collapsible, EmptyState } from '../../components/ui';
import type { AgentDef, ToolInfo } from '../../types';

/** Per-node config overrides for the agent's own tools, keyed by function name. */
export function ToolConfigOverrides({
  agent,
  catalog,
  value,
  onChange,
}: {
  agent: AgentDef;
  catalog: ToolInfo[];
  value: Record<string, Record<string, unknown>>;
  onChange: (v: Record<string, Record<string, unknown>>) => void;
}) {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const names = agent.tools.map(functionName);
  const stale = Object.keys(value).filter((k) => !names.includes(k));

  const set = (fname: string, cfg: Record<string, unknown>) => {
    const next = { ...value };
    if (Object.keys(cfg).length) next[fname] = cfg;
    else delete next[fname];
    onChange(next);
  };

  if (!agent.tools.length && !stale.length) return <EmptyState>The agent has no tools to configure.</EmptyState>;

  return (
    <div className="tool-overrides">
      {agent.tools.map((b) => {
        const fname = functionName(b);
        const info = byId.get(b.tool);
        const override = value[fname];
        const hasSchema = !!info && Object.keys(info.config_schema.properties ?? {}).length > 0;
        return (
          <Collapsible
            key={fname}
            className="compact"
            title={
              <span>
                <code>{fname}</code>{' '}
                {override ? <Badge tone="warn">overridden ({Object.keys(override).length})</Badge> : !hasSchema ? <span className="muted small">no config</span> : null}
              </span>
            }
            defaultOpen={!!override}
          >
            {info ? (
              <SchemaForm
                schema={info.config_schema}
                value={override ?? {}}
                onChange={(cfg) => set(fname, cfg)}
                baseValues={b.config}
                baseLabel="agent"
                widgets={toolWidgets(b.tool)}
              />
            ) : (
              <SchemaForm schema={{ type: 'object', properties: {} }} value={override ?? {}} onChange={(cfg) => set(fname, cfg)} />
            )}
          </Collapsible>
        );
      })}
      {stale.length > 0 && (
        <div className="notice notice-warn small">
          Overrides for tools the agent does not have: {stale.map((k) => <code key={k}>{k} </code>)}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => names.includes(k))))}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}
