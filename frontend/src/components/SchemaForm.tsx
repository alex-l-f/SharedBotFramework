// A form generated from a pydantic JSON schema (a tool's config_schema).
// Only keys the user sets are stored; unset keys fall back to the default
// (or to `baseValues`, e.g. the agent's config under a node override).

import { useState, type ComponentType } from 'react';
import type { JSONSchema } from '../types';
import { toInline } from '../lib/util';
import { JsonField, NumberInput, StringListEditor, isObject } from './ui';

type Kind = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'string-list' | 'json';

interface Resolved {
  schema: JSONSchema;
  kind: Kind;
  nullable: boolean;
}

function deref(s: JSONSchema, root: JSONSchema): JSONSchema {
  let cur = s;
  for (let i = 0; i < 10 && cur.$ref; i++) {
    const name = cur.$ref.replace(/^#\/(\$defs|definitions)\//, '');
    const target = root.$defs?.[name];
    if (!target) break;
    // Sibling keywords (description, default) win over the referenced schema.
    const { $ref: _ref, ...rest } = cur;
    cur = { ...target, ...rest };
  }
  return cur;
}

function resolve(raw: JSONSchema, root: JSONSchema): Resolved {
  let s = deref(raw, root);
  let nullable = false;
  const variants = s.anyOf ?? s.oneOf;
  if (variants) {
    const nonNull = variants.filter((v) => v.type !== 'null');
    nullable = nonNull.length < variants.length;
    if (nonNull.length === 1) {
      const { anyOf: _a, oneOf: _o, ...outer } = s;
      s = { ...deref(nonNull[0], root), ...outer };
    } else {
      return { schema: s, kind: 'json', nullable };
    }
  }
  if (s.allOf && s.allOf.length === 1) {
    const { allOf: _x, ...outer } = s;
    s = { ...deref(s.allOf[0], root), ...outer };
  }
  if (s.enum) return { schema: s, kind: 'enum', nullable };
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (Array.isArray(s.type) && s.type.includes('null')) nullable = true;
  switch (type) {
    case 'boolean':
      return { schema: s, kind: 'boolean', nullable };
    case 'integer':
      return { schema: s, kind: 'integer', nullable };
    case 'number':
      return { schema: s, kind: 'number', nullable };
    case 'string':
      return { schema: s, kind: 'string', nullable };
    case 'array': {
      const items = s.items ? deref(s.items, root) : undefined;
      if (items && (items.type === 'string' || items.enum)) return { schema: s, kind: 'string-list', nullable };
      return { schema: s, kind: 'json', nullable };
    }
    default:
      return { schema: s, kind: 'json', nullable };
  }
}

/** Props of a custom control for one property (see SchemaForm's `widgets`). */
export interface SchemaWidgetProps {
  /** The set value (undefined = unset, the fallback applies). */
  value: unknown;
  onChange: (v: unknown) => void;
  /** Inherited/default value shown when unset. */
  fallback: unknown;
  fallbackLabel: string;
}
export type SchemaWidget = ComponentType<SchemaWidgetProps>;

export function schemaHasFields(schema: JSONSchema | undefined): boolean {
  return !!schema && Object.keys(schema.properties ?? {}).length > 0;
}

export function SchemaForm({
  schema,
  value,
  onChange,
  baseValues,
  baseLabel = 'default',
  widgets,
}: {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  /** Values inherited from a lower layer, shown as placeholders. */
  baseValues?: Record<string, unknown>;
  baseLabel?: string;
  /** Custom controls by property name (e.g. a retriever picker). */
  widgets?: Record<string, SchemaWidget>;
}) {
  const [raw, setRaw] = useState(false);
  const props = schema.properties ?? {};
  const keys = Object.keys(props);
  const extra = Object.keys(value).filter((k) => !(k in props));

  const set = (key: string, v: unknown) => {
    const next = { ...value };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };

  if (!keys.length && !extra.length) {
    return <div className="muted small">No configuration.</div>;
  }

  return (
    <div className="schema-form">
      <div className="schema-form-toolbar">
        <label className="check small">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> Edit as JSON
        </label>
      </div>
      {raw ? (
        <JsonField<Record<string, unknown>> value={value} onChange={onChange} emptyValue={{}} rows={8} validate={isObject} placeholder="{}" />
      ) : (
        <>
          {keys.map((key) => (
            <SchemaField
              key={key}
              name={key}
              resolved={resolve(props[key], schema)}
              value={value[key]}
              base={baseValues?.[key]}
              baseLabel={baseLabel}
              onChange={(v) => set(key, v)}
              widget={widgets?.[key]}
            />
          ))}
          {extra.length > 0 && (
            <div className="notice notice-warn small">
              Keys not in the tool's schema: {extra.map((k) => <code key={k}>{k}</code>)}{' '}
              <button type="button" className="btn btn-sm" onClick={() => onChange(Object.fromEntries(Object.entries(value).filter(([k]) => k in props)))}>
                Remove them
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SchemaField({
  name,
  resolved,
  value,
  base,
  baseLabel,
  onChange,
  widget: Widget,
}: {
  name: string;
  resolved: Resolved;
  value: unknown;
  base: unknown;
  baseLabel: string;
  onChange: (v: unknown) => void;
  widget?: SchemaWidget;
}) {
  const { schema: s, kind } = resolved;
  const isSet = value !== undefined;
  const fallback = base !== undefined ? base : s.default;
  const fallbackLabel = base !== undefined ? baseLabel : 'default';
  const fallbackText = fallback === undefined ? '' : toInline(fallback);
  const label = s.title || name;
  const reset = isSet ? (
    <button type="button" className="link-btn small" onClick={() => onChange(undefined)} title={`Remove the override (use ${fallbackLabel})`}>
      reset
    </button>
  ) : null;

  let control: React.ReactNode;
  if (Widget) {
    control = <Widget value={value} onChange={onChange} fallback={fallback} fallbackLabel={fallbackLabel} />;
  } else switch (kind) {
    case 'boolean': {
      const checked = isSet ? Boolean(value) : Boolean(fallback);
      control = (
        <label className="check">
          <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
          <span className={isSet ? '' : 'muted'}>{checked ? 'true' : 'false'}{!isSet && ` (${fallbackLabel})`}</span>
        </label>
      );
      break;
    }
    case 'integer':
    case 'number':
      control = (
        <NumberInput
          value={isSet ? (value as number) : null}
          onChange={(v) => onChange(v === null ? undefined : v)}
          integer={kind === 'integer'}
          min={s.minimum ?? s.exclusiveMinimum}
          max={s.maximum ?? s.exclusiveMaximum}
          placeholder={fallbackText ? `${fallbackText} (${fallbackLabel})` : ''}
        />
      );
      break;
    case 'enum': {
      // Options are addressed by index: an enum may contain "" (e.g. "use the default"),
      // which must not collide with the unset option.
      const options = s.enum ?? [];
      const idx = isSet ? options.findIndex((o) => toInline(o) === toInline(value)) : -1;
      const show = (o: unknown) => (o === '' ? '"" (empty)' : toInline(o));
      control = (
        <select
          value={isSet ? (idx >= 0 ? String(idx) : 'unknown') : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : options[Number(e.target.value)])}
        >
          <option value="">{fallback !== undefined ? `(${fallbackLabel}: ${fallback === '' ? '""' : fallbackText})` : '(unset)'}</option>
          {options.map((o, i) => (
            <option key={i} value={String(i)}>
              {show(o)}
            </option>
          ))}
          {isSet && idx < 0 && <option value="unknown">{toInline(value)} (not allowed)</option>}
        </select>
      );
      break;
    }
    case 'string': {
      const long = (typeof fallback === 'string' && fallback.length > 70) || (typeof value === 'string' && value.length > 70);
      const common = {
        value: isSet ? String(value ?? '') : '',
        placeholder: fallbackText ? `${fallbackText}` : '',
      };
      control = long ? (
        <textarea rows={3} {...common} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
      ) : (
        <input {...common} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />
      );
      break;
    }
    case 'string-list':
      control = isSet ? (
        <StringListEditor value={Array.isArray(value) ? value.map(String) : []} onChange={(v) => onChange(v)} addLabel="Add item" />
      ) : (
        <div className="row gap-sm">
          <span className="muted small">
            {fallback === undefined ? (
              "Not set (the tool's built-in default applies)"
            ) : (
              <>
                {fallbackLabel}: <code>{fallbackText}</code>
              </>
            )}
          </span>
          <button type="button" className="btn btn-sm" onClick={() => onChange(Array.isArray(fallback) ? [...(fallback as unknown[])] : [])}>
            Override
          </button>
        </div>
      );
      break;
    default:
      control = (
        <JsonField
          value={isSet ? value : undefined}
          onChange={(v) => onChange(v)}
          optional
          rows={5}
          placeholder={fallbackText ? `${fallbackLabel}: ${fallbackText}` : 'JSON'}
        />
      );
  }

  return (
    <div className={`schema-field${isSet ? ' is-set' : ''}`}>
      <div className="field-label-row">
        <span className="field-label">
          {label} <code className="muted small">{name}</code>
        </span>
        {reset}
      </div>
      {control}
      {s.description && <span className="field-hint">{s.description}</span>}
    </div>
  );
}
