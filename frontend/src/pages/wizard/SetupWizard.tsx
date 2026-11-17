// /setup — the setup wizard: a few plain questions become new agents, an
// optional safety classifier and a system wiring them together. Nothing is
// saved until Create; the answers survive a refresh (sessionStorage). The
// system and agent editors stay the place for everything else.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge, ErrorBox, Field, Loading, MessageList, Notice, PageHeader, Spinner, StringListEditor } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { invalidate, useAgents, useClassifiers, useMemorySchemas, useRetrievers, useSafetyMeta, useSettings } from '../../lib/refdata';
import { isEqual, SLUG_RE, uniqueId } from '../../lib/util';
import type { AgentSummary, HelperKind, SafetyMeta, SafetyProvider, WizardAnswers, WizardDraft, WizardHelper, WizardNewAgent } from '../../types';
import { PROVIDER_HELP, ProviderBadge, prefilledClassifier } from '../safety/safetyUi';
import { DEFAULT_BLOCK_MESSAGE, DEFAULT_CRISIS_MESSAGE, DEFAULT_SAFE_REPLY } from '../systems/systemOps';

const STORAGE_KEY = 'sbf.setupWizard';

type SafetyMode = 'none' | 'existing' | 'new';
type SimpleProvider = 'safer' | 'keywords' | 'llm';

interface WizardState {
  step: number;
  answers: WizardAnswers;
  /** The id was typed (not derived from the name). */
  idTouched: boolean;
  mainMode: 'new' | 'existing';
  safetyMode: SafetyMode;
  newProvider: SimpleProvider;
  /** After Create: what was created. */
  created: WizardDraft | null;
}

const blankAgent = (): WizardNewAgent => ({ name: '', role: '', instructions: '', model_preset: '' });

function initialState(): WizardState {
  return {
    step: 0,
    answers: {
      id: '',
      name: '',
      description: '',
      main: { existing: '', new: blankAgent() },
      helpers: [],
      knowledge: { retriever: '', mode: 'none' },
      memory: { enabled: false, schema_id: null, namespace: null },
      safety: {
        classifier: '',
        new_classifier: null,
        input_policy: 'inform',
        output_policy: 'regenerate',
        crisis_message: DEFAULT_CRISIS_MESSAGE,
        block_message: DEFAULT_BLOCK_MESSAGE,
        safe_reply: DEFAULT_SAFE_REPLY,
      },
      ui: { title: '', welcome: '', starters: [], require_profile: false, show_viewer: true },
    },
    idTouched: false,
    mainMode: 'new',
    safetyMode: 'none',
    newProvider: 'safer',
    created: null,
  };
}

function loadState(): WizardState {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return { ...initialState(), ...(JSON.parse(raw) as Partial<WizardState>) };
  } catch {
    /* storage unavailable or stale */
  }
  return initialState();
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const HELPERS: Record<HelperKind, { label: string; help: string; link: string }> = {
  researcher: {
    label: 'Researcher',
    help: 'Looks things up in your material when the main agent asks, and reports back a summary.',
    link: 'delegate',
  },
  specialist: {
    label: 'Specialist',
    help: 'Takes over the conversation when it moves into their area (a handoff).',
    link: 'handoff',
  },
  memory: {
    label: 'Memory keeper',
    help: 'After every turn, notes what is worth remembering for next time. Needs memory turned on.',
    link: 'observe',
  },
  delegate: {
    label: 'Helper agent',
    help: 'Does one job when the main agent asks (an agent used as a tool) and returns the result.',
    link: 'delegate',
  },
};

const STEPS = ['Name & purpose', 'Main agent', 'Helpers', 'Knowledge', 'Memory', 'Safety', 'Chat page', 'Review'];

/** The answers to send: the safety choice resolved into a classifier id or a new classifier. */
function toAnswers(s: WizardState, meta: SafetyMeta | undefined, classifierIds: string[]): WizardAnswers {
  const a = s.answers;
  const safety = { ...a.safety, classifier: '', new_classifier: null as WizardAnswers['safety']['new_classifier'] };
  if (s.safetyMode === 'existing') safety.classifier = a.safety.classifier;
  if (s.safetyMode === 'new') {
    const id = uniqueId(`${a.id || 'system'}-safety`, classifierIds);
    safety.new_classifier = prefilledClassifier(id, `${a.name || a.id} safety`, s.newProvider, meta);
  }
  return {
    ...a,
    main: s.mainMode === 'existing' ? { existing: a.main.existing, new: blankAgent() } : { existing: '', new: a.main.new },
    memory: a.memory.enabled ? a.memory : { enabled: false, schema_id: null, namespace: null },
    safety,
  };
}

export function SetupWizard() {
  const canEdit = useAuth().can('editor');
  const [state, setState] = useState<WizardState>(loadState);
  const agents = useAgents();
  const settings = useSettings();
  const retrievers = useRetrievers();
  const schemas = useMemorySchemas();
  const classifiers = useClassifiers();
  const meta = useSafetyMeta();
  const systems = useLoad(api.systems.list, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage unavailable */
    }
  }, [state]);

  if (!canEdit)
    return (
      <div className="page">
        <PageHeader title="Set up a new system" />
        <Notice tone="warn">Setting up a system needs the editor role.</Notice>
        <Link to="/systems">← Systems</Link>
      </div>
    );

  const { step, answers: a } = state;
  const patch = (p: Partial<WizardState>) => setState((s) => ({ ...s, ...p }));
  const setA = (p: Partial<WizardAnswers>) => setState((s) => ({ ...s, answers: { ...s.answers, ...p } }));
  const go = (n: number) => patch({ step: Math.max(0, Math.min(STEPS.length - 1, n)) });
  const presets = Object.keys(settings.data?.models ?? {});
  const agentList = agents.data ?? [];
  const systemIds = (systems.data ?? []).map((s) => s.id);
  const classifierIds = (classifiers.data ?? []).map((c) => c.id);

  const idProblem = !a.id
    ? 'Give the system a name (or an id)'
    : !SLUG_RE.test(a.id)
      ? 'Lowercase letters, digits, - and _ (must start with a letter or digit)'
      : systemIds.includes(a.id)
        ? 'A system with this id exists'
        : null;
  const mainProblem = state.mainMode === 'existing' && !a.main.existing ? 'Pick an agent to reuse' : null;
  const stepProblem = step === 0 ? idProblem : step === 1 ? mainProblem : null;

  if (state.created)
    return (
      <Created
        draft={state.created}
        onStartOver={() => {
          setState(initialState());
        }}
      />
    );

  return (
    <div className="page wizard-page">
      <PageHeader
        title="Set up a new system"
        subtitle="A few questions; we create the agents and wire them together. Everything can be refined in the full editors afterwards."
        actions={
          <button
            className="btn btn-ghost"
            onClick={() => {
              if (window.confirm('Clear all answers and start over?')) setState(initialState());
            }}
          >
            Start over
          </button>
        }
      />
      <ol className="stepper">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'active' : i < step ? 'done' : ''}>
            <button type="button" onClick={() => go(i)} disabled={i > step && (!!idProblem || !!mainProblem)}>
              <span className="stepper-num">{i < step ? '✓' : i + 1}</span>
              <span className="stepper-label">{label}</span>
            </button>
          </li>
        ))}
      </ol>

      <section className="panel wizard-panel">
        {step === 0 && (
          <Step title="What is it called, and what is it for?">
            <Field label="Name" hint="Shown in lists and as the chat page title.">
              <input
                autoFocus
                value={a.name}
                placeholder="e.g. Study Buddy"
                onChange={(e) => {
                  const name = e.target.value;
                  setState((s) => ({ ...s, answers: { ...s.answers, name, id: s.idTouched ? s.answers.id : slugify(name) } }));
                }}
              />
            </Field>
            <Field label="Purpose" hint="One or two sentences: who it helps and with what. Optional.">
              <textarea rows={2} value={a.description} placeholder="Helps first-year students plan their revision." onChange={(e) => setA({ description: e.target.value })} />
            </Field>
            <Field label="Id" hint={idProblem && (a.id || a.name) ? <span className="text-danger">{idProblem}</span> : 'Used in links; made from the name. Cannot be changed later.'}>
              <input className="mono" value={a.id} onChange={(e) => setState((s) => ({ ...s, idTouched: true, answers: { ...s.answers, id: e.target.value.trim() } }))} />
            </Field>
          </Step>
        )}

        {step === 1 && (
          <Step title="The main agent" help="The one people talk to.">
            <AgentChooser
              mode={state.mainMode}
              onMode={(m) => patch({ mainMode: m })}
              existing={a.main.existing}
              onExisting={(id) => setA({ main: { ...a.main, existing: id } })}
              value={a.main.new}
              onChange={(n) => setA({ main: { ...a.main, new: n } })}
              agents={agentList}
              presets={presets}
              namePlaceholder={a.name || 'Assistant'}
              rolePlaceholder="a friendly study coach"
            />
          </Step>
        )}

        {step === 2 && (
          <Step title="Helpers (optional)" help="Other agents the main agent works with. Skip this for a single agent.">
            {a.helpers.map((h, i) => (
              <HelperCard
                key={i}
                helper={h}
                agents={agentList}
                presets={presets}
                retrievers={(retrievers.data ?? []).map((r) => ({ id: r.id, name: r.name }))}
                memoryOn={a.memory.enabled}
                onChange={(next) => setA({ helpers: a.helpers.map((x, j) => (j === i ? next : x)) })}
                onRemove={() => setA({ helpers: a.helpers.filter((_, j) => j !== i) })}
              />
            ))}
            <div className="helper-add">
              {(Object.keys(HELPERS) as HelperKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="helper-add-btn"
                  onClick={() => {
                    const keeper = kind === 'memory' ? agentList.find((x) => x.id === 'memory_keeper') : undefined;
                    const helper: WizardHelper = { kind, existing: keeper?.id ?? '', new: blankAgent(), retriever: '' };
                    setState((s) => ({
                      ...s,
                      answers: {
                        ...s.answers,
                        helpers: [...s.answers.helpers, helper],
                        // A memory keeper needs memory on.
                        memory: kind === 'memory' ? { ...s.answers.memory, enabled: true } : s.answers.memory,
                      },
                    }));
                  }}
                >
                  <strong>+ {HELPERS[kind].label}</strong>
                  <span className="muted small">{HELPERS[kind].help}</span>
                </button>
              ))}
            </div>
          </Step>
        )}

        {step === 3 && (
          <Step title="Knowledge (optional)" help="Material the main agent can draw on: one of your retrievers (Data → Retrievers).">
            <Field label="Retriever">
              <select
                value={a.knowledge.retriever}
                onChange={(e) => setA({ knowledge: { retriever: e.target.value, mode: e.target.value ? (a.knowledge.mode === 'none' ? 'tool' : a.knowledge.mode) : 'none' } })}
              >
                <option value="">None</option>
                {(retrievers.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || r.id}
                  </option>
                ))}
              </select>
            </Field>
            {retrievers.error != null && <ErrorBox error={retrievers.error} title="Retrievers unavailable" />}
            {a.knowledge.retriever && (
              <Field label="How the agent uses it">
                <div className="choice-list">
                  <Choice name="kmode" checked={a.knowledge.mode === 'tool'} onPick={() => setA({ knowledge: { ...a.knowledge, mode: 'tool' } })} title="It searches when it needs to">
                    The agent gets a search tool and decides when to look things up. Best for occasional questions.
                  </Choice>
                  <Choice name="kmode" checked={a.knowledge.mode === 'context'} onPick={() => setA({ knowledge: { ...a.knowledge, mode: 'context' } })} title="Relevant material every turn">
                    Before every reply, material matching the conversation is added to its instructions. Best when nearly every answer should
                    come from your material.
                  </Choice>
                </div>
              </Field>
            )}
          </Step>
        )}

        {step === 4 && (
          <Step title="Memory (optional)" help="Remember things about each person between conversations, as structured notes.">
            <label className="check">
              <input type="checkbox" checked={a.memory.enabled} onChange={(e) => setA({ memory: { ...a.memory, enabled: e.target.checked } })} />
              Remember people between conversations
            </label>
            {a.memory.enabled && (
              <>
                <Field label="Memory schema" hint="Which kinds of notes can be kept (Settings → Memory schemas).">
                  <select value={a.memory.schema_id ?? ''} onChange={(e) => setA({ memory: { ...a.memory, schema_id: e.target.value || null } })}>
                    <option value="">Choose…</option>
                    {(schemas.data ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name || s.id}
                      </option>
                    ))}
                  </select>
                </Field>
                {!a.helpers.some((h) => h.kind === 'memory') && (
                  <Notice tone="warn">Nothing writes notes yet: add a Memory keeper helper (step 3) so notes get recorded after each turn.</Notice>
                )}
                <label className="check">
                  <input type="checkbox" checked={a.ui.require_profile} onChange={(e) => setA({ ui: { ...a.ui, require_profile: e.target.checked } })} />
                  Ask people to pick a profile before chatting (memory is kept per profile)
                </label>
              </>
            )}
          </Step>
        )}

        {step === 5 && (
          <SafetyStep
            state={state}
            meta={meta.data}
            classifiers={(classifiers.data ?? []).map((c) => ({ id: c.id, name: c.name, provider: c.provider }))}
            onState={patch}
            onSafety={(p) => setA({ safety: { ...a.safety, ...p } })}
          />
        )}

        {step === 6 && (
          <Step title="The chat page" help="What people see before their first message. All optional.">
            <Field label="Title">
              <input value={a.ui.title} placeholder={a.name || 'Chat'} onChange={(e) => setA({ ui: { ...a.ui, title: e.target.value } })} />
            </Field>
            <Field label="Welcome message" hint="Markdown; shown above the chat until the first message.">
              <textarea rows={4} value={a.ui.welcome} placeholder="Hi! I can help you…" onChange={(e) => setA({ ui: { ...a.ui, welcome: e.target.value } })} />
            </Field>
            <Field label="Suggested first messages" hint="Buttons people can click to start.">
              <StringListEditor value={a.ui.starters} onChange={(v) => setA({ ui: { ...a.ui, starters: v } })} placeholder="How do I…?" addLabel="Add suggestion" />
            </Field>
          </Step>
        )}

        {step === 7 && (
          <Review
            answers={toAnswers(state, meta.data, classifierIds)}
            agents={agentList}
            onCreated={(d) => {
              invalidate('agents', 'classifiers');
              patch({ created: d });
            }}
            onEdit={go}
          />
        )}

        {step < STEPS.length - 1 && (
          <div className="wizard-footer">
            <button type="button" className="btn" disabled={step === 0} onClick={() => go(step - 1)}>
              ← Back
            </button>
            <span className="grow" />
            {stepProblem && (a.id || a.name || step > 0) && <span className="text-danger small">{stepProblem}</span>}
            {step >= 2 && step <= 6 && (
              <button type="button" className="btn btn-ghost" onClick={() => go(STEPS.length - 1)} disabled={!!idProblem || !!mainProblem}>
                Skip to review
              </button>
            )}
            <button type="button" className="btn btn-primary" disabled={!!stepProblem} onClick={() => go(step + 1)}>
              {step === STEPS.length - 2 ? 'Review →' : 'Next →'}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Step({ title, help, children }: { title: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="wizard-step">
      <h2>{title}</h2>
      {help && <p className="muted">{help}</p>}
      {children}
    </div>
  );
}

function Choice({ name, checked, onPick, title, children, disabled }: { name: string; checked: boolean; onPick: () => void; title: ReactNode; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`choice${checked ? ' active' : ''}${disabled ? ' disabled' : ''}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} />
      <span>
        <strong>{title}</strong>
        {children && <span className="muted small"> — {children}</span>}
      </span>
    </label>
  );
}

/** Reuse a saved agent, or describe a new one. */
function AgentChooser({
  mode,
  onMode,
  existing,
  onExisting,
  value,
  onChange,
  agents,
  presets,
  namePlaceholder,
  rolePlaceholder,
  suggested,
}: {
  mode: 'new' | 'existing';
  onMode: (m: 'new' | 'existing') => void;
  existing: string;
  onExisting: (id: string) => void;
  value: WizardNewAgent;
  onChange: (v: WizardNewAgent) => void;
  agents: AgentSummary[];
  presets: string[];
  namePlaceholder: string;
  rolePlaceholder: string;
  suggested?: string;
}) {
  const id = `ac-${namePlaceholder}`;
  return (
    <div className="stack">
      <div className="seg">
        <button type="button" className={mode === 'new' ? 'active' : ''} onClick={() => onMode('new')}>
          Create a new agent
        </button>
        <button type="button" className={mode === 'existing' ? 'active' : ''} onClick={() => onMode('existing')} disabled={!agents.length}>
          Reuse a saved agent
        </button>
      </div>
      {mode === 'existing' ? (
        <Field label="Agent" hint={suggested && existing !== suggested && agents.some((a) => a.id === suggested) ? `Suggested: ${suggested}` : undefined}>
          <select value={existing} onChange={(e) => onExisting(e.target.value)}>
            <option value="">Choose…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name || a.id} ({a.id}){a.description ? ` — ${a.description.slice(0, 60)}` : ''}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <>
          <div className="grid-2">
            <Field label="Name">
              <input value={value.name} placeholder={namePlaceholder} onChange={(e) => onChange({ ...value, name: e.target.value })} />
            </Field>
            <Field label="Model" hint="A model preset from Settings.">
              <select id={id} value={value.model_preset} onChange={(e) => onChange({ ...value, model_preset: e.target.value })}>
                <option value="">The default</option>
                {presets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Role" hint="One line: what it is.">
            <input value={value.role} placeholder={`e.g. ${rolePlaceholder}`} onChange={(e) => onChange({ ...value, role: e.target.value })} />
          </Field>
          <Field label="Instructions" hint="How it should behave, in plain words. Optional; you can refine the full prompt in the agent editor.">
            <textarea
              rows={4}
              value={value.instructions}
              placeholder="e.g. Ask what they are studying, suggest one small next step at a time, keep answers short."
              onChange={(e) => onChange({ ...value, instructions: e.target.value })}
            />
          </Field>
        </>
      )}
    </div>
  );
}

function HelperCard({
  helper,
  agents,
  presets,
  retrievers,
  memoryOn,
  onChange,
  onRemove,
}: {
  helper: WizardHelper;
  agents: AgentSummary[];
  presets: string[];
  retrievers: { id: string; name: string }[];
  memoryOn: boolean;
  onChange: (h: WizardHelper) => void;
  onRemove: () => void;
}) {
  const info = HELPERS[helper.kind];
  const [mode, setMode] = useState<'new' | 'existing'>(helper.existing ? 'existing' : 'new');
  return (
    <div className="helper-card">
      <div className="row space-between">
        <div>
          <strong>{info.label}</strong> <Badge tone={info.link as 'delegate' | 'handoff' | 'observe'}>{info.link}</Badge>
          <div className="muted small">{info.help}</div>
        </div>
        <button type="button" className="btn btn-ghost btn-icon danger" title="Remove helper" onClick={onRemove}>
          ×
        </button>
      </div>
      <AgentChooser
        mode={mode}
        onMode={(m) => {
          setMode(m);
          if (m === 'new') onChange({ ...helper, existing: '' });
        }}
        existing={helper.existing}
        onExisting={(id) => onChange({ ...helper, existing: id })}
        value={helper.new}
        onChange={(n) => onChange({ ...helper, new: n })}
        agents={agents}
        presets={presets}
        namePlaceholder={info.label}
        rolePlaceholder={helper.kind === 'researcher' ? 'finds answers in the course notes' : helper.kind === 'specialist' ? 'an exam-stress specialist' : 'writes practice questions'}
        suggested={helper.kind === 'memory' ? 'memory_keeper' : undefined}
      />
      {helper.kind === 'researcher' && mode === 'new' && (
        <Field label="What it searches" hint="Blank = the retriever chosen under Knowledge.">
          <select value={helper.retriever} onChange={(e) => onChange({ ...helper, retriever: e.target.value })}>
            <option value="">(the knowledge retriever)</option>
            {retrievers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name || r.id}
              </option>
            ))}
          </select>
        </Field>
      )}
      {helper.kind === 'memory' && !memoryOn && <Notice tone="warn">Turn memory on (step 5) for this helper to work.</Notice>}
      {helper.kind === 'memory' && mode === 'new' && (
        <p className="muted small">A new memory keeper records notes from the memory schema&apos;s templates. The saved “memory_keeper” agent is usually the better choice.</p>
      )}
    </div>
  );
}

function SafetyStep({
  state,
  meta,
  classifiers,
  onState,
  onSafety,
}: {
  state: WizardState;
  meta: SafetyMeta | undefined;
  classifiers: { id: string; name: string; provider: SafetyProvider }[];
  onState: (p: Partial<WizardState>) => void;
  onSafety: (p: Partial<WizardAnswers['safety']>) => void;
}) {
  const s = state.answers.safety;
  const mode = state.safetyMode;
  return (
    <Step title="Safety checks (optional)" help="Check what people write, and what the agent replies, with a safety classifier.">
      <div className="choice-list">
        <Choice name="smode" checked={mode === 'none'} onPick={() => onState({ safetyMode: 'none' })} title="No safety checks">
          You can add guards later in the system editor.
        </Choice>
        <Choice
          name="smode"
          checked={mode === 'existing'}
          disabled={!classifiers.length}
          onPick={() => {
            onState({ safetyMode: 'existing' });
            if (!s.classifier && classifiers[0]) onSafety({ classifier: classifiers[0].id });
          }}
          title="Use a saved classifier"
        >
          {classifiers.length ? 'One from the Safety section.' : 'None saved yet.'}
        </Choice>
        <Choice name="smode" checked={mode === 'new'} onPick={() => onState({ safetyMode: 'new' })} title="Create a simple one">
          SAFER, keyword rules or an LLM judge.
        </Choice>
      </div>

      {mode === 'existing' && (
        <Field label="Classifier">
          <select value={s.classifier} onChange={(e) => onSafety({ classifier: e.target.value })}>
            {classifiers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id} ({c.provider})
              </option>
            ))}
          </select>
        </Field>
      )}
      {mode === 'new' && (
        <Field label="Kind" hint="Created with sensible defaults; fine-tune it later under Safety.">
          <div className="choice-list">
            {(['safer', 'keywords', 'llm'] as SimpleProvider[]).map((p) => (
              <Choice key={p} name="sprov" checked={state.newProvider === p} onPick={() => onState({ newProvider: p })} title={<ProviderBadge provider={p} />}>
                {PROVIDER_HELP[p]}
              </Choice>
            ))}
          </div>
          {meta?.providers[state.newProvider]?.setup && (
            <span className="field-hint">
              Its service must be running: <code>{meta.providers[state.newProvider].setup}</code>
            </span>
          )}
        </Field>
      )}

      {mode !== 'none' && (
        <>
          <Field label="When someone writes something flagged">
            <div className="choice-list">
              <Choice name="ipol" checked={s.input_policy === 'inform'} onPick={() => onSafety({ input_policy: 'inform' })} title="Answer with extra care">
                The agent is told the message was flagged and answers carefully. (Recommended)
              </Choice>
              <Choice name="ipol" checked={s.input_policy === 'block'} onPick={() => onSafety({ input_policy: 'block' })} title="Don't answer">
                A fixed reply goes out instead; the agent never sees it.
              </Choice>
              <Choice name="ipol" checked={s.input_policy === 'flag'} onPick={() => onSafety({ input_policy: 'flag' })} title="Just record it">
                Nothing changes for the user; it shows in the chat trace.
              </Choice>
              <Choice name="ipol" checked={s.input_policy === 'none'} onPick={() => onSafety({ input_policy: 'none' })} title="Don't check messages">
                {s.crisis_message.trim() ? 'Messages are still checked for the crisis message below.' : undefined}
              </Choice>
            </div>
          </Field>
          {s.input_policy === 'block' && (
            <Field label="Fixed reply">
              <textarea rows={2} value={s.block_message} onChange={(e) => onSafety({ block_message: e.target.value })} />
            </Field>
          )}
          <Field
            label="Crisis message"
            hint={
              <>
                Shown first when a message is about self-harm or suicide; then the agent answers. Check the numbers suit your users. Blank = no crisis
                message.{' '}
                {s.crisis_message !== DEFAULT_CRISIS_MESSAGE && (
                  <button type="button" className="link-btn small" onClick={() => onSafety({ crisis_message: DEFAULT_CRISIS_MESSAGE })}>
                    Use the default
                  </button>
                )}
              </>
            }
          >
            <textarea rows={6} value={s.crisis_message} onChange={(e) => onSafety({ crisis_message: e.target.value })} />
          </Field>
          <Field label="When the agent's reply is flagged">
            <div className="choice-list">
              <Choice name="opol" checked={s.output_policy === 'regenerate'} onPick={() => onSafety({ output_policy: 'regenerate' })} title="Ask for a different reply">
                Up to two more tries, then the safe reply below. (Recommended)
              </Choice>
              <Choice name="opol" checked={s.output_policy === 'flag'} onPick={() => onSafety({ output_policy: 'flag' })} title="Just record it" />
              <Choice name="opol" checked={s.output_policy === 'none'} onPick={() => onSafety({ output_policy: 'none' })} title="Don't check replies" />
            </div>
          </Field>
          {s.output_policy === 'regenerate' && (
            <Field label="Safe reply" hint="Used when the retries are flagged too.">
              <textarea rows={2} value={s.safe_reply} onChange={(e) => onSafety({ safe_reply: e.target.value })} />
            </Field>
          )}
        </>
      )}
    </Step>
  );
}

/** Asks the server what would be created; shows it with problems and warnings; Create. */
function Review({
  answers,
  agents,
  onCreated,
  onEdit,
}: {
  answers: WizardAnswers;
  agents: AgentSummary[];
  onCreated: (d: WizardDraft) => void;
  onEdit: (step: number) => void;
}) {
  const [draft, setDraft] = useState<{ of: WizardAnswers; result: WizardDraft } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const key = JSON.stringify(answers);

  useEffect(() => {
    let alive = true;
    setError(null);
    const body = JSON.parse(key) as WizardAnswers;
    api.wizard
      .draft(body)
      .then((result) => alive && setDraft({ of: body, result }))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [key]);

  const current = draft && isEqual(draft.of, answers) ? draft.result : null;
  const create = async () => {
    setBusy(true);
    setCreateError(null);
    try {
      onCreated(await api.wizard.create(answers));
    } catch (e) {
      setCreateError(e);
      setBusy(false);
    }
  };

  return (
    <div className="wizard-step">
      <h2>Review</h2>
      {error != null && <ErrorBox error={error} title="Could not check the answers" />}
      {!current && error == null && <Loading label="Checking…" />}
      {current && (
        <>
          <MessageList tone="error" title="Fix these first" items={current.problems} />
          <MessageList tone="warn" title="Worth a look" items={current.warnings} />
          <WizardPicture draft={current} agents={agents} />
          <div className="grid-2 wizard-review-lists">
            <div>
              <h3 className="subsection-title">New agents</h3>
              {current.agents.length === 0 ? (
                <p className="muted small">None — every node reuses a saved agent.</p>
              ) : (
                <ul className="tight-list">
                  {current.agents.map((ag) => (
                    <li key={ag.id}>
                      <strong>{ag.name}</strong> <code className="small muted">{ag.id}</code>
                      {ag.description && ag.description !== ag.name && <span className="muted small"> — {ag.description}</span>}
                      {ag.tools.length > 0 && <div className="muted small">tools: {ag.tools.map((t) => t.tool).join(', ')}</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="subsection-title">Safety</h3>
              {current.classifiers.map((c) => (
                <p key={c.id} className="small">
                  New classifier <strong>{c.name}</strong> <code className="muted">{c.id}</code> <ProviderBadge provider={c.provider} />
                </p>
              ))}
              {current.system.guards.length === 0 ? (
                <p className="muted small">No safety checks.</p>
              ) : (
                <ul className="tight-list small">
                  {current.system.guards.map((g) => (
                    <li key={g.id}>
                      <code>{g.id}</code> ({g.check === 'input' ? 'user messages' : 'replies'}): {g.rules.map((r) => r.action.replace('_', ' ')).join(' → ')}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
          {createError != null && <ErrorBox error={createError} title="Not created" />}
          <div className="wizard-footer">
            <button type="button" className="btn" onClick={() => onEdit(6)}>
              ← Back
            </button>
            <span className="grow" />
            <button type="button" className="btn btn-primary" disabled={busy || current.problems.length > 0} onClick={() => void create()}>
              {busy ? (
                <>
                  <Spinner /> Creating…
                </>
              ) : (
                `Create ${current.agents.length ? `${current.agents.length} agent${current.agents.length === 1 ? '' : 's'} and ` : ''}the system`
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** A small read-only picture: guards → the main node → helpers (with their link type). */
function WizardPicture({ draft, agents }: { draft: WizardDraft; agents: AgentSummary[] }) {
  const sys = draft.system;
  const names = useMemo(() => new Map([...agents.map((a) => [a.id, a.name || a.id] as const), ...draft.agents.map((a) => [a.id, a.name] as const)]), [agents, draft.agents]);
  const isNew = new Set(draft.agents.map((a) => a.id));
  const entry = sys.nodes.find((n) => n.id === sys.entry);
  const others = sys.nodes.filter((n) => n.id !== sys.entry);
  const linkTo = (id: string) => sys.links.find((l) => l.source === sys.entry && l.target === id);
  const nodeBox = (n: (typeof sys.nodes)[number]) => (
    <div className="wiz-node">
      <strong>{n.label || names.get(n.agent) || n.id}</strong>
      <div className="muted small">
        <code>{n.id}</code> · {isNew.has(n.agent) ? <Badge tone="ok">new agent</Badge> : <span>reuses {n.agent}</span>}
      </div>
      {(n.context?.length ?? 0) > 0 && <div className="small muted">+ knowledge every turn</div>}
      {n.inject_memory && <div className="small muted">+ memory</div>}
    </div>
  );
  return (
    <div className="wiz-picture">
      <div className="wiz-col">
        <div className="wiz-node wiz-user">👤 User</div>
        {sys.guards.map((g) => (
          <div key={g.id} className="wiz-node wiz-guard">
            ⛨ {g.check === 'input' ? 'checks messages' : 'checks replies'}
          </div>
        ))}
      </div>
      <div className="wiz-arrow">→</div>
      <div className="wiz-col">{entry && nodeBox(entry)}</div>
      {others.length > 0 && (
        <>
          <div className="wiz-arrow">→</div>
          <div className="wiz-col">
            {others.map((n) => {
              const l = linkTo(n.id);
              return (
                <div key={n.id} className="wiz-helper">
                  {l && <Badge tone={l.type}>{l.type}</Badge>}
                  {nodeBox(n)}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function Created({ draft, onStartOver }: { draft: WizardDraft; onStartOver: () => void }) {
  const id = draft.system.id;
  return (
    <div className="page wizard-page">
      <PageHeader title="Set up a new system" />
      <section className="panel wizard-panel">
        <div className="wizard-step">
          <h2>“{draft.system.name || id}” is ready</h2>
          <p className="muted">
            Created the system <code>{id}</code>
            {draft.agents.length > 0 && (
              <>
                , {draft.agents.length} agent{draft.agents.length === 1 ? '' : 's'} ({draft.agents.map((a) => a.id).join(', ')})
              </>
            )}
            {draft.classifiers.length > 0 && <> and the classifier {draft.classifiers.map((c) => c.id).join(', ')}</>}.
          </p>
          <div className="wizard-next">
            <Link className="wizard-next-card" to={`/systems/${id}`}>
              <strong>Open in the system editor</strong>
              <span className="muted small">See the graph, refine prompts, links, guards and settings.</span>
            </Link>
            <Link className="wizard-next-card" to={`/chat/${id}`}>
              <strong>Try it in chat</strong>
              <span className="muted small">Talk to it, with the debug trace alongside.</span>
            </Link>
            <Link className="wizard-next-card" to={`/links?system=${encodeURIComponent(id)}`}>
              <strong>Share a link</strong>
              <span className="muted small">Publish it at a private URL for people without an account.</span>
            </Link>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onStartOver}>
            Set up another system
          </button>
        </div>
      </section>
    </div>
  );
}
