import { useMemo, useState } from 'react';
import { lineDiff, toDiffText, type DiffLine } from '../lib/diff';
import { pluralize } from '../lib/util';

const CONTEXT = 3;

type Block = { kind: 'lines'; lines: (DiffLine & { a?: number; b?: number })[] } | { kind: 'gap'; count: number; lines: (DiffLine & { a?: number; b?: number })[] };

/**
 * Line diff of two definitions (or texts): `-` lines only in `a`, `+` only
 * in `b`; long unchanged runs fold away.
 */
export function DiffView({
  a,
  b,
  aLabel,
  bLabel,
  text,
}: {
  a: unknown;
  b: unknown;
  aLabel: string;
  bLabel: string;
  /** a and b are plain texts (else definitions shown as YAML-like text). */
  text?: boolean;
}) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const { blocks, added, removed } = useMemo(() => {
    const ta = text ? String(a ?? '') : toDiffText(a);
    const tb = text ? String(b ?? '') : toDiffText(b);
    const lines = lineDiff(ta, tb);
    let na = 0;
    let nb = 0;
    const numbered = lines.map((l) => ({ ...l, a: l.op !== '+' ? ++na : undefined, b: l.op !== '-' ? ++nb : undefined }));
    // Keep CONTEXT lines around changes; fold the rest.
    const near = numbered.map(() => false);
    numbered.forEach((l, i) => {
      if (l.op === ' ') return;
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(numbered.length - 1, i + CONTEXT); k++) near[k] = true;
    });
    const out: Block[] = [];
    let i = 0;
    while (i < numbered.length) {
      const keep = near[i];
      const run: typeof numbered = [];
      while (i < numbered.length && near[i] === keep) run.push(numbered[i++]);
      out.push(keep || run.length <= 2 ? { kind: 'lines', lines: run } : { kind: 'gap', count: run.length, lines: run });
    }
    return { blocks: out, added: lines.filter((l) => l.op === '+').length, removed: lines.filter((l) => l.op === '-').length };
  }, [a, b, text]);

  return (
    <div className="diff">
      <div className="diff-legend small">
        <span className="diff-del-mark">− {aLabel}</span>
        <span className="diff-add-mark">+ {bLabel}</span>
        <span className="muted">
          {added || removed ? `${pluralize(removed, 'line')} removed, ${pluralize(added, 'line')} added` : 'No differences'}
        </span>
      </div>
      <div className="diff-body mono">
        {blocks.map((blk, bi) =>
          blk.kind === 'gap' && !open.has(bi) ? (
            <button key={bi} type="button" className="diff-gap" onClick={() => setOpen(new Set(open).add(bi))}>
              ⋯ {pluralize(blk.count, 'unchanged line')}
            </button>
          ) : (
            blk.lines.map((l, li) => (
              <div key={`${bi}-${li}`} className={`diff-line${l.op === '+' ? ' add' : l.op === '-' ? ' del' : ''}`}>
                <span className="diff-num">{l.a ?? ''}</span>
                <span className="diff-num">{l.b ?? ''}</span>
                <span className="diff-op">{l.op}</span>
                <span className="diff-text">{l.text || ' '}</span>
              </div>
            ))
          ),
        )}
      </div>
    </div>
  );
}
