import { modelSummary } from '../../components/ModelSpecEditor';
import { Badge, Collapsible } from '../../components/ui';
import type { ValidateResult } from '../../types';

export function ValidationPanel({ result: raw, stale, onClose }: { result: ValidateResult; stale: boolean; onClose: () => void }) {
  // A failed (non-strict) compile repeats the problems among its warnings.
  const result = { ...raw, warnings: raw.warnings.filter((w) => !raw.problems.includes(w)) };
  const tone = result.problems.length ? 'error' : result.warnings.length ? 'warn' : 'ok';
  return (
    <div className={`validation notice notice-${tone}`}>
      <div className="row space-between">
        <div className="row gap-sm wrap">
          <strong>{result.ok ? 'Valid' : `${result.problems.length} problem(s)`}</strong>
          {result.warnings.length > 0 && <Badge tone="warn">{result.warnings.length} warning(s)</Badge>}
          {result.hash && (
            <span className="small">
              snapshot <code>{result.hash}</code>
            </span>
          )}
          {result.user_facing && result.user_facing.length > 0 && <span className="small">user-facing: {result.user_facing.join(', ')}</span>}
          {stale && <Badge tone="muted">draft changed since</Badge>}
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
      {result.problems.length > 0 && (
        <ul className="problems">
          {result.problems.map((p, i) => (
            <li key={i} className="text-danger pre-line">
              {p}
            </li>
          ))}
        </ul>
      )}
      {result.warnings.length > 0 && (
        <ul className="warnings">
          {result.warnings.map((w, i) => (
            <li key={i} className="text-warn pre-line">
              {w}
            </li>
          ))}
        </ul>
      )}
      {result.models && Object.keys(result.models).length > 0 && (
        <Collapsible title={<span className="small">Resolved models</span>} className="compact">
          <table className="table table-compact">
            <tbody>
              {Object.entries(result.models).map(([node, spec]) => (
                <tr key={node}>
                  <td>
                    <code>{node}</code>
                  </td>
                  <td className="small">{modelSummary(spec)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Collapsible>
      )}
    </div>
  );
}
