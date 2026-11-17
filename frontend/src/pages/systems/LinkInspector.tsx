import { Badge, Field, FieldGroup, JsonField, NumberInput, PromptArea, StringListEditor, isObject } from '../../components/ui';
import { IDENT_RE } from '../../lib/util';
import { LINK_TYPES, type LinkDef, type LinkType, type SystemDef } from '../../types';
import { LINK_HELP, linkIdFor, removeLink, updateLink, type Selection } from './systemOps';

const DEFAULT_PARAMS = '{"type":"object","properties":{"question":{"type":"string"}},"required":["question"]}';

export function LinkInspector({
  system,
  link,
  onChange,
  onSelect,
}: {
  system: SystemDef;
  link: LinkDef;
  onChange: (s: SystemDef) => void;
  onSelect: (s: Selection) => void;
}) {
  const set = (patch: Partial<LinkDef>) => onChange(updateLink(system, link.id, patch));
  const nodeIds = system.nodes.map((n) => n.id);
  const toolNameBad = link.type === 'delegate' && (!link.tool_name || !IDENT_RE.test(link.tool_name));
  const idTaken = system.links.some((l) => l !== link && l.id === link.id);

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <div>
          <span className="muted small">Link</span>
          <h2>
            <Badge tone={link.type}>{link.type}</Badge> {link.source} → {link.target}
          </h2>
        </div>
      </div>
      <p className="muted small">{LINK_HELP[link.type]}</p>

      <div className="grid-2">
        <Field label="Type">
          <select value={link.type} onChange={(e) => {
            const type = e.target.value as LinkType;
            const patch: Partial<LinkDef> = { type };
            if (type === 'delegate' && !link.tool_name) patch.tool_name = `ask_${link.target}`;
            set(patch);
          }}>
            {LINK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Id" hint={idTaken ? <span className="text-danger">Duplicate link id</span> : undefined}>
          <div className="row gap-sm">
            <input className="mono" value={link.id} onChange={(e) => {
              const id = e.target.value;
              onChange({ ...system, links: system.links.map((l) => (l === link ? { ...l, id } : l)) });
              onSelect({ kind: 'link', id });
            }} />
            <button
              type="button"
              className="btn btn-sm"
              title="Regenerate from type/source/target"
              onClick={() => {
                const id = linkIdFor(system, link.type, link.source, link.target, link.id);
                onChange({ ...system, links: system.links.map((l) => (l === link ? { ...l, id } : l)) });
                onSelect({ kind: 'link', id });
              }}
            >
              ↻
            </button>
          </div>
        </Field>
        <Field label="Source">
          <select value={link.source} onChange={(e) => set({ source: e.target.value })}>
            {nodeIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target">
          <select value={link.target} onChange={(e) => set({ target: e.target.value })}>
            {nodeIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {link.type === 'delegate' && (
        <>
          <Field label="Tool name" hint={toolNameBad ? <span className="text-danger">Required; must be an identifier</span> : 'Function name the source agent calls'}>
            <input className="mono" value={link.tool_name ?? ''} onChange={(e) => set({ tool_name: e.target.value || null })} />
          </Field>
          <Field label="Tool description" hint="Model-facing description of the delegate tool">
            <textarea rows={4} value={link.tool_description} onChange={(e) => set({ tool_description: e.target.value })} />
          </Field>
          <Field label="Parameters (JSON schema)" hint="Blank = one required 'question' string">
            <JsonField<Record<string, unknown> | null>
              value={link.parameters ?? null}
              onChange={(v) => set({ parameters: v ?? null })}
              optional
              validate={isObject}
              rows={7}
              placeholder={DEFAULT_PARAMS}
            />
          </Field>
          <FieldGroup label="Require state" hint="Session state keys that must be set to delegate">
            <StringListEditor value={link.require_state} onChange={(v) => set({ require_state: v })} placeholder="state key" addLabel="Add key" />
          </FieldGroup>
          <Field label="Require-state error" hint="Returned to the source when a required key is missing">
            <textarea rows={2} value={link.require_state_error} onChange={(e) => set({ require_state_error: e.target.value })} />
          </Field>
        </>
      )}

      {(link.type === 'delegate' || link.type === 'observe') && (
        <>
          <Field
            label="Request template"
            hint={
              link.type === 'delegate'
                ? 'Jinja: the message the target receives. Variables include args, state, turn.user_message, parent. Blank = the question argument.'
                : 'Jinja: the message the observer receives. Variables include turn.surface, turn.resources, memory.notes, profile. Blank = default.'
            }
          >
            <PromptArea value={link.request_template} onChange={(v) => set({ request_template: v })} rows={8} />
          </Field>
          <div className="grid-2">
            <Field label="Max LLM calls" hint="Blank = target's value">
              <NumberInput integer min={1} value={link.max_llm_calls} onChange={(v) => set({ max_llm_calls: v })} placeholder="inherit" />
            </Field>
            <Field label="Share resources">
              <label className="check">
                <input type="checkbox" checked={link.share_resources} onChange={(e) => set({ share_resources: e.target.checked })} />
                {link.type === 'delegate' ? 'Merge resources the target retrieved back' : "Give the target the turn's resources"}
              </label>
            </Field>
          </div>
          <Field label="Nudge" hint="Reminder sent once if the target ends without its terminal tool">
            <textarea rows={2} value={link.nudge} onChange={(e) => set({ nudge: e.target.value })} />
          </Field>
        </>
      )}

      {link.type === 'observe' && (
        <Field label="Requires profile">
          <label className="check">
            <input type="checkbox" checked={link.requires_profile} onChange={(e) => set({ requires_profile: e.target.checked })} />
            Only run when a user profile is active
          </label>
        </Field>
      )}

      {link.type === 'handoff' && <p className="muted small">Handoff links have no extra settings.</p>}

      <div className="inspector-danger">
        <button
          className="btn btn-danger-ghost btn-sm"
          onClick={() => {
            onChange(removeLink(system, link.id));
            onSelect(null);
          }}
        >
          Remove link
        </button>
      </div>
    </div>
  );
}
