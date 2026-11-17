import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { Badge, EmptyState, Field, Loading, NumberInput, PromptArea, TagsInput } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { useSettings } from '../../lib/refdata';
import { IDENT_RE, uniqueId } from '../../lib/util';
import type { Criterion, RubricDef } from '../../types';
import { CreateDefinitionModal, EditorFallback, EditorHeader, useDefinitionEditor } from './defs';
import { RUBRIC_KIND } from './kinds';
import { PromptPreviewBox } from './PromptPreview';
import { LEVEL_LABELS } from './simUi';

const INSTRUCTIONS_PLACEHOLDER = `e.g.
The assistant is a peer-support coach for healthcare workers, based on the R2MR (Road to Mental Readiness) programme.
A good conversation: finds out what is going on before advising, offers one or two concrete, evidence-based techniques fitted to the person, checks they are doable tonight, and points to professional help when warranted. Penalize generic lists, lecturing and invented facts.`;

const LEVEL_HELP = ['', 'mentioned or alluded to only', 'what it is, why it helps or how to do it', 'explained and fitted to this user, with a concrete step, script or prompt they can use'];

export function RubricEditor() {
  const { rubricId = '' } = useParams();
  const navigate = useNavigate();
  const settings = useSettings();
  const ed = useDefinitionEditor(RUBRIC_KIND, rubricId);
  const [duplicating, setDuplicating] = useState(false);

  if (ed.loaded.error != null)
    return <EditorFallback loaded={ed.loaded} label="rubric" id={rubricId} listPath="/simulations/rubrics" listLabel="Rubrics" />;
  const { draft, payload } = ed;
  if (!draft || !payload)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const set = <K extends keyof RubricDef>(key: K, value: RubricDef[K]) => ed.setDraft({ ...draft, [key]: value });
  const presets = Object.keys(settings.data?.models ?? {});
  const totalWeight = draft.criteria.reduce((a, c) => a + (c.weight || 0), 0);

  return (
    <div className="page page-wide">
      <EditorHeader
        kindLabel="Rubric"
        listPath="/simulations/rubrics"
        listLabel="Rubrics"
        ed={ed}
        onDuplicate={() => setDuplicating(true)}
        subtitle={
          <span>
            · {draft.criteria.length} criteria{draft.grade_expectations ? ' + expectations 0–3' : ''}
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
            <Field label="Description">
              <textarea rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <Field label="Notes" hint="Designer notes; never sent to a model.">
              <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">Instructions</h2>
            <p className="muted small">
              Context for the judge: what the assistant is for and what good looks like. The judge also gets the scenario (situation, facts,
              goal — which the assistant never saw), the criteria, the expectations and the transcript.
            </p>
            <PromptArea value={draft.instructions} onChange={(t) => set('instructions', t)} rows={10} placeholder={INSTRUCTIONS_PLACEHOLDER} />
          </section>

          <section className="panel">
            <h2 className="panel-title">
              Criteria <Badge tone="muted">{draft.criteria.length}</Badge>
            </h2>
            <p className="muted small">
              Each is scored within its range with a justification. <strong>Score</strong> = Σ weight × (score − min) / (max − min) ÷ Σ weight,
              as 0–100.
            </p>
            <CriteriaEditor value={draft.criteria} totalWeight={totalWeight} onChange={(c) => set('criteria', c)} />
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Expectations</h2>
            <label className="check">
              <input type="checkbox" checked={draft.grade_expectations} onChange={(e) => set('grade_expectations', e.target.checked)} />
              Also grade every scenario expectation 0–3
            </label>
            <ul className="tight-list small">
              {LEVEL_LABELS.map((l, i) => (
                <li key={l}>
                  <strong>
                    {i} {l}
                  </strong>
                  {LEVEL_HELP[i] && ` — ${LEVEL_HELP[i]}`}
                </li>
              ))}
            </ul>
            <div className="field-hint">Expectation score = mean level / 3 (0–1). Regex checks run regardless of the rubric.</div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Judge model</h2>
            <p className="muted small">
              Prefer a model from another family than the systems&apos; bots (a model tends to favour its own style). Runs can override it.
            </p>
            <ModelSpecEditor
              value={draft.model}
              onChange={(m) => set('model', m)}
              presets={presets}
              inheritNote={`Blank fields inherit from the default preset (${settings.data?.default_model ?? 'default'}). The judge runs at temperature 0.`}
            />
          </section>

          <RubricPreview rubric={payload} dirty={ed.dirty} />
        </div>
      </div>

      {duplicating && (
        <CreateDefinitionModal
          kind={RUBRIC_KIND}
          existing={[draft.id]}
          base={payload}
          onClose={() => setDuplicating(false)}
          onCreated={(r) => {
            setDuplicating(false);
            navigate(`/simulations/rubrics/${r.id}`);
          }}
        />
      )}
    </div>
  );
}

function CriteriaEditor({ value, totalWeight, onChange }: { value: Criterion[]; totalWeight: number; onChange: (v: Criterion[]) => void }) {
  const update = (i: number, patch: Partial<Criterion>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const keys = value.map((c) => c.key);
  return (
    <div className="fields-editor">
      {value.length === 0 && <EmptyState>No criteria — conversations get no score (expectations can still be graded).</EmptyState>}
      {value.map((c, i) => {
        const dup = keys.indexOf(c.key) !== i;
        const bad = !IDENT_RE.test(c.key);
        const range = c.max <= c.min;
        return (
          <div key={i} className="field-card">
            <div className="row gap-sm wrap">
              <input
                className={`mono field-name${dup || bad ? ' invalid' : ''}`}
                style={{ maxWidth: 170 }}
                value={c.key}
                placeholder="key"
                title="Identifier: letters, digits and _"
                onChange={(e) => update(i, { key: e.target.value })}
              />
              <input style={{ maxWidth: 240 }} value={c.title} placeholder="Title" onChange={(e) => update(i, { title: e.target.value })} />
              <label className="field-inline small">
                range
                <NumberInput className={`budget-input${range ? ' invalid' : ''}`} integer value={c.min} onChange={(n) => update(i, { min: n ?? 1 })} />
                –
                <NumberInput className={`budget-input${range ? ' invalid' : ''}`} integer value={c.max} onChange={(n) => update(i, { max: n ?? 5 })} />
              </label>
              <label className="field-inline small" title={totalWeight > 0 ? `${Math.round((100 * (c.weight || 0)) / totalWeight)}% of the score` : undefined}>
                weight
                <NumberInput className="budget-input" min={0} step={0.5} value={c.weight} onChange={(n) => update(i, { weight: n ?? 1 })} />
              </label>
              <span className="grow" />
              {dup && <span className="text-danger small">duplicate key</span>}
              {!dup && bad && <span className="text-danger small">{c.key ? 'invalid key' : 'key required'}</span>}
              {range && <span className="text-danger small">max must be above min</span>}
              <button type="button" className="btn btn-ghost btn-icon" title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="btn btn-ghost btn-icon" title="Move down" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="btn btn-ghost btn-icon danger" title="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
            <textarea
              rows={2}
              value={c.description}
              placeholder="What the judge looks for; what the low and high ends mean"
              onChange={(e) => update(i, { description: e.target.value })}
            />
          </div>
        );
      })}
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onChange([...value, { key: uniqueId('criterion', keys), title: '', description: '', min: 1, max: 5, weight: 1 }])}
      >
        + Add criterion
      </button>
    </div>
  );
}

function RubricPreview({ rubric, dirty }: { rubric: RubricDef; dirty: boolean }) {
  const scenarios = useLoad(api.scenarios.list, []);
  const [scenario, setScenario] = useState('');
  const list = scenarios.data ?? [];
  const chosen = scenario || list[0]?.id || '';
  return (
    <section className="panel">
      <h2 className="panel-title">Preview judge prompt</h2>
      <p className="muted small">The judge&apos;s prompt for this {dirty ? 'unsaved draft' : 'rubric'} on a scenario (the transcript is a placeholder).</p>
      <PromptPreviewBox
        show={['judge']}
        body={chosen ? { persona: {}, scenario: chosen, rubric } : null}
        controls={
          <Field label="Scenario">
            {list.length === 0 ? (
              <span className="muted small">{scenarios.loading ? 'Loading…' : 'No scenarios yet — create one first.'}</span>
            ) : (
              <select value={chosen} onChange={(e) => setScenario(e.target.value)}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id} ({s.expectations.length} expectations)
                  </option>
                ))}
              </select>
            )}
          </Field>
        }
      />
    </section>
  );
}
