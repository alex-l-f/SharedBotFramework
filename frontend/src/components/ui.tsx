import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorLines } from '../api';
import { stableStringify } from '../lib/util';

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  const lines = errorLines(error);
  return (
    <div className="notice notice-error" role="alert">
      {title && <strong>{title}</strong>}
      {lines.length === 1 ? (
        <div className="pre-line">{lines[0]}</div>
      ) : (
        <ul>
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return <div className={`notice notice-${tone}`}>{children}</div>;
}

export function MessageList({ tone, title, items }: { tone: 'warn' | 'error' | 'ok' | 'info'; title?: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className={`notice notice-${tone}`}>
      {title && <strong>{title}</strong>}
      <ul>
        {items.map((m, i) => (
          <li key={i} className="pre-line">
            {m}
          </li>
        ))}
      </ul>
    </div>
  );
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'muted' | 'delegate' | 'handoff' | 'observe';

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
  inline,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  inline?: boolean;
  className?: string;
}) {
  return (
    <label className={`field${inline ? ' field-inline' : ''}${className ? ` ${className}` : ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A form section that is not a <label> (for groups containing several inputs). */
export function FieldGroup({ label, hint, children, actions }: { label: ReactNode; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label-row">
        <span className="field-label">{label}</span>
        {actions}
      </div>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  size = 'md',
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Number input where blank means null (inherit / unset). */
export function NumberInput({
  value,
  onChange,
  integer,
  placeholder,
  min,
  max,
  step,
  className,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  integer?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number | 'any';
  className?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value == null ? '' : String(value));
    }
  }, [value]);
  return (
    <input
      type="number"
      className={className}
      value={text}
      placeholder={placeholder}
      min={min}
      max={max}
      step={step ?? (integer ? 1 : 'any')}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === '') {
          last.current = null;
          onChange(null);
          return;
        }
        const n = integer ? parseInt(t, 10) : parseFloat(t);
        if (!Number.isNaN(n)) {
          last.current = n;
          onChange(n);
        }
      }}
    />
  );
}

/** Chip-style list of short strings (tags). */
export function TagsInput({ value, onChange, placeholder = 'Add…' }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setText('');
  };
  return (
    <div className="tags-input">
      {value.map((t) => (
        <span key={t} className="chip">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (v.endsWith(',')) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={() => text && add(text)}
      />
    </div>
  );
}

/** Ordered list of strings, one input per row. */
export function StringListEditor({
  value,
  onChange,
  placeholder,
  addLabel = 'Add',
  multiline,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  multiline?: boolean;
}) {
  const set = (i: number, v: string) => onChange(value.map((x, j) => (j === i ? v : x)));
  return (
    <div className="string-list">
      {value.map((item, i) => (
        <div key={i} className="string-list-row">
          {multiline ? (
            <textarea rows={2} value={item} placeholder={placeholder} onChange={(e) => set(i, e.target.value)} />
          ) : (
            <input value={item} placeholder={placeholder} onChange={(e) => set(i, e.target.value)} />
          )}
          <button type="button" className="btn btn-ghost btn-icon" title="Move up" disabled={i === 0} onClick={() => {
            const next = [...value];
            [next[i - 1], next[i]] = [next[i], next[i - 1]];
            onChange(next);
          }}>
            ↑
          </button>
          <button type="button" className="btn btn-ghost btn-icon" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...value, ''])}>
        + {addLabel}
      </button>
    </div>
  );
}

/**
 * JSON textarea bound to a value. Invalid JSON is kept locally (with an
 * error) and not propagated. Blank → `emptyValue` when given.
 */
export function JsonField<T = unknown>({
  value,
  onChange,
  rows = 6,
  placeholder,
  emptyValue,
  optional,
  validate,
}: {
  value: T;
  onChange: (v: T) => void;
  rows?: number;
  placeholder?: string;
  /** Value emitted when the text is blank. */
  emptyValue?: T;
  /** Blank emits undefined (when no emptyValue is given). */
  optional?: boolean;
  validate?: (v: unknown) => string | null;
}) {
  const fmt = (v: T) => (v === undefined || v === null || (emptyValue !== undefined && stableStringify(v) === stableStringify(emptyValue)) ? '' : JSON.stringify(v, null, 2));
  const [text, setText] = useState(() => fmt(value));
  const [error, setError] = useState<string | null>(null);
  const last = useRef(stableStringify(value));
  useEffect(() => {
    const s = stableStringify(value);
    if (s !== last.current) {
      last.current = s;
      setText(fmt(value));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className="json-field">
      <textarea
        className={`mono${error ? ' invalid' : ''}`}
        rows={rows}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          if (!t.trim()) {
            if (emptyValue !== undefined) {
              setError(null);
              last.current = stableStringify(emptyValue);
              onChange(emptyValue);
            } else if (optional) {
              setError(null);
              last.current = stableStringify(undefined);
              onChange(undefined as T);
            } else setError('Required');
            return;
          }
          try {
            const parsed: unknown = JSON.parse(t);
            const problem = validate ? validate(parsed) : null;
            if (problem) {
              setError(problem);
              return;
            }
            setError(null);
            last.current = stableStringify(parsed);
            onChange(parsed as T);
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Invalid JSON');
          }
        }}
      />
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export const isObject = (v: unknown): string | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? null : 'Must be a JSON object';

/** Monospace textarea with a character counter. */
export function PromptArea({
  value,
  onChange,
  rows = 16,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`prompt-area${className ? ` ${className}` : ''}`}>
      <textarea className="mono" rows={rows} value={value} placeholder={placeholder} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <span className="char-count">{value.length.toLocaleString()} chars</span>
    </div>
  );
}

export function Collapsible({
  title,
  children,
  defaultOpen = false,
  right,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`collapsible${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <div className="collapsible-header">
        <button type="button" className="collapsible-toggle" onClick={() => setOpen(!open)}>
          <span className="caret">{open ? '▾' : '▸'}</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function DirtyDot({ dirty }: { dirty: boolean }) {
  return dirty ? <span className="dirty-dot" title="Unsaved changes" /> : null;
}
