// /safety/:classifierId — one classifier: the provider's settings, a Try it
// panel, and where its service stands.

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { Badge, Field, FieldGroup, Loading, NumberInput, PromptArea, TagsInput } from '../../components/ui';
import { invalidate, useSafetyMeta, useSettings } from '../../lib/refdata';
import { isEqual } from '../../lib/util';
import { SAFETY_PROVIDERS, type ClassifierDef, type KeywordRule, type SafetyMeta, type SafetyProvider } from '../../types';
import { CreateDefinitionModal, EditorFallback, EditorHeader, useDefinitionEditor } from '../sim/defs';
import { CLASSIFIER_KIND, HAS_STATUS, PROVIDER_HELP, ProviderBadge, StatusDot, TryItPanel } from './safetyUi';

const SECTION = { to: '/safety', label: 'Safety' };

export function ClassifierEditor() {
  const { classifierId = '' } = useParams();
  const navigate = useNavigate();
  const meta = useSafetyMeta();
  const settings = useSettings();
  const ed = useDefinitionEditor(CLASSIFIER_KIND, classifierId);
  const [duplicating, setDuplicating] = useState(false);
  const [statusTick, setStatusTick] = useState(0);

  // A save changes what guards and lists see; the guardrails server picks up a saved config by itself.
  const savedVersion = ed.saved?.version;
  useEffect(() => {
    if (!savedVersion) return;
    invalidate('classifiers');
    setStatusTick((t) => t + 1);
  }, [savedVersion]);

  const fallback = <EditorFallback loaded={ed.loaded} label="classifier" id={classifierId} listPath="/safety" listLabel="Safety" />;
  if (ed.loaded.error != null) return fallback;
  const { draft, payload } = ed;
  if (!draft || !payload)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const set = <K extends keyof ClassifierDef>(key: K, value: ClassifierDef[K]) => ed.setDraft({ ...draft, [key]: value });
  const presets = Object.keys(settings.data?.models ?? {});
  const usedBy = ed.summary?.used_by ?? [];
  const p = draft.provider;
  const defaults = meta.data?.providers[p];
  const railsDirty = p === 'nemo_guardrails' && ed.dirty;

  return (
    <div className="page page-wide">
      <EditorHeader
        kindLabel="Safety classifier"
        listPath="/safety"
        listLabel="Classifiers"
        section={SECTION}
        ed={ed}
        onDuplicate={() => setDuplicating(true)}
        onDelete={() =>
          void ed.remove(
            usedBy.length
              ? `Classifier "${draft.id}" is used by ${usedBy.map((u) => u.system).join(', ')}; deleting it will fail until those guards are removed. Try anyway?`
              : undefined,
          )
        }
        subtitle={
          <span>
            ·{' '}
            {usedBy.length ? (
              <>
                guards in{' '}
                {usedBy.map((u, i) => (
                  <span key={u.system}>
                    {i > 0 && ', '}
                    <Link to={`/systems/${u.system}`} title={u.guards.join(', ')}>
                      {u.system}
                    </Link>
                  </span>
                ))}
              </>
            ) : (
              <span className="muted">not used by any system yet</span>
            )}
          </span>
        }
      />

      <div className="editor-columns">
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">General</h2>
            <div className="grid-2">
              <Field label="Name">
                <input value={draft.name} placeholder={draft.id} onChange={(e) => set('name', e.target.value)} />
              </Field>
              <Field label="Tags">
                <TagsInput value={draft.tags} onChange={(t) => set('tags', t)} />
              </Field>
            </div>
            <Field label="Description" hint="One line, for lists.">
              <input value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <Field label="Notes" hint="Designer notes.">
              <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">
              How it checks <ProviderBadge provider={p} />
            </h2>
            <Field label="Provider" hint={PROVIDER_HELP[p]}>
              <select value={p} onChange={(e) => set('provider', e.target.value as SafetyProvider)}>
                {SAFETY_PROVIDERS.map((x) => (
                  <option key={x} value={x}>
                    {meta.data?.providers[x]?.label ?? x}
                  </option>
                ))}
              </select>
            </Field>
            {defaults?.setup && (
              <div className="setup-hint">
                <span className="small muted">To start the service:</span>
                <code className="mono small">{defaults.setup}</code>
              </div>
            )}
            <ProviderFields draft={draft} set={set} meta={meta.data} presets={presets} defaultModel={settings.data?.default_model} />
          </section>

          <section className="panel">
            <h2 className="panel-title">When the check itself fails</h2>
            <div className="grid-2">
              <Field label="If the service is down or times out" hint="Allowing keeps the chat working; blocking is the cautious choice.">
                <select value={draft.on_error} onChange={(e) => set('on_error', e.target.value as ClassifierDef['on_error'])}>
                  <option value="allow">Treat the message as safe</option>
                  <option value="block">Treat the message as unsafe</option>
                </select>
              </Field>
              <Field label="Timeout (seconds)">
                <NumberInput value={draft.timeout} min={1} max={120} onChange={(v) => set('timeout', v ?? 15)} />
              </Field>
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Try it</h2>
            <p className="muted small">
              Runs {ed.dirty ? 'this draft (unsaved changes included)' : 'this classifier'} on a message. Model-based checks make a real
              call — fractions of a cent.
            </p>
            <TryItPanel
              draft={payload}
              note={railsDirty ? 'NeMo Guardrails runs the saved rails config: save to try your edits.' : undefined}
            />
          </section>

          {HAS_STATUS.includes(p) && (
            <section className="panel">
              <h2 className="panel-title">
                Service
                <span className="grow" />
                <button className="btn btn-sm" onClick={() => setStatusTick(statusTick + 1)}>
                  Recheck
                </button>
              </h2>
              <div className="small">
                <StatusDot id={draft.id} tick={statusTick} showText />
              </div>
              <p className="muted small">
                {p === 'nemo_guardrails'
                  ? 'Saving writes the rails config to the workspace; the guardrails server picks it up within a few seconds.'
                  : 'Checks the saved URL.'}
                {ed.dirty && ' (Unsaved changes are not checked.)'}
              </p>
            </section>
          )}
        </div>
      </div>

      {duplicating && (
        <CreateDefinitionModal
          kind={CLASSIFIER_KIND}
          existing={[draft.id]}
          base={payload}
          idHint="Guards refer to it; cannot be changed later."
          onClose={() => setDuplicating(false)}
          onCreated={(c) => {
            setDuplicating(false);
            invalidate('classifiers');
            navigate(`/safety/${c.id}`);
          }}
        />
      )}
    </div>
  );
}

/** "Reset to default" next to a field, shown when the value differs from the default. */
function ResetButton({ show, onClick, label = 'Reset to default' }: { show: boolean; onClick: () => void; label?: string }) {
  if (!show) return null;
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={onClick}>
      {label}
    </button>
  );
}

function ProviderFields({
  draft,
  set,
  meta,
  presets,
  defaultModel,
}: {
  draft: ClassifierDef;
  set: <K extends keyof ClassifierDef>(key: K, value: ClassifierDef[K]) => void;
  meta: SafetyMeta | undefined;
  presets: string[];
  defaultModel?: string;
}) {
  const p = draft.provider;
  const d = meta?.providers[p];
  const out: ReactNode[] = [];

  if (p === 'safer' || p === 'nemo_guardrails') {
    out.push(
      <Field key="url" label="Service URL" hint={`Blank = ${d?.url ?? 'the default'}.`}>
        <input className="mono" value={draft.url} placeholder={d?.url} onChange={(e) => set('url', e.target.value.trim())} />
      </Field>,
    );
  }

  if (p === 'safer') {
    out.push(
      <Field
        key="threshold"
        label={`Threshold: ${draft.threshold.toFixed(2)}`}
        hint="A category applies when its score is above this. Lower catches more (and flags more harmless messages); 0.5 is MIRA's setting."
      >
        <div className="row gap-sm">
          <input type="range" min={0.05} max={0.95} step={0.05} value={draft.threshold} onChange={(e) => set('threshold', Number(e.target.value))} />
          <NumberInput value={draft.threshold} min={0} max={1} step={0.05} onChange={(v) => set('threshold', v ?? 0.5)} />
        </div>
      </Field>,
    );
  }

  if (p === 'qwen3guard' || p === 'nemoguard' || p === 'llm') {
    const defaultSpec = d?.model ?? {};
    out.push(
      <FieldGroup
        key="model"
        label="Model"
        actions={<ResetButton show={!isEqual(draft.model, defaultSpec)} onClick={() => set('model', { ...defaultSpec })} label="Use the default model" />}
        hint={
          p === 'llm'
            ? 'Any model works; a fast, inexpensive one keeps chats quick (each message waits for this check).'
            : 'The model server must speak the OpenAI API.'
        }
      >
        <ModelSpecEditor
          value={draft.model}
          onChange={(m) => set('model', m)}
          presets={presets}
          inheritNote={p === 'llm' ? `Blank fields inherit from the default preset (${defaultModel ?? 'default'}).` : ''}
        />
      </FieldGroup>,
    );
  }

  if (p === 'qwen3guard') {
    out.push(
      <Field key="controversial" label="Controversial messages">
        <label className="check">
          <input type="checkbox" checked={draft.controversial_unsafe} onChange={(e) => set('controversial_unsafe', e.target.checked)} />
          Count Qwen3Guard&apos;s “controversial” label as unsafe
        </label>
      </Field>,
    );
  }

  if (p === 'llm') {
    const defCats = d?.categories ?? [];
    out.push(
      <FieldGroup
        key="categories"
        label="Categories"
        actions={<ResetButton show={!isEqual(draft.categories, defCats)} onClick={() => set('categories', [...defCats])} />}
        hint="What the judge looks for, and the names it reports (guard rules match these). Blank = the defaults."
      >
        <TagsInput value={draft.categories} onChange={(v) => set('categories', v)} placeholder="Add a category…" />
      </FieldGroup>,
    );
  }

  if (p === 'nemoguard' || p === 'llm') {
    out.push(
      <FieldGroup
        key="prompt"
        label="Prompt"
        actions={
          <>
            <ResetButton show={!!draft.prompt} onClick={() => set('prompt', '')} label="Use the default" />
            {!draft.prompt && d?.prompt && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => set('prompt', d.prompt ?? '')}>
                Edit the default
              </button>
            )}
          </>
        }
        hint={
          p === 'llm'
            ? 'Blank = the default (shown greyed). Placeholders: {subject}, {categories}, {conversation}; double the braces of literal JSON ({{ }}).'
            : 'Blank = the default (shown greyed). Placeholders: {categories}, {user}, {response_line}.'
        }
      >
        <PromptArea value={draft.prompt} onChange={(v) => set('prompt', v)} rows={10} placeholder={d?.prompt} />
      </FieldGroup>,
    );
  }

  if (p === 'nemo_guardrails') {
    out.push(
      <p key="rails-help" className="muted small">
        Two YAML files a NeMo Guardrails server reads: the config (which model checks, which rails run) and the prompts (the policy the
        model checks against — edit the bullet lists to change what is allowed). Saved to <code>workspace/guardrails/{draft.id}/</code>.
        Blank = the defaults.
      </p>,
      <YamlField
        key="rails_config"
        label="config.yml"
        value={draft.rails_config}
        fallback={d?.rails_config ?? ''}
        onChange={(v) => set('rails_config', v)}
        rows={14}
      />,
      <YamlField
        key="rails_prompts"
        label="prompts.yml"
        value={draft.rails_prompts}
        fallback={d?.rails_prompts ?? ''}
        onChange={(v) => set('rails_prompts', v)}
        rows={22}
      />,
    );
  }

  if (p === 'keywords') {
    out.push(<KeywordsTable key="keywords" rules={draft.keywords} onChange={(k) => set('keywords', k)} />);
  } else if (draft.keywords.length > 0) {
    out.push(
      <p key="kw-note" className="muted small">
        This classifier also has {draft.keywords.length} keyword rule(s) from an earlier provider; they are only used by the Keyword rules
        provider.
      </p>,
    );
  }

  const reported = d?.categories ?? [];
  if (p !== 'llm' && p !== 'keywords' && reported.length) {
    out.push(
      <FieldGroup key="cats" label="Categories it reports" hint="Guard rules can react to these (case-insensitive, partial match).">
        <div className="badges">
          {reported.map((c) => (
            <Badge key={c} tone="neutral">
              {c}
            </Badge>
          ))}
        </div>
      </FieldGroup>,
    );
  }
  return <>{out}</>;
}

function YamlField({
  label,
  value,
  fallback,
  onChange,
  rows,
}: {
  label: string;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
  rows: number;
}) {
  const custom = value.trim() !== '' && value !== fallback;
  return (
    <FieldGroup
      label={
        <>
          {label} {custom ? <Badge tone="warn">customized</Badge> : <Badge tone="muted">default</Badge>}
        </>
      }
      actions={<ResetButton show={value !== fallback} onClick={() => onChange(fallback)} />}
    >
      <PromptArea value={value} onChange={onChange} rows={rows} placeholder={fallback} />
    </FieldGroup>
  );
}

function regexProblem(pattern: string): string | null {
  if (!pattern.trim()) return 'Required';
  try {
    new RegExp(pattern, 'i');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : 'Invalid pattern';
  }
}

/** Category + regular expression rows. */
function KeywordsTable({ rules, onChange }: { rules: KeywordRule[]; onChange: (k: KeywordRule[]) => void }) {
  const setRow = (i: number, patch: Partial<KeywordRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const categories = [...new Set(rules.map((r) => r.category).filter(Boolean))];
  return (
    <FieldGroup
      label="Keyword rules"
      hint={
        <>
          A message is unsafe when any pattern matches (case-insensitive) and reports that row&apos;s category. Patterns are regular
          expressions: <code>\b</code> marks a word boundary, <code>|</code> separates alternatives, <code>\w*</code> matches any word
          ending.
        </>
      }
    >
      <table className="table table-compact keywords-table">
        <thead>
          <tr>
            <th style={{ width: '32%' }}>Category</th>
            <th>Pattern</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => {
            const problem = regexProblem(r.pattern);
            return (
              <tr key={i}>
                <td>
                  <input value={r.category} list="keyword-categories" placeholder="e.g. Self-harm" onChange={(e) => setRow(i, { category: e.target.value })} />
                </td>
                <td>
                  <input
                    className={`mono${problem && r.pattern ? ' invalid' : ''}`}
                    value={r.pattern}
                    placeholder="\b(word|other words)\b"
                    title={problem ?? undefined}
                    onChange={(e) => setRow(i, { pattern: e.target.value })}
                  />
                  {problem && r.pattern && <div className="field-error">{problem}</div>}
                </td>
                <td className="num nowrap">
                  <button type="button" className="btn btn-ghost btn-icon danger" title="Remove" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <datalist id="keyword-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <div>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...rules, { category: categories[0] ?? '', pattern: '' }])}>
          + Add rule
        </button>
      </div>
    </FieldGroup>
  );
}
