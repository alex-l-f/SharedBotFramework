import { useMemo, useState } from 'react';
import type { ToolBinding, ToolInfo } from '../types';
import { toolWidgets } from './RetrieverSelect';
import { SchemaForm } from './SchemaForm';
import { Badge, Collapsible, EmptyState, Field, Modal, NumberInput } from './ui';

export function functionName(b: ToolBinding): string {
  return b.name || b.tool;
}

export function ToolBadges({ tool }: { tool: ToolInfo }) {
  return (
    <>
      {tool.terminal && (
        <Badge tone="accent" title="Calling this tool ends the agent's run">
          terminal
        </Badge>
      )}
      {tool.requires.map((r) => (
        <Badge key={r} tone="muted" title={`Requires ${r}`}>
          needs {r}
        </Badge>
      ))}
    </>
  );
}

/** Edits a list of ToolBindings (agent tools or a node's extra tools). */
export function ToolBindingsEditor({
  value,
  onChange,
  catalog,
  reservedNames = [],
  emptyText = 'No tools.',
}: {
  value: ToolBinding[];
  onChange: (v: ToolBinding[]) => void;
  catalog: ToolInfo[];
  /** Function names already taken elsewhere (e.g. by the agent's own tools). */
  reservedNames?: string[];
  emptyText?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const byId = useMemo(() => new Map(catalog.map((t) => [t.id, t])), [catalog]);

  const names = value.map(functionName);
  const dupes = new Set(names.filter((n, i) => names.indexOf(n) !== i || reservedNames.includes(n)));

  const update = (i: number, patch: Partial<ToolBinding>) => onChange(value.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (openIdx === i) setOpenIdx(j);
  };

  return (
    <div className="tool-bindings">
      {value.length === 0 && <EmptyState>{emptyText}</EmptyState>}
      {value.map((b, i) => {
        const info = byId.get(b.tool);
        const fname = functionName(b);
        const open = openIdx === i;
        const configKeys = Object.keys(b.config ?? {});
        return (
          <div key={i} className={`tool-card${b.enabled ? '' : ' disabled'}${open ? ' open' : ''}`}>
            <div className="tool-card-header">
              <input type="checkbox" checked={b.enabled} title="Enabled" onChange={(e) => update(i, { enabled: e.target.checked })} />
              <button type="button" className="tool-card-title" onClick={() => setOpenIdx(open ? null : i)}>
                <span className="caret">{open ? '▾' : '▸'}</span>
                <code className="tool-fname">{fname}</code>
                {b.name && b.name !== b.tool && <span className="muted small">({b.tool})</span>}
              </button>
              <span className="tool-card-meta">
                {!info && <Badge tone="danger">unknown tool</Badge>}
                {info && <ToolBadges tool={info} />}
                {dupes.has(fname) && <Badge tone="danger">duplicate name</Badge>}
                {b.budget != null && <Badge tone="muted">budget {b.budget}</Badge>}
                {b.result_cap != null && <Badge tone="muted">cap {b.result_cap}</Badge>}
                {configKeys.length > 0 && <Badge tone="muted" title={configKeys.join(', ')}>{configKeys.length} config</Badge>}
                {b.description && <Badge tone="muted">custom description</Badge>}
              </span>
              <span className="tool-card-actions">
                <button type="button" className="btn btn-ghost btn-icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-ghost btn-icon" title="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon danger"
                  title="Remove"
                  onClick={() => {
                    onChange(value.filter((_, j) => j !== i));
                    setOpenIdx(null);
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {open && (
              <div className="tool-card-body">
                {info && <div className="muted small tool-summary">{info.summary}</div>}
                <div className="grid-3">
                  <Field label="Function name" hint="Name shown to the model">
                    <input className="mono" value={b.name ?? ''} placeholder={b.tool} onChange={(e) => update(i, { name: e.target.value || null })} />
                  </Field>
                  <Field label="Budget" hint="Max calls per run">
                    <NumberInput integer min={0} value={b.budget} placeholder="unlimited" onChange={(v) => update(i, { budget: v })} />
                  </Field>
                  <Field label="Result cap" hint="Max chars of a string result">
                    <NumberInput integer min={0} value={b.result_cap} placeholder="no cap" onChange={(v) => update(i, { result_cap: v })} />
                  </Field>
                </div>
                <Collapsible title={<span>Description override{b.description ? ' (set)' : ''}</span>} defaultOpen={!!b.description}>
                  <textarea
                    rows={4}
                    value={b.description ?? ''}
                    placeholder={info?.description ?? ''}
                    onChange={(e) => update(i, { description: e.target.value || null })}
                  />
                  <span className="field-hint">Blank uses the tool's default description (shown as placeholder).</span>
                </Collapsible>
                <div className="subsection-title">Config</div>
                {info ? (
                  <SchemaForm schema={info.config_schema} value={b.config ?? {}} onChange={(config) => update(i, { config })} widgets={toolWidgets(b.tool)} />
                ) : (
                  <SchemaForm schema={{ type: 'object', properties: {} }} value={b.config ?? {}} onChange={(config) => update(i, { config })} />
                )}
              </div>
            )}
          </div>
        );
      })}
      <div>
        <button type="button" className="btn btn-sm" onClick={() => setPicking(true)}>
          + Add tool
        </button>
      </div>
      {picking && (
        <ToolPicker
          catalog={catalog}
          onClose={() => setPicking(false)}
          onPick={(tool) => {
            onChange([...value, { tool: tool.id, config: {}, enabled: true }]);
            setOpenIdx(value.length);
            setPicking(false);
          }}
          taken={names}
        />
      )}
    </div>
  );
}

export function ToolPicker({
  catalog,
  onPick,
  onClose,
  taken,
}: {
  catalog: ToolInfo[];
  onPick: (t: ToolInfo) => void;
  onClose: () => void;
  taken: string[];
}) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = catalog.filter(
      (t) => !needle || `${t.id} ${t.label} ${t.summary} ${t.category}`.toLowerCase().includes(needle),
    );
    const map = new Map<string, ToolInfo[]>();
    for (const t of filtered) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return [...map.entries()];
  }, [catalog, q]);

  return (
    <Modal title="Add tool" onClose={onClose} size="lg">
      <input autoFocus className="search" placeholder="Search tools…" value={q} onChange={(e) => setQ(e.target.value)} />
      {groups.length === 0 && <EmptyState>No tools match.</EmptyState>}
      {groups.map(([category, tools]) => (
        <div key={category} className="picker-group">
          <div className="picker-group-title">{category}</div>
          {tools.map((t) => (
            <button key={t.id} type="button" className="picker-item" onClick={() => onPick(t)}>
              <div className="picker-item-head">
                <strong>{t.label}</strong> <code className="muted">{t.id}</code> <ToolBadges tool={t} />
                {taken.includes(t.id) && <Badge tone="warn">already added</Badge>}
              </div>
              <div className="muted small">{t.summary}</div>
            </button>
          ))}
        </div>
      ))}
    </Modal>
  );
}
