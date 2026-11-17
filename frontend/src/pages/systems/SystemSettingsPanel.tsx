import { KeyTextEditor } from '../../components/KeyTextEditor';
import { Badge, Collapsible, Field, FieldGroup, JsonField, StringListEditor, TagsInput, isObject } from '../../components/ui';
import type { MemorySchemaSummary, SystemDef } from '../../types';

export function SystemSettingsPanel({
  system,
  schemas,
  onChange,
  onDelete,
}: {
  system: SystemDef;
  schemas: MemorySchemaSummary[];
  onChange: (s: SystemDef) => void;
  /** Omitted for someone who can't delete. */
  onDelete?: () => void;
}) {
  const set = <K extends keyof SystemDef>(key: K, v: SystemDef[K]) => onChange({ ...system, [key]: v });
  const fragCount = Object.keys(system.fragments).length;

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <div>
          <span className="muted small">System settings</span>
          <h2>{system.name || system.id}</h2>
        </div>
      </div>
      <p className="muted small">Select a node or link on the canvas to edit it. Drag between node handles to link them; drag from User to set the entry.</p>

      <Field label="Name">
        <input value={system.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea rows={3} value={system.description} onChange={(e) => set('description', e.target.value)} />
      </Field>
      <Field label="Tags">
        <TagsInput value={system.tags} onChange={(v) => set('tags', v)} />
      </Field>
      <Field label="Entry node" hint="The node that talks to the user">
        <select value={system.entry} onChange={(e) => set('entry', e.target.value)}>
          <option value="">(none)</option>
          {system.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label || n.id} ({n.id})
            </option>
          ))}
        </select>
      </Field>

      <Collapsible title="Chat UI" defaultOpen>
        <Field label="Title">
          <input value={system.ui.title} placeholder={system.name} onChange={(e) => set('ui', { ...system.ui, title: e.target.value })} />
        </Field>
        <Field label="Welcome (markdown)" hint="Shown before the first message">
          <textarea rows={6} value={system.ui.welcome} onChange={(e) => set('ui', { ...system.ui, welcome: e.target.value })} />
        </Field>
        <FieldGroup label="Starters" hint="Suggested first messages">
          <StringListEditor value={system.ui.starters} onChange={(v) => set('ui', { ...system.ui, starters: v })} addLabel="Add starter" placeholder="Suggested message" />
        </FieldGroup>
        <label className="check">
          <input type="checkbox" checked={system.ui.require_profile} onChange={(e) => set('ui', { ...system.ui, require_profile: e.target.checked })} />
          Require a profile before chatting
        </label>
        <label className="check">
          <input type="checkbox" checked={system.ui.show_viewer} onChange={(e) => set('ui', { ...system.ui, show_viewer: e.target.checked })} />
          Show the viewer panel (course pages)
        </label>
      </Collapsible>

      <Collapsible title="Memory" defaultOpen={system.memory.enabled} right={system.memory.enabled ? <Badge tone="ok">on</Badge> : <span className="muted small">off</span>}>
        <label className="check">
          <input type="checkbox" checked={system.memory.enabled} onChange={(e) => set('memory', { ...system.memory, enabled: e.target.checked })} />
          Enabled
        </label>
        <Field label="Schema">
          <select value={system.memory.schema_id ?? ''} onChange={(e) => set('memory', { ...system.memory, schema_id: e.target.value || null })}>
            <option value="">(none)</option>
            {schemas.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id} ({s.templates} templates)
              </option>
            ))}
            {system.memory.schema_id && !schemas.some((s) => s.id === system.memory.schema_id) && (
              <option value={system.memory.schema_id}>{system.memory.schema_id} (missing)</option>
            )}
          </select>
        </Field>
        <Field label="Namespace" hint="Memory partition; blank = the system id">
          <input className="mono" value={system.memory.namespace ?? ''} placeholder={system.id} onChange={(e) => set('memory', { ...system.memory, namespace: e.target.value || null })} />
        </Field>
      </Collapsible>

      <Collapsible title="Fragments" defaultOpen={false} right={fragCount ? <Badge tone="neutral">{fragCount}</Badge> : null}>
        <p className="muted small">System-specific prompt fragments ({'{{ fragments.<key> }}'}); they override shared fragments with the same key.</p>
        <KeyTextEditor value={system.fragments} onChange={(v) => set('fragments', v)} keyPlaceholder="fragment_key" addLabel="Add fragment" emptyText="No system fragments." />
      </Collapsible>

      <Collapsible title="Variables" right={Object.keys(system.variables).length ? <Badge tone="neutral">{Object.keys(system.variables).length}</Badge> : null}>
        <Field label="Variables (JSON)" hint="Available to templates as {{ vars.<key> }}">
          <JsonField<Record<string, unknown>> value={system.variables} onChange={(v) => set('variables', v)} emptyValue={{}} validate={isObject} rows={5} placeholder="{}" />
        </Field>
      </Collapsible>

      <Collapsible title="Initial state" right={Object.keys(system.state).length ? <Badge tone="neutral">{Object.keys(system.state).length}</Badge> : null}>
        <Field label="State (JSON)" hint="Initial session state of new chats">
          <JsonField<Record<string, unknown>> value={system.state} onChange={(v) => set('state', v)} emptyValue={{}} validate={isObject} rows={5} placeholder="{}" />
        </Field>
      </Collapsible>

      <Collapsible title="Notes" defaultOpen={!!system.notes}>
        <textarea rows={4} value={system.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Designer notes" />
      </Collapsible>

      {onDelete && (
        <div className="inspector-danger">
          <button className="btn btn-danger-ghost btn-sm" onClick={onDelete}>
            Delete system…
          </button>
        </div>
      )}
    </div>
  );
}
