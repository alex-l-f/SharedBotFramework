import { PROVIDERS, type ModelSpec, type Provider } from '../types';
import { compactModel } from '../lib/util';
import { Field, NumberInput } from './ui';

const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

/**
 * Edits a ModelSpec. Every field is optional: blank = inherit (preset →
 * agent → node). Always emits a compact spec (no null fields).
 */
export function ModelSpecEditor({
  value,
  onChange,
  presets,
  excludePreset,
  inheritNote = 'Blank fields inherit.',
}: {
  value: ModelSpec | null | undefined;
  onChange: (v: ModelSpec) => void;
  presets: string[];
  excludePreset?: string;
  inheritNote?: string;
}) {
  const spec = value ?? {};
  const set = <K extends keyof ModelSpec>(key: K, v: ModelSpec[K] | null | '') => {
    onChange(compactModel({ ...spec, [key]: v === '' ? null : v }));
  };
  const presetOptions = presets.filter((p) => p !== excludePreset);
  const listId = 'effort-options';

  return (
    <div className="model-spec">
      <div className="grid-4">
        <Field label="Preset">
          <select value={spec.preset ?? ''} onChange={(e) => set('preset', e.target.value)}>
            <option value="">(inherit)</option>
            {presetOptions.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
            {spec.preset && !presetOptions.includes(spec.preset) && <option value={spec.preset}>{spec.preset} (unknown)</option>}
          </select>
        </Field>
        <Field label="Provider">
          <select value={spec.provider ?? ''} onChange={(e) => set('provider', e.target.value as Provider | '')}>
            <option value="">(inherit)</option>
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model" className="span-2">
          <input className="mono" value={spec.model ?? ''} placeholder="inherit" onChange={(e) => set('model', e.target.value)} />
        </Field>
        <Field label="Reasoning effort">
          <input list={listId} value={spec.reasoning_effort ?? ''} placeholder="inherit" onChange={(e) => set('reasoning_effort', e.target.value)} />
          <datalist id={listId}>
            {EFFORTS.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
        </Field>
        <Field label="Temperature">
          <NumberInput value={spec.temperature} onChange={(v) => set('temperature', v)} placeholder="inherit" min={0} step={0.05} />
        </Field>
        <Field label="top_p">
          <NumberInput value={spec.top_p} onChange={(v) => set('top_p', v)} placeholder="inherit" min={0} max={1} step={0.01} />
        </Field>
        <Field label="top_k">
          <NumberInput value={spec.top_k} onChange={(v) => set('top_k', v)} placeholder="inherit" integer min={0} />
        </Field>
        <Field label="Max output tokens">
          <NumberInput value={spec.max_output_tokens} onChange={(v) => set('max_output_tokens', v)} placeholder="inherit" integer min={1} />
        </Field>
        <Field label="Presence penalty">
          <NumberInput value={spec.presence_penalty} onChange={(v) => set('presence_penalty', v)} placeholder="inherit" step={0.1} />
        </Field>
        <Field label="API base" className="span-2">
          <input className="mono" value={spec.api_base ?? ''} placeholder="inherit" onChange={(e) => set('api_base', e.target.value)} />
        </Field>
      </div>
      {inheritNote && <div className="field-hint">{inheritNote}</div>}
    </div>
  );
}

/** One-line summary of a spec ("default · temp 0.7"). */
export function modelSummary(spec: ModelSpec | null | undefined): string {
  const s = compactModel(spec);
  const parts: string[] = [];
  if (s.preset) parts.push(`preset ${s.preset}`);
  if (s.provider) parts.push(s.provider);
  if (s.model) parts.push(s.model);
  const rest = Object.entries(s).filter(([k]) => !['preset', 'provider', 'model'].includes(k));
  for (const [k, v] of rest) parts.push(`${k}=${String(v)}`);
  return parts.join(' · ') || 'inherit';
}
