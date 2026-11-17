import { useState, type ReactNode } from 'react';
import { api } from '../../api';
import { ErrorBox, Spinner } from '../../components/ui';
import { stableStringify } from '../../lib/util';
import type { PersonaDef, PromptPreview, RubricDef, ScenarioDef } from '../../types';

export type PreviewBody = {
  persona: string | Partial<PersonaDef>;
  scenario: string | Partial<ScenarioDef>;
  rubric?: string | Partial<RubricDef> | null;
};

/**
 * "Preview prompts" panel body: the controls (selects) come from the
 * editor; this runs POST /simulations/preview-prompts (no LLM call) and
 * shows the simulator's and/or judge's prompt.
 */
export function PromptPreviewBox({
  body,
  controls,
  show = ['simulator', 'judge'],
  note,
}: {
  body: PreviewBody | null;
  controls?: ReactNode;
  show?: ('simulator' | 'judge')[];
  note?: ReactNode;
}) {
  const [result, setResult] = useState<{ data: PromptPreview; key: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const key = body ? stableStringify(body) : '';

  const run = async () => {
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      setResult({ data: await api.simulations.previewPrompts(body), key });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const outdated = !!result && result.key !== key;
  return (
    <div className="prompt-preview">
      {controls}
      <div className="row gap-sm">
        <button className="btn btn-sm" disabled={!body || busy} onClick={() => void run()} title="Renders the prompt; no LLM call">
          {busy ? (
            <>
              <Spinner /> Rendering…
            </>
          ) : result ? (
            'Refresh preview'
          ) : (
            'Preview'
          )}
        </button>
        {outdated && <span className="small text-warn">The inputs changed — refresh to update.</span>}
        {note && <span className="muted small">{note}</span>}
      </div>
      {error != null && <ErrorBox error={error} title="Preview failed" />}
      {result && show.includes('simulator') && (
        <>
          <div className="subsection-title">
            Simulated user&apos;s system prompt <span className="muted">· {result.data.simulator.length.toLocaleString()} chars</span>
          </div>
          <pre className="preview-instruction sim-prompt">{result.data.simulator}</pre>
        </>
      )}
      {result && show.includes('judge') && result.data.judge && (
        <>
          <div className="subsection-title">
            Judge prompt <span className="muted">· transcript is a placeholder</span>
          </div>
          <pre className="preview-instruction sim-prompt">{result.data.judge}</pre>
        </>
      )}
      {result && show.includes('judge') && !result.data.judge && !show.includes('simulator') && (
        <div className="muted small">Pick a rubric to see the judge prompt.</div>
      )}
    </div>
  );
}
