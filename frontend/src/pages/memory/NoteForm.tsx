import { useState } from 'react';
import { ErrorBox, Field, NumberInput } from '../../components/ui';
import type { Library, MemoryTemplateInfo } from '../../types';

const RESOURCE_KEYS = ['provider', 'resource', 'title'];

/** Template-driven note form: every slot is a dropdown (or a resource reference). */
export function NoteForm({
  templates,
  libraries,
  initialTemplate,
  initialSlots,
  fixedTemplate,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  templates: Record<string, MemoryTemplateInfo>;
  libraries: Library[];
  initialTemplate?: string;
  initialSlots?: Record<string, unknown>;
  fixedTemplate?: boolean;
  submitLabel: string;
  onSubmit: (template: string, slots: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
}) {
  const keys = Object.keys(templates);
  const [template, setTemplate] = useState(initialTemplate ?? keys[0] ?? '');
  const [slots, setSlots] = useState<Record<string, unknown>>(initialSlots ?? {});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const spec = templates[template];

  const set = (k: string, v: unknown) => {
    const next = { ...slots };
    if (v === '' || v === null || v === undefined) delete next[k];
    else next[k] = v;
    setSlots(next);
  };

  const missing = spec
    ? Object.entries(spec.slots)
        .filter(([name, s]) => s.required && (s.ref === 'resource' ? slots.provider == null || slots.resource == null : slots[name] == null))
        .map(([name]) => name)
    : [];

  const submit = async () => {
    if (!spec) return;
    // Only send slots of this template (plus the flat resource keys).
    const allowed = new Set([...Object.keys(spec.slots), ...RESOURCE_KEYS]);
    const clean = Object.fromEntries(Object.entries(slots).filter(([k]) => allowed.has(k)));
    setBusy(true);
    setError(null);
    try {
      await onSubmit(template, clean);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="note-form">
      <Field label="Template" hint={spec?.description}>
        <select value={template} disabled={fixedTemplate} onChange={(e) => {
          setTemplate(e.target.value);
          setSlots({});
        }}>
          {keys.map((k) => (
            <option key={k} value={k}>
              {k}
              {templates[k].follow_up ? ' (follow-up)' : ''}
            </option>
          ))}
        </select>
      </Field>
      {spec && (
        <div className="grid-3">
          {Object.entries(spec.slots).map(([name, s]) =>
            s.ref === 'resource' ? (
              <div key={name} className="resource-slot span-3">
                <div className="field-label">
                  {name} (resource){s.required && <span className="text-danger"> *</span>}
                </div>
                <div className="grid-3">
                  <Field label="Library">
                    <select value={typeof slots.provider === 'string' ? slots.provider : ''} onChange={(e) => set('provider', e.target.value)}>
                      <option value="">—</option>
                      {libraries.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.label || l.id}
                        </option>
                      ))}
                      {typeof slots.provider === 'string' && slots.provider && !libraries.some((l) => l.id === slots.provider) && (
                        <option value={slots.provider}>{slots.provider}</option>
                      )}
                    </select>
                  </Field>
                  <Field label="Resource id">
                    <NumberInput integer min={0} value={typeof slots.resource === 'number' ? slots.resource : null} onChange={(v) => set('resource', v)} />
                  </Field>
                  <Field label="Title (optional)">
                    <input value={typeof slots.title === 'string' ? slots.title : ''} onChange={(e) => set('title', e.target.value)} />
                  </Field>
                </div>
              </div>
            ) : (
              <Field key={name} label={<>{name}{s.required && <span className="text-danger"> *</span>}</>}>
                <select value={typeof slots[name] === 'string' ? (slots[name] as string) : ''} onChange={(e) => set(name, e.target.value)}>
                  <option value="">{s.required ? '— choose —' : '(none)'}</option>
                  {s.enum.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </Field>
            ),
          )}
        </div>
      )}
      {error != null && <ErrorBox error={error} />}
      <div className="row gap-sm">
        <button className="btn btn-primary btn-sm" disabled={!spec || busy || missing.length > 0} onClick={submit} title={missing.length ? `Missing: ${missing.join(', ')}` : undefined}>
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
        {missing.length > 0 && <span className="muted small">Required: {missing.join(', ')}</span>}
      </div>
    </div>
  );
}
