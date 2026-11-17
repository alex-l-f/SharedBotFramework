import { useEffect, useRef, useState } from 'react';
import { stableStringify } from '../lib/util';
import { EmptyState, PromptArea } from './ui';

type Pair = { key: string; text: string };

const toPairs = (v: Record<string, string>): Pair[] => Object.entries(v).map(([key, text]) => ({ key, text }));
const toObject = (pairs: Pair[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.key) out[p.key] = p.text;
  return out;
};

/** Edits a string → text map (e.g. system prompt fragments). */
export function KeyTextEditor({
  value,
  onChange,
  keyPlaceholder = 'key',
  addLabel = 'Add',
  keyPattern,
  emptyText = 'None.',
  rows = 4,
  textPlaceholder,
}: {
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
  keyPlaceholder?: string;
  addLabel?: string;
  keyPattern?: RegExp;
  emptyText?: string;
  /** Rows of each text area. */
  rows?: number;
  textPlaceholder?: string;
}) {
  const [pairs, setPairs] = useState<Pair[]>(() => toPairs(value));
  const last = useRef(stableStringify(value));
  useEffect(() => {
    const s = stableStringify(value);
    if (s !== last.current) {
      last.current = s;
      setPairs(toPairs(value));
    }
  }, [value]);

  const emit = (next: Pair[]) => {
    setPairs(next);
    const obj = toObject(next);
    last.current = stableStringify(obj);
    onChange(obj);
  };

  return (
    <div className="key-text-editor">
      {pairs.length === 0 && <EmptyState>{emptyText}</EmptyState>}
      {pairs.map((p, i) => {
        const dup = pairs.findIndex((q) => q.key === p.key) !== i;
        const bad = !p.key || (keyPattern && !keyPattern.test(p.key));
        return (
          <div key={i} className="key-text-row">
            <div className="row gap-sm">
              <input
                className={`mono${dup || bad ? ' invalid' : ''}`}
                value={p.key}
                placeholder={keyPlaceholder}
                onChange={(e) => emit(pairs.map((q, j) => (j === i ? { ...q, key: e.target.value } : q)))}
              />
              {dup && <span className="text-danger small">duplicate</span>}
              {!dup && bad && p.key && <span className="text-danger small">invalid key</span>}
              <span className="grow" />
              <button type="button" className="btn btn-ghost btn-icon danger" title="Remove" onClick={() => emit(pairs.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
            <PromptArea
              value={p.text}
              onChange={(text) => emit(pairs.map((q, j) => (j === i ? { ...q, text } : q)))}
              rows={rows}
              placeholder={textPlaceholder}
            />
          </div>
        );
      })}
      <button type="button" className="btn btn-sm" onClick={() => setPairs([...pairs, { key: '', text: '' }])}>
        + {addLabel}
      </button>
    </div>
  );
}
