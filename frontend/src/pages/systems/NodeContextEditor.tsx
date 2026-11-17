import { useState } from 'react';
import { RetrieverSelect } from '../../components/RetrieverSelect';
import { Badge, EmptyState, Field, NumberInput, PromptArea } from '../../components/ui';
import { IDENT_RE, newContext, uniqueId } from '../../lib/util';
import type { ContextDef } from '../../types';

/** A node's retrieval contexts (retrieve-before-the-turn RAG). */
export function NodeContextEditor({ value, onChange }: { value: ContextDef[]; onChange: (v: ContextDef[]) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const names = value.map((c) => c.name);

  const update = (i: number, patch: Partial<ContextDef>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (open === i) setOpen(j);
  };

  return (
    <div className="modes-editor">
      <div className="field-hint">
        Retrieved before the node runs and added to its instruction (<code>{'{{ context.<name> }}'}</code> in templates). Recomputed when the
        question or scope changes.
      </div>
      {value.length === 0 && <EmptyState>No retrieval context. The node can still search with a rag_search tool.</EmptyState>}
      {value.map((c, i) => {
        const isOpen = open === i;
        const nameBad = !IDENT_RE.test(c.name) || names.indexOf(c.name) !== i;
        return (
          <div key={i} className={`mode-card${isOpen ? ' open' : ''}`}>
            <div className="mode-card-header">
              <button type="button" className="tool-card-title" onClick={() => setOpen(isOpen ? null : i)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <code>{c.name || '(no name)'}</code>
              </button>
              <span className="tool-card-meta">
                {c.retriever ? <Badge tone="accent">{c.retriever}</Badge> : <Badge tone="danger">no retriever</Badge>}
                {nameBad && <Badge tone="danger">bad name</Badge>}
                <Badge tone="muted">{c.placement}</Badge>
                {c.condition && <Badge tone="muted" title={c.condition}>if …</Badge>}
                {c.scope_state_key && <Badge tone="muted" title="Scope from session state">scope: {c.scope_state_key}</Badge>}
                {c.budget != null && <Badge tone="muted">{c.budget.toLocaleString()} chars</Badge>}
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
                    setOpen(null);
                  }}
                >
                  ×
                </button>
              </span>
            </div>
            {isOpen && (
              <div className="mode-card-body">
                <div className="grid-2">
                  <Field
                    label="Name"
                    hint={nameBad ? <span className="text-danger">{names.indexOf(c.name) !== i ? 'Duplicate name' : 'Letters, digits and _'}</span> : <>Template variable <code>context.{c.name}</code></>}
                  >
                    <input className={`mono${nameBad ? ' invalid' : ''}`} value={c.name} onChange={(e) => update(i, { name: e.target.value.trim() })} />
                  </Field>
                  <Field label="Placement" hint={c.placement === 'append' ? 'Added after the instruction' : 'Only where the prompt template uses it'}>
                    <select value={c.placement} onChange={(e) => update(i, { placement: e.target.value as ContextDef['placement'] })}>
                      <option value="append">append</option>
                      <option value="template">template</option>
                    </select>
                  </Field>
                </div>
                <Field label="Retriever">
                  <RetrieverSelect value={c.retriever} onChange={(retriever) => update(i, { retriever })} invalid={!c.retriever} />
                </Field>
                <Field label="Label" hint="Heading above the material when appended.">
                  <input value={c.label} placeholder="e.g. Relevant library material" onChange={(e) => update(i, { label: e.target.value })} />
                </Field>
                <Field label="Question" hint="Jinja template for the retrieval question. Empty = the latest user message (a delegated node: its request).">
                  <PromptArea value={c.question} onChange={(question) => update(i, { question })} rows={2} placeholder="latest user message" />
                </Field>
                <div className="grid-2">
                  <Field label="Condition" hint="Jinja expression; retrieve only when true.">
                    <input className="mono" value={c.condition} placeholder="e.g. state.library" onChange={(e) => update(i, { condition: e.target.value })} />
                  </Field>
                  <Field label="Scope state key" hint="Search only the dataset named in this state key.">
                    <input className="mono" value={c.scope_state_key} placeholder="e.g. library" onChange={(e) => update(i, { scope_state_key: e.target.value.trim() })} />
                  </Field>
                </div>
                <Field label="Budget (chars)" hint="Blank = the retriever's budget.">
                  <NumberInput integer min={500} value={c.budget} placeholder="retriever's" onChange={(budget) => update(i, { budget })} />
                </Field>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => {
          onChange([...value, newContext(uniqueId(value.length ? 'context' : 'library', names), '')]);
          setOpen(value.length);
        }}
      >
        + Add context
      </button>
    </div>
  );
}
