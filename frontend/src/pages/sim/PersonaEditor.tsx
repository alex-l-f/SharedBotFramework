import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { Field, Loading, PromptArea, TagsInput } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { useSettings } from '../../lib/refdata';
import type { PersonaDef } from '../../types';
import { CreateDefinitionModal, EditorFallback, EditorHeader, useDefinitionEditor } from './defs';
import { PERSONA_KIND } from './kinds';
import { PromptPreviewBox } from './PromptPreview';

const PROFILE_PLACEHOLDER = `e.g.
Dana, 34, night-shift nurse on a busy surgical ward for nine years. Practical, a bit cynical about "wellness" talk, warm once she trusts you.
Types on her phone during breaks: short messages, lowercase, few commas, the odd typo. Rarely more than two sentences.
Doesn't volunteer feelings at first; answers questions honestly. Gets impatient with long lists — wants one thing she can try tonight.`;

export function PersonaEditor() {
  const { personaId = '' } = useParams();
  const navigate = useNavigate();
  const settings = useSettings();
  const ed = useDefinitionEditor(PERSONA_KIND, personaId);
  const [duplicating, setDuplicating] = useState(false);

  const fallback = <EditorFallback loaded={ed.loaded} label="persona" id={personaId} listPath="/simulations/personas" listLabel="Personas" />;
  if (ed.loaded.error != null) return fallback;
  const { draft, payload } = ed;
  if (!draft || !payload)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const set = <K extends keyof PersonaDef>(key: K, value: PersonaDef[K]) => ed.setDraft({ ...draft, [key]: value });
  const presets = Object.keys(settings.data?.models ?? {});
  const usedBy = ed.summary?.used_by ?? [];

  return (
    <div className="page page-wide">
      <EditorHeader
        kindLabel="Persona"
        listPath="/simulations/personas"
        listLabel="Personas"
        ed={ed}
        onDuplicate={() => setDuplicating(true)}
        subtitle={
          <span>
            ·{' '}
            {usedBy.length ? (
              <>
                default persona of{' '}
                {usedBy.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ', '}
                    <Link to={`/simulations/scenarios/${s}`}>{s}</Link>
                  </span>
                ))}
              </>
            ) : (
              <span className="muted">not the default persona of any scenario</span>
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
            <Field label="Notes" hint="Designer notes; never sent to a model.">
              <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">Profile</h2>
            <p className="muted small">
              Who they are and how they type: background, personality, tone, message length, quirks. The simulator model gets this under
              &quot;WHO YOU ARE&quot;; the scenario adds the situation, facts and goal.
            </p>
            <PromptArea value={draft.profile} onChange={(t) => set('profile', t)} rows={16} placeholder={PROFILE_PLACEHOLDER} />
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Model</h2>
            <p className="muted small">
              The model playing this persona (a run can override it). Thinking is turned off for it unless you set a reasoning effort here or
              in the run&apos;s override — people typing in a chat don&apos;t deliberate.
            </p>
            <ModelSpecEditor
              value={draft.model}
              onChange={(m) => set('model', m)}
              presets={presets}
              inheritNote={`Blank fields inherit from the default preset (${settings.data?.default_model ?? 'default'}).`}
            />
          </section>

          <PersonaPreview persona={payload} dirty={ed.dirty} />
        </div>
      </div>

      {duplicating && (
        <CreateDefinitionModal
          kind={PERSONA_KIND}
          existing={[draft.id]}
          base={payload}
          onClose={() => setDuplicating(false)}
          onCreated={(p) => {
            setDuplicating(false);
            navigate(`/simulations/personas/${p.id}`);
          }}
        />
      )}
    </div>
  );
}

function PersonaPreview({ persona, dirty }: { persona: PersonaDef; dirty: boolean }) {
  const scenarios = useLoad(api.scenarios.list, []);
  const [scenario, setScenario] = useState('');
  const list = scenarios.data ?? [];
  const chosen = scenario || list.find((s) => s.persona === persona.id)?.id || list[0]?.id || '';
  return (
    <section className="panel">
      <h2 className="panel-title">Preview prompt</h2>
      <p className="muted small">The system prompt the simulated user gets: this persona{dirty ? ' (unsaved draft)' : ''} in a scenario.</p>
      <PromptPreviewBox
        show={['simulator']}
        body={chosen ? { persona, scenario: chosen } : null}
        controls={
          <Field label="Scenario">
            {list.length === 0 ? (
              <span className="muted small">{scenarios.loading ? 'Loading…' : 'No scenarios yet — create one first.'}</span>
            ) : (
              <select value={chosen} onChange={(e) => setScenario(e.target.value)}>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                    {s.persona === persona.id ? ' (default persona)' : ''}
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
