// Picking a retriever (rag_search tool config, node retrieval context).

import { useId } from 'react';
import { errorLines } from '../api';
import { useKnownRetrieverIds, useRetrievers } from '../lib/refdata';
import type { SchemaWidget, SchemaWidgetProps } from './SchemaForm';

/** A select of saved retrievers; falls back to a text input when the list cannot load. */
export function RetrieverSelect({
  value,
  onChange,
  emptyLabel = '(choose a retriever)',
  invalid,
}: {
  value: string;
  onChange: (id: string) => void;
  emptyLabel?: string;
  invalid?: boolean;
}) {
  const retrievers = useRetrievers();
  const failed = retrievers.error != null;
  const known = useKnownRetrieverIds(failed);
  const listId = useId();
  const list = retrievers.data ?? [];
  if (failed) {
    return (
      <div>
        <input
          className={`mono${invalid ? ' invalid' : ''}`}
          list={listId}
          value={value}
          placeholder="retriever id"
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <datalist id={listId}>
          {(known.data ?? []).map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <span className="field-hint text-warn">Could not load the retriever list ({errorLines(retrievers.error)[0]}); type the id.</span>
      </div>
    );
  }
  return (
    <div className="row gap-sm">
      <select className={invalid ? 'invalid' : undefined} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{retrievers.loading && !retrievers.data ? 'Loading…' : emptyLabel}</option>
        {list.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name || r.id} ({r.id}) — {r.method} → {r.presentation}
          </option>
        ))}
        {value && retrievers.data && !list.some((r) => r.id === value) && <option value={value}>{value} (missing)</option>}
      </select>
      {value && (
        <a href={`/data/retrievers/${encodeURIComponent(value)}`} target="_blank" rel="noreferrer" className="small nowrap" title="Open the retriever in a new tab">
          open ↗
        </a>
      )}
    </div>
  );
}

/** SchemaForm widget for a `retriever` config property. */
function RetrieverWidget({ value, onChange, fallback, fallbackLabel }: SchemaWidgetProps) {
  const fb = typeof fallback === 'string' ? fallback : '';
  return (
    <RetrieverSelect
      value={typeof value === 'string' ? value : ''}
      onChange={(id) => onChange(id === '' ? undefined : id)}
      emptyLabel={fb ? `(${fallbackLabel}: ${fb})` : '(choose a retriever)'}
    />
  );
}

/** Custom config controls for a tool's SchemaForm. */
export function toolWidgets(toolId: string): Record<string, SchemaWidget> | undefined {
  if (toolId === 'rag_search') return { retriever: RetrieverWidget };
  return undefined;
}
