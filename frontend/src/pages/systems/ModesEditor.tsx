import { useState } from 'react';
import { Badge, EmptyState, Field, JsonField, PromptArea, isObject } from '../../components/ui';
import { IDENT_RE, uniqueId } from '../../lib/util';
import type { ModeDef } from '../../types';

/** Modes of a node: context variants it switches between with switch_mode. */
export function ModesEditor({
  modes,
  initialMode,
  onChange,
}: {
  modes: ModeDef[];
  initialMode: string | null | undefined;
  onChange: (modes: ModeDef[], initialMode: string | null) => void;
}) {
  const [open, setOpen] = useState<number | null>(null);

  const setMode = (i: number, patch: Partial<ModeDef>) => {
    const old = modes[i];
    const next = modes.map((m, j) => (j === i ? { ...m, ...patch } : m));
    const init = patch.id !== undefined && initialMode === old.id ? patch.id : (initialMode ?? null);
    onChange(next, init);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= modes.length) return;
    const next = [...modes];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next, initialMode ?? null);
    if (open === i) setOpen(j);
  };
  const add = () => {
    const id = uniqueId('mode', modes.map((m) => m.id));
    onChange([...modes, { id, label: '', description: '', prompt: '', state: {} }], initialMode ?? null);
    setOpen(modes.length);
  };
  const remove = (i: number) => {
    const removed = modes[i];
    if (removed.prompt && !window.confirm(`Remove mode "${removed.id}"?`)) return;
    onChange(
      modes.filter((_, j) => j !== i),
      initialMode === removed.id ? null : (initialMode ?? null),
    );
    setOpen(null);
  };

  return (
    <div className="modes-editor">
      {modes.length > 0 && (
        <Field label="Initial mode">
          <select value={initialMode ?? ''} onChange={(e) => onChange(modes, e.target.value || null)}>
            <option value="">(first mode: {modes[0]?.id})</option>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.label ? ` — ${m.label}` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {modes.length === 0 && <EmptyState>No modes. Modes are context variants the node switches between (switch_mode tool).</EmptyState>}
      {modes.map((m, i) => {
        const isOpen = open === i;
        const idBad = !IDENT_RE.test(m.id) || modes.findIndex((x) => x.id === m.id) !== i;
        return (
          <div key={i} className={`mode-card${isOpen ? ' open' : ''}`}>
            <div className="mode-card-header">
              <button type="button" className="tool-card-title" onClick={() => setOpen(isOpen ? null : i)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <code>{m.id}</code>
                {m.label && <span className="muted">{m.label}</span>}
              </button>
              <span className="tool-card-meta">
                {(initialMode ? initialMode === m.id : i === 0) && <Badge tone="accent">initial</Badge>}
                {idBad && <Badge tone="danger">bad id</Badge>}
                <Badge tone="muted">{m.prompt.length.toLocaleString()} chars</Badge>
                {Object.keys(m.state).length > 0 && <Badge tone="muted" title={JSON.stringify(m.state)}>state</Badge>}
              </span>
              <span className="tool-card-actions">
                <button type="button" className="btn btn-ghost btn-icon" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">
                  ↑
                </button>
                <button type="button" className="btn btn-ghost btn-icon" disabled={i === modes.length - 1} onClick={() => move(i, 1)} title="Move down">
                  ↓
                </button>
                <button type="button" className="btn btn-ghost btn-icon danger" onClick={() => remove(i)} title="Remove">
                  ×
                </button>
              </span>
            </div>
            {isOpen && (
              <div className="mode-card-body">
                <div className="grid-2">
                  <Field label="Id" hint={idBad ? <span className="text-danger">Must be a unique identifier</span> : undefined}>
                    <input className="mono" value={m.id} onChange={(e) => setMode(i, { id: e.target.value })} />
                  </Field>
                  <Field label="Label">
                    <input value={m.label} onChange={(e) => setMode(i, { label: e.target.value })} />
                  </Field>
                </div>
                <Field label="Description" hint="Shown to the model when it chooses a mode.">
                  <textarea rows={2} value={m.description} onChange={(e) => setMode(i, { description: e.target.value })} />
                </Field>
                <Field label="Prompt" hint="Available to the prompt template as {{ mode.prompt }}.">
                  <PromptArea value={m.prompt} onChange={(v) => setMode(i, { prompt: v })} rows={12} />
                </Field>
                <Field label="State" hint="Session state set on entering the mode (e.g. the active library).">
                  <JsonField<Record<string, unknown>> value={m.state} onChange={(v) => setMode(i, { state: v })} emptyValue={{}} rows={3} validate={isObject} placeholder="{}" />
                </Field>
              </div>
            )}
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={add}>
        + Add mode
      </button>
    </div>
  );
}
