import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { KeyTextEditor } from '../../components/KeyTextEditor';
import { Badge, EmptyState, ErrorBox, Field, FieldGroup, Loading, NumberInput, Spinner, TagsInput } from '../../components/ui';
import { useLoad, useLocalStorage } from '../../lib/hooks';
import { clipText, newSimConfig, pluralize } from '../../lib/util';
import type { Expectation, OpeningMode, PersonaSummary, ScenarioDef } from '../../types';
import { CreateDefinitionModal, EditorFallback, EditorHeader, useDefinitionEditor } from './defs';
import { SCENARIO_KIND } from './kinds';
import { PromptPreviewBox } from './PromptPreview';
import { toJsRegex } from './simUi';

const OPENING_HELP: Record<OpeningMode, string> = {
  exact: 'Sent verbatim as the first message — every run starts alike (no simulator call for it).',
  guide: 'The simulator writes its own first message, close to this one — openings vary between runs.',
};

export function ScenarioEditor() {
  const { scenarioId = '' } = useParams();
  const navigate = useNavigate();
  const ed = useDefinitionEditor(SCENARIO_KIND, scenarioId);
  const personas = useLoad(api.personas.list, []);
  // Any profile can seed a scenario's memory (editors see everyone's).
  const profiles = useLoad(() => api.profiles.list('all'), []);
  const [duplicating, setDuplicating] = useState(false);

  if (ed.loaded.error != null)
    return <EditorFallback loaded={ed.loaded} label="scenario" id={scenarioId} listPath="/simulations/scenarios" listLabel="Scenarios" />;
  const { draft, payload } = ed;
  if (!draft || !payload)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const set = <K extends keyof ScenarioDef>(key: K, value: ScenarioDef[K]) => ed.setDraft({ ...draft, [key]: value });
  const personaList = personas.data ?? [];
  const personaMissing = !!draft.persona && !!personas.data && !personaList.some((p) => p.id === draft.persona);
  const profileNames = (profiles.data ?? []).map((p) => p.name);
  const profileMissing = !!draft.profile.trim() && !!profiles.data && !profileNames.includes(draft.profile.trim());

  return (
    <div className="page page-wide">
      <EditorHeader
        kindLabel="Scenario"
        listPath="/simulations/scenarios"
        listLabel="Scenarios"
        ed={ed}
        onDuplicate={() => setDuplicating(true)}
        subtitle={
          <span>
            · {pluralize(draft.expectations.length, 'expectation')} · up to {pluralize(draft.max_turns, 'user turn')}
            {draft.persona && (
              <>
                {' '}
                · persona <Link to={`/simulations/personas/${draft.persona}`}>{draft.persona}</Link>
              </>
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
            <Field label="Description" hint="For lists; also the judge's fallback when the situation is empty.">
              <textarea rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <Field label="Notes" hint="Designer notes; never sent to a model.">
              <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">The user&apos;s side</h2>
            <div className="grid-2">
              <Field
                label="Default persona"
                hint={personaMissing ? <span className="text-danger">Persona not found</span> : 'Who plays the user unless a run picks personas.'}
              >
                <select value={draft.persona} onChange={(e) => set('persona', e.target.value)}>
                  <option value="">(none — runs must pick personas)</option>
                  {personaList.map((p: PersonaSummary) => (
                    <option key={p.id} value={p.id}>
                      {p.name || p.id} ({p.id})
                    </option>
                  ))}
                  {personaMissing && <option value={draft.persona}>{draft.persona} (missing)</option>}
                </select>
              </Field>
              <Field label="Max turns" hint="User messages at most (1–50); a run can override it.">
                <NumberInput integer min={1} max={50} value={draft.max_turns} onChange={(n) => set('max_turns', n ?? 8)} />
              </Field>
            </div>
            {personas.error != null && <ErrorBox error={personas.error} title="Could not list personas" />}

            <FieldGroup
              label="Opening"
              hint={draft.opening ? OPENING_HELP[draft.opening_mode] : 'Empty: the simulator opens the chat in its own words.'}
              actions={
                <div className="seg">
                  {(['exact', 'guide'] as OpeningMode[]).map((m) => (
                    <button key={m} type="button" className={draft.opening_mode === m ? 'active' : ''} onClick={() => set('opening_mode', m)} title={OPENING_HELP[m]}>
                      {m}
                    </button>
                  ))}
                </div>
              }
            >
              <textarea rows={2} value={draft.opening} placeholder="e.g. cant sleep after nights again. any tips" onChange={(e) => set('opening', e.target.value)} />
            </FieldGroup>
            <Field label="Situation" hint="What is going on, from the user's side (the assistant never sees this; the judge does).">
              <textarea rows={4} value={draft.situation} onChange={(e) => set('situation', e.target.value)} />
            </Field>
            <Field label="Goal" hint="What the user wants; when they would be satisfied and end the chat.">
              <textarea rows={2} value={draft.goal} onChange={(e) => set('goal', e.target.value)} />
            </Field>
            <Field
              label="Memory profile"
              hint={
                profileMissing ? (
                  <span className="text-warn">No profile with this name — runs start with an empty memory (a warning is recorded).</span>
                ) : (
                  <>
                    Name of a real profile (<Link to="/memory">Memory</Link>) whose notes the simulated user starts with — copied into a throwaway
                    profile per conversation (run profile mode <code>fresh</code>). Empty = no prior memory.
                  </>
                )
              }
            >
              <input list="sim-profile-names" value={draft.profile} placeholder="(none)" onChange={(e) => set('profile', e.target.value)} />
              <datalist id="sim-profile-names">
                {(profiles.data ?? []).map((p) => (
                  <option key={p.id} value={p.name}>
                    {p.memories != null ? `${p.memories} notes` : ''}
                  </option>
                ))}
              </datalist>
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">
              Facts <Badge tone="muted">{Object.keys(draft.facts).length}</Badge>
            </h2>
            <p className="muted small">Details the user knows and reveals only when asked (label → answer). The judge sees them too.</p>
            <KeyTextEditor
              value={draft.facts}
              onChange={(f) => set('facts', f)}
              keyPlaceholder="label, e.g. shift pattern"
              textPlaceholder="answer, e.g. 4 nights on, 3 off; 19:00–07:30"
              addLabel="Add fact"
              emptyText="No facts."
              rows={2}
            />
          </section>

          <ExpectationsPanel scenarioId={draft.id} value={draft.expectations} onChange={(x) => set('expectations', x)} />
        </div>

        <div className="stack">
          <ScenarioPreview scenario={payload} personas={personaList} dirty={ed.dirty} />
          {ed.canSave && <QuickTest scenario={draft} dirty={ed.dirty} personaMissing={!draft.persona || personaMissing} />}
        </div>
      </div>

      {duplicating && (
        <CreateDefinitionModal
          kind={SCENARIO_KIND}
          existing={[draft.id]}
          base={payload}
          onClose={() => setDuplicating(false)}
          onCreated={(s) => {
            setDuplicating(false);
            navigate(`/simulations/scenarios/${s.id}`);
          }}
        />
      )}
    </div>
  );
}

// -------------------------------------------------------------- expectations

function ExpectationsPanel({ scenarioId, value, onChange }: { scenarioId: string; value: Expectation[]; onChange: (v: Expectation[]) => void }) {
  const [sample, setSample] = useLocalStorage(`sbf.sim.patternSample.${scenarioId}`, '');
  const update = (i: number, patch: Partial<Expectation>) => onChange(value.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  const names = value.map((e) => e.name.trim().toLowerCase());
  const withPattern = value.filter((e) => e.pattern).length;

  return (
    <section className="panel">
      <h2 className="panel-title">
        Expectations <Badge tone="muted">{value.length}</Badge>
        {withPattern > 0 && <Badge tone="muted">{withPattern} regex</Badge>}
      </h2>
      <p className="muted small">
        What a good conversation should cover. The judge grades each one 0–3 (absent / named / explained / applied to this user) from its
        name and description; the optional <strong>pattern</strong> is a deterministic check — a Python regex searched in everything the
        assistant said (✓/✗, no model).
      </p>
      <Field
        label="Test patterns against sample text"
        hint="Paste something the assistant might say; each pattern shows whether it matches. Tested with JavaScript regex (leading (?i) supported) — the server uses Python re and validates on save."
      >
        <textarea rows={3} value={sample} placeholder="e.g. Try box breathing: in for 4, hold for 4, out for 4…" onChange={(e) => setSample(e.target.value)} />
      </Field>
      <div className="fields-editor">
        {value.length === 0 && <EmptyState>No expectations. Without them the judge only scores the rubric&apos;s criteria.</EmptyState>}
        {value.map((e, i) => {
          const dup = !!e.name.trim() && names.indexOf(e.name.trim().toLowerCase()) !== i;
          const test = e.pattern ? toJsRegex(e.pattern) : null;
          const match = test?.re && sample ? test.re.exec(sample) : null;
          return (
            <div key={i} className="field-card">
              <div className="row gap-sm">
                <input
                  className={`field-name${dup || !e.name.trim() ? ' invalid' : ''}`}
                  value={e.name}
                  placeholder="name, e.g. tactical breathing"
                  onChange={(ev) => update(i, { name: ev.target.value })}
                />
                <span className="grow" />
                {dup && <span className="text-danger small">duplicate name</span>}
                {!e.name.trim() && <span className="text-danger small">name required</span>}
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
                value={e.description}
                placeholder="For the judge: what it is and what counts, e.g. slow paced breathing (4-count in/hold/out) to calm the body in the moment"
                onChange={(ev) => update(i, { description: ev.target.value })}
              />
              <div className="row gap-sm">
                <input
                  className={`mono${test?.error && !test.error.startsWith('Verbose') ? ' invalid' : ''}`}
                  value={e.pattern}
                  placeholder="regex (optional), e.g. (?i)breath(e|ing)"
                  spellCheck={false}
                  onChange={(ev) => update(i, { pattern: ev.target.value })}
                />
                {e.pattern && test?.re && sample && (
                  <Badge tone={match ? 'ok' : 'danger'} title={match ? `Matched: ${match[0]}` : 'No match in the sample text'}>
                    {match ? `✓ “${clipText(match[0], 30)}”` : '✗ no match'}
                  </Badge>
                )}
              </div>
              {test?.error && <span className={test.error.startsWith('Verbose') ? 'field-hint' : 'field-error'}>{test.error}</span>}
            </div>
          );
        })}
        <button type="button" className="btn btn-sm" onClick={() => onChange([...value, { name: '', description: '', pattern: '' }])}>
          + Add expectation
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------- preview

function ScenarioPreview({ scenario, personas, dirty }: { scenario: ScenarioDef; personas: PersonaSummary[]; dirty: boolean }) {
  const rubrics = useLoad(api.rubrics.list, []);
  const [persona, setPersona] = useState('');
  const [rubric, setRubric] = useState('');
  const chosenPersona = persona || (personas.some((p) => p.id === scenario.persona) ? scenario.persona : '');
  return (
    <section className="panel">
      <h2 className="panel-title">Preview prompts</h2>
      <p className="muted small">
        What the simulated user is told{rubric ? ', and what the judge is asked' : ''} — for this {dirty ? 'unsaved draft' : 'scenario'}. No LLM call.
      </p>
      <PromptPreviewBox
        body={{ persona: chosenPersona || {}, scenario, rubric: rubric || null }}
        controls={
          <div className="grid-2">
            <Field label="Persona">
              <select value={chosenPersona} onChange={(e) => setPersona(e.target.value)}>
                <option value="">(a blank persona)</option>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name || p.id}
                    {p.id === scenario.persona ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Rubric (judge prompt)">
              <select value={rubric} onChange={(e) => setRubric(e.target.value)}>
                <option value="">(none)</option>
                {(rubrics.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
      />
    </section>
  );
}

// ---------------------------------------------------------------- quick test

/** Starts a one-conversation run of this (saved) scenario against a system and opens it. */
function QuickTest({ scenario, dirty, personaMissing }: { scenario: ScenarioDef; dirty: boolean; personaMissing: boolean }) {
  const navigate = useNavigate();
  const systems = useLoad(api.systems.list, []);
  const rubrics = useLoad(api.rubrics.list, []);
  const [system, setSystem] = useLocalStorage('sbf.sim.quickSystem', '');
  const [rubric, setRubric] = useLocalStorage('sbf.sim.quickRubric', '');
  const [maxTurns, setMaxTurns] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const sysList = systems.data ?? [];
  const chosen = sysList.some((s) => s.id === system) ? system : sysList[0]?.id ?? '';
  const rubricOk = !rubric || (rubrics.data ?? []).some((r) => r.id === rubric);
  const turns = maxTurns ?? scenario.max_turns;

  const config = useMemo(
    () => ({
      ...newSimConfig(),
      name: `Quick test: ${scenario.id} on ${chosen}`,
      systems: [chosen],
      scenarios: [scenario.id],
      concurrency: 1,
      max_turns: maxTurns,
      rubric: rubricOk ? rubric : '',
    }),
    [scenario.id, chosen, maxTurns, rubric, rubricOk],
  );

  const start = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const run = await api.simulations.start(config);
      navigate(`/simulations/runs/${run.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const blocked = dirty ? 'Save the scenario first — runs use saved definitions.' : personaMissing ? 'Set a default persona (that exists) first.' : null;

  return (
    <section className="panel">
      <h2 className="panel-title">Quick test</h2>
      <p className="muted small">
        Run this scenario once against a system and watch it: one conversation with the default persona. For comparisons use{' '}
        <Link to="/simulations/new" state={{ config: { ...newSimConfig(), scenarios: [scenario.id] } }}>
          a full run
        </Link>
        .
      </p>
      {systems.error != null && <ErrorBox error={systems.error} title="Could not list systems" />}
      <div className="grid-3">
        <Field label="System">
          <select value={chosen} onChange={(e) => setSystem(e.target.value)}>
            {sysList.length === 0 && <option value="">{systems.loading ? 'Loading…' : 'No systems'}</option>}
            {sysList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rubric">
          <select value={rubricOk ? rubric : ''} onChange={(e) => setRubric(e.target.value)}>
            <option value="">(no judge)</option>
            {(rubrics.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.id}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Max turns">
          <NumberInput integer min={1} max={50} value={maxTurns} placeholder={`${scenario.max_turns} (scenario)`} onChange={setMaxTurns} />
        </Field>
      </div>
      <div className="row gap-sm wrap">
        <button className="btn btn-primary" disabled={!chosen || busy || !!blocked} onClick={() => void start()} title={blocked ?? undefined}>
          {busy ? (
            <>
              <Spinner /> Starting…
            </>
          ) : (
            `Run once against ${chosen || '…'}`
          )}
        </button>
        <span className="small text-warn">
          Real LLM calls: up to {turns} simulator + {turns} system turn(s){rubric && rubricOk ? ' + 1 judge call' : ''}.
        </span>
      </div>
      {blocked && <div className="field-hint">{blocked}</div>}
      {error != null && <ErrorBox error={error} title="Not started" />}
    </section>
  );
}
