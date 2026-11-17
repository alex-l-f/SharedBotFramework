import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Field, FieldGroup, Modal, Notice, TagsInput } from '../../components/ui';
import { IDENT_RE, userFacingNodes } from '../../lib/util';
import { INPUT_ACTIONS, OUTPUT_ACTIONS, type ClassifierSummary, type GuardAction, type GuardDef, type GuardRule, type SafetyMeta, type SystemDef } from '../../types';
import { ACTION_LABEL, classifierCategories, ProviderBadge } from '../safety/safetyUi';
import { GUARD_PRESETS, guardedNode, newGuard, presetFor, removeGuard, updateGuard, type GuardPreset, type Selection } from './systemOps';

/** Actions that show `message` to someone (and what it is for). */
const MESSAGE_HINT: Partial<Record<GuardAction, string>> = {
  block: 'The reply the user gets instead (the agents do not run).',
  inform: 'Added to the agent’s instruction for this turn as a SAFETY CHECK note. Blank = a default note.',
  add_message: 'Shown to the user first (e.g. crisis resources); then the agents answer as usual.',
  regenerate: 'Sent instead if every retry is still flagged. Blank = a default reply.',
  replace: 'Sent instead of the flagged reply.',
};

export function GuardInspector({
  system,
  guard,
  classifiers,
  meta,
  onChange,
  onSelect,
}: {
  system: SystemDef;
  guard: GuardDef;
  classifiers: ClassifierSummary[];
  meta: SafetyMeta | undefined;
  onChange: (s: SystemDef) => void;
  onSelect: (s: Selection) => void;
}) {
  const set = (patch: Partial<GuardDef>) => onChange(updateGuard(system, guard.id, patch));
  const classifier = classifiers.find((c) => c.id === guard.classifier);
  const known = classifierCategories(classifier, meta);
  const actions: GuardAction[] = guard.check === 'input' ? INPUT_ACTIONS : OUTPUT_ACTIONS;
  const target = guardedNode(system, guard);
  const facing = userFacingNodes(system);
  const idBad = !IDENT_RE.test(guard.id);
  const idTaken = system.guards.some((g) => g !== guard && g.id === guard.id);
  const usesRetries = guard.check === 'output' && (guard.rules.length === 0 || guard.rules.some((r) => r.action === 'regenerate'));

  const setRule = (i: number, patch: Partial<GuardRule>) => set({ rules: guard.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const moveRule = (i: number, by: number) => {
    const next = [...guard.rules];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    set({ rules: next });
  };

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <div>
          <span className="muted small">Guard</span>
          <h2>
            <span aria-hidden>⛨</span> {classifier?.name || guard.classifier} <span className="muted">→</span> {target || '(entry)'}
          </h2>
        </div>
      </div>
      <p className="muted small">
        {guard.check === 'input'
          ? `Checks each user message before ${target || 'the entry node'} answers. The first rule whose categories match the verdict decides what happens.`
          : `Checks ${target || 'the entry node'}'s replies before they reach the user. The first rule whose categories match the verdict decides what happens.`}
      </p>

      <div className="grid-2">
        <Field label="Classifier" hint={classifier ? <ProviderBadge provider={classifier.provider} /> : <span className="text-danger">Unknown classifier</span>}>
          <select value={guard.classifier} onChange={(e) => set({ classifier: e.target.value })}>
            {!classifier && <option value={guard.classifier}>{guard.classifier} (missing)</option>}
            {classifiers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Node" hint={guard.check === 'output' && target && !facing.has(target) ? <span className="text-danger">This node doesn&apos;t talk to the user</span> : undefined}>
          <select value={guard.node} onChange={(e) => set({ node: e.target.value })}>
            <option value="">(the entry node{system.entry ? `: ${system.entry}` : ''})</option>
            {system.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.id}
                {facing.has(n.id) ? '' : ' (not user-facing)'}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Checks">
          <div className="seg">
            {(['input', 'output'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={guard.check === c ? 'active' : ''}
                onClick={() => {
                  if (c === guard.check) return;
                  // Actions differ between checks: keep rules whose action still applies.
                  const ok = c === 'input' ? INPUT_ACTIONS : OUTPUT_ACTIONS;
                  set({ check: c, rules: guard.rules.filter((r) => (ok as GuardAction[]).includes(r.action)) });
                }}
              >
                {c === 'input' ? 'User messages' : 'Replies'}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Id" hint={idBad ? <span className="text-danger">Letters, digits and _</span> : idTaken ? <span className="text-danger">Duplicate guard id</span> : undefined}>
          <input
            className="mono"
            value={guard.id}
            onChange={(e) => {
              const id = e.target.value;
              onChange({ ...system, guards: system.guards.map((g) => (g === guard ? { ...g, id } : g)) });
              onSelect({ kind: 'guard', id });
            }}
          />
        </Field>
        {guard.check === 'output' && (
          <Field label="What is classified" className="span-2">
            <div className="seg">
              <button type="button" className={guard.scope === 'message' ? 'active' : ''} onClick={() => set({ scope: 'message' })}>
                The reply alone
              </button>
              <button type="button" className={guard.scope === 'exchange' ? 'active' : ''} onClick={() => set({ scope: 'exchange' })}>
                The user&apos;s message + the reply
              </button>
            </div>
          </Field>
        )}
        <Field label="Enabled">
          <label className="check">
            <input type="checkbox" checked={guard.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            Run this check
          </label>
        </Field>
        {usesRetries && (
          <Field label="Retries" hint="How often to ask for a different reply before using the fallback message.">
            <select value={guard.max_retries} onChange={(e) => set({ max_retries: Number(e.target.value) })}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <FieldGroup
        label="When it flags something"
        actions={
          <span className="row gap-sm">
            {(Object.keys(GUARD_PRESETS) as GuardPreset[]).map((p) => (
              <button
                key={p}
                type="button"
                className="btn btn-sm"
                title={`${GUARD_PRESETS[p].help} Replaces the rules.`}
                onClick={() => {
                  if (guard.rules.length && !window.confirm(`Replace the rules with the ${GUARD_PRESETS[p].label} preset?`)) return;
                  set(presetFor(p, guard.check));
                }}
              >
                {GUARD_PRESETS[p].label}
              </button>
            ))}
          </span>
        }
        hint={
          guard.rules.length === 0
            ? undefined
            : 'Categories: blank = any unsafe verdict; otherwise the rule applies when a reported category contains one of them (case-insensitive).'
        }
      >
        {guard.rules.length === 0 && (
          <Notice>
            No rules: any unsafe verdict is {guard.check === 'input' ? 'blocked with a default reply' : `regenerated (up to ${guard.max_retries} times)`}.
          </Notice>
        )}
        <div className="guard-rules">
          {guard.rules.map((r, i) => (
            <div key={i} className="guard-rule">
              <div className="guard-rule-head">
                <Badge tone="muted">{i + 1}</Badge>
                <select value={r.action} onChange={(e) => setRule(i, { action: e.target.value as GuardAction })}>
                  {actions.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABEL[a]}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-ghost btn-icon" title="Move up" disabled={i === 0} onClick={() => moveRule(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn btn-ghost btn-icon" title="Move down" disabled={i === guard.rules.length - 1} onClick={() => moveRule(i, 1)}>
                  ↓
                </button>
                <button type="button" className="btn btn-ghost btn-icon danger" title="Remove rule" onClick={() => set({ rules: guard.rules.filter((_, j) => j !== i) })}>
                  ×
                </button>
              </div>
              <div className="field">
                <span className="field-label">Categories</span>
                <TagsInput value={r.categories} onChange={(v) => setRule(i, { categories: v })} placeholder={r.categories.length ? 'Add…' : 'any unsafe verdict'} />
                {known.length > 0 && (
                  <div className="category-suggestions">
                    {known
                      .filter((c) => !r.categories.some((x) => x.toLowerCase() === c.toLowerCase()))
                      .map((c) => (
                        <button key={c} type="button" className="chip chip-add" onClick={() => setRule(i, { categories: [...r.categories, c] })}>
                          + {c}
                        </button>
                      ))}
                  </div>
                )}
              </div>
              {MESSAGE_HINT[r.action] && (
                <Field label="Message" hint={MESSAGE_HINT[r.action]}>
                  <textarea rows={r.action === 'add_message' ? 5 : 2} value={r.message} onChange={(e) => setRule(i, { message: e.target.value })} />
                </Field>
              )}
            </div>
          ))}
        </div>
        <div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => set({ rules: [...guard.rules, { categories: [], action: 'flag', message: '' }] })}
          >
            + Add rule
          </button>
        </div>
      </FieldGroup>

      <p className="muted small">
        Every check is recorded in the chat&apos;s trace (Debug panel).{' '}
        {classifier && (
          <Link to={`/safety/${classifier.id}`} target="_blank">
            Open the classifier ↗
          </Link>
        )}
      </p>

      <div className="inspector-danger">
        <button
          className="btn btn-danger-ghost btn-sm"
          onClick={() => {
            onChange(removeGuard(system, guard.id));
            onSelect(null);
          }}
        >
          Remove guard
        </button>
      </div>
    </div>
  );
}

type AddChoice = GuardPreset | 'input' | 'output';

/** Picks a classifier, a node and a preset; adds one guard or an input + output pair. */
export function AddGuardModal({
  system,
  classifiers,
  onClose,
  onAdd,
}: {
  system: SystemDef;
  classifiers: ClassifierSummary[];
  onClose: () => void;
  onAdd: (guards: GuardDef[]) => void;
}) {
  const [classifier, setClassifier] = useState(classifiers[0]?.id ?? '');
  const [node, setNode] = useState('');
  const [choice, setChoice] = useState<AddChoice>('mira');
  const facing = userFacingNodes(system);
  const target = node || system.entry;
  const canOutput = !!target && facing.has(target);

  const add = () => {
    if (!classifier) return;
    let s = system;
    const out: GuardDef[] = [];
    const push = (check: GuardDef['check'], preset: GuardPreset | null) => {
      const g = newGuard(s, classifier, node, check, preset);
      s = { ...s, guards: [...(s.guards ?? []), g] };
      out.push(g);
    };
    if (choice === 'input' || choice === 'output') push(choice, null);
    else {
      push('input', choice);
      if (canOutput) push('output', choice);
    }
    onAdd(out);
  };

  const choices: { id: AddChoice; label: string; help: string; disabled?: boolean }[] = [
    { id: 'mira', label: `${GUARD_PRESETS.mira.label} (input + reply)`, help: GUARD_PRESETS.mira.help },
    { id: 'strict', label: `${GUARD_PRESETS.strict.label} (input + reply)`, help: GUARD_PRESETS.strict.help },
    { id: 'input', label: 'One input check', help: 'Checks user messages; add your own rules (none = block).' },
    { id: 'output', label: 'One reply check', help: 'Checks replies; add your own rules (none = regenerate).', disabled: !canOutput },
  ];

  return (
    <Modal
      title="Add guard"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!classifier || (choice === 'output' && !canOutput)} onClick={add}>
            Add
          </button>
        </>
      }
    >
      {classifiers.length === 0 ? (
        <Notice tone="warn">
          There are no classifiers yet. <Link to="/safety">Create one in Safety</Link> first.
        </Notice>
      ) : (
        <>
          <div className="grid-2">
            <Field label="Classifier">
              <select value={classifier} onChange={(e) => setClassifier(e.target.value)}>
                {classifiers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.id} ({c.provider})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Node it guards">
              <select value={node} onChange={(e) => setNode(e.target.value)}>
                <option value="">(the entry node{system.entry ? `: ${system.entry}` : ''})</option>
                {system.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                    {facing.has(n.id) ? '' : ' (not user-facing)'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="What to add" hint={!canOutput ? 'Reply checks need a node that talks to the user; a preset adds only its input check here.' : undefined}>
            <div className="choice-list">
              {choices.map((c) => (
                <label key={c.id} className={`choice${choice === c.id ? ' active' : ''}${c.disabled ? ' disabled' : ''}`}>
                  <input type="radio" name="guard-choice" checked={choice === c.id} disabled={c.disabled} onChange={() => setChoice(c.id)} />
                  <span>
                    <strong>{c.label}</strong>
                    <span className="muted small"> — {c.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </Field>
        </>
      )}
    </Modal>
  );
}
