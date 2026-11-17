import type {
  AgentDef,
  ClassifierDef,
  ContextDef,
  DatasetDef,
  LinkDef,
  ModelSpec,
  NodeDef,
  PersonaDef,
  RetrieverDef,
  RubricDef,
  SafetyProvider,
  ScenarioDef,
  SimRunConfig,
  SystemDef,
} from '../types';

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** JSON with sorted object keys, for change detection. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      return Object.keys(obj)
        .sort()
        .reduce<Record<string, unknown>>((acc, key) => {
          acc[key] = obj[key];
          return acc;
        }, {});
    }
    return v;
  });
}

export function isEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** A ModelSpec without unset (null/empty) fields. */
export function compactModel(spec: ModelSpec | null | undefined): ModelSpec {
  const out: Record<string, unknown> = {};
  if (!spec) return out as ModelSpec;
  for (const [k, v] of Object.entries(spec)) {
    if (v !== null && v !== undefined && v !== '') out[k] = v;
  }
  return out as ModelSpec;
}

export function isEmptyModel(spec: ModelSpec | null | undefined): boolean {
  return Object.keys(compactModel(spec)).length === 0;
}

export function fmtDateTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtTime(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19);
  return d.toLocaleTimeString(undefined, { hour12: false });
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A value as display text: strings as-is, everything else pretty JSON. */
export function toDisplay(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A value as one compact line. */
export function toInline(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} …`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** LLM cost in USD ("" for zero). */
export function fmtCost(n: number | null | undefined, zero = ''): string {
  if (!n) return zero;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

export function pluralize(n: number, word: string, plural = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`;
}

// ------------------------------------------------------------ payloads

/** Exactly the AgentDef fields (the API forbids extras like used_by). */
export function agentPayload(a: AgentDef): AgentDef {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    tags: a.tags,
    prompt: a.prompt,
    tools: a.tools,
    model: compactModel(a.model),
    max_llm_calls: a.max_llm_calls,
    reply_mode: a.reply_mode,
    notes: a.notes,
  };
}

/** Exactly the DatasetDef fields (the API forbids extras like stats/files). */
export function datasetPayload(d: DatasetDef): DatasetDef {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    tags: d.tags,
    fields: d.fields,
    extraction: { ...d.extraction, model: compactModel(d.extraction.model) },
    vision: { ...d.vision, model: compactModel(d.vision.model) },
    chunking: d.chunking,
    records: d.records,
    notes: d.notes,
  };
}

/** Exactly the RetrieverDef fields (no used_by/index); empty mapping overrides dropped. */
export function retrieverPayload(r: RetrieverDef): RetrieverDef {
  const compactMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v.trim() !== ''));
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    tags: r.tags,
    sources: r.sources.map((s) => ({
      dataset: s.dataset,
      where: Object.fromEntries(Object.entries(s.where).filter(([k, v]) => k.trim() && v.length)),
      mapping: compactMap(s.mapping),
    })),
    mapping: compactMap(r.mapping),
    unit: r.unit,
    method: r.method,
    k: r.k,
    max_per_item: r.max_per_item,
    dense_weight: r.dense_weight,
    bm25_weight: r.bm25_weight,
    query_rewrite: r.query_rewrite,
    catalog_line: r.catalog_line,
    catalog_max: r.catalog_max,
    presentation: r.presentation,
    budget: r.budget,
    template: r.template,
    json_fields: r.json_fields,
    brief_prompt: r.brief_prompt,
    model: compactModel(r.model),
    embedder: r.embedder,
    notes: r.notes,
  };
}

/** A system ready to send: node model overrides that are empty become null (stamps dropped). */
export function systemPayload(s: SystemDef): SystemDef {
  const { updated_at: _u, updated_by: _b, version: _v, ...rest } = s;
  return {
    ...rest,
    nodes: s.nodes.map((n) => ({ ...n, model: isEmptyModel(n.model) ? null : compactModel(n.model) })),
  };
}

/** Exactly the PersonaDef fields (the API forbids extras like used_by). */
export function personaPayload(p: PersonaDef): PersonaDef {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    tags: p.tags,
    profile: p.profile,
    model: compactModel(p.model),
    notes: p.notes,
  };
}

/** Exactly the ScenarioDef fields. */
export function scenarioPayload(s: ScenarioDef): ScenarioDef {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    tags: s.tags,
    persona: s.persona,
    opening: s.opening,
    opening_mode: s.opening_mode,
    situation: s.situation,
    facts: s.facts,
    goal: s.goal,
    max_turns: s.max_turns,
    expectations: s.expectations.map((e) => ({ name: e.name, description: e.description, pattern: e.pattern })),
    profile: s.profile,
    notes: s.notes,
  };
}

/** Exactly the RubricDef fields. */
export function rubricPayload(r: RubricDef): RubricDef {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    tags: r.tags,
    instructions: r.instructions,
    criteria: r.criteria.map((c) => ({ key: c.key, title: c.title, description: c.description, min: c.min, max: c.max, weight: c.weight })),
    grade_expectations: r.grade_expectations,
    model: compactModel(r.model),
    notes: r.notes,
  };
}

/** A run config ready to send: empty model overrides become null. */
export function simConfigPayload(c: SimRunConfig): SimRunConfig {
  return {
    ...c,
    name: c.name.trim(),
    simulator_model: isEmptyModel(c.simulator_model) ? null : compactModel(c.simulator_model),
    judge_model: isEmptyModel(c.judge_model) ? null : compactModel(c.judge_model),
  };
}

// ------------------------------------------------------------ defaults

export function newNode(id: string, agent: string, position: { x: number; y: number }, label = ''): NodeDef {
  return {
    id,
    agent,
    label,
    prompt_template: '',
    tools: [],
    tool_config: {},
    model: null,
    max_llm_calls: null,
    modes: [],
    initial_mode: null,
    inject_memory: false,
    context: [],
    position,
  };
}

export function newLink(id: string, type: LinkDef['type'], source: string, target: string): LinkDef {
  return {
    id,
    type,
    source,
    target,
    tool_name: type === 'delegate' ? `ask_${target}` : null,
    tool_description: '',
    parameters: null,
    require_state: [],
    require_state_error: '',
    request_template: '',
    max_llm_calls: null,
    nudge: '',
    share_resources: true,
    requires_profile: true,
  };
}

export function newContext(name: string, retriever: string): ContextDef {
  return { name, retriever, label: '', placement: 'append', question: '', condition: '', scope_state_key: '', budget: null };
}

export function newSystem(id: string): SystemDef {
  return {
    id,
    name: '',
    description: '',
    tags: [],
    entry: '',
    nodes: [],
    links: [],
    fragments: {},
    variables: {},
    state: {},
    memory: { enabled: false, schema_id: null, namespace: null },
    ui: { title: '', welcome: '', starters: [], require_profile: false, show_viewer: true },
    guards: [],
    notes: '',
  };
}

/** Exactly the ClassifierDef fields (the API forbids extras like used_by). */
export function classifierPayload(c: ClassifierDef): ClassifierDef {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    tags: c.tags,
    provider: c.provider,
    url: c.url,
    model: compactModel(c.model),
    threshold: c.threshold,
    prompt: c.prompt,
    categories: c.categories,
    keywords: c.keywords.map((k) => ({ category: k.category, pattern: k.pattern })),
    rails_config: c.rails_config,
    rails_prompts: c.rails_prompts,
    controversial_unsafe: c.controversial_unsafe,
    timeout: c.timeout,
    on_error: c.on_error,
    notes: c.notes,
  };
}

export function newClassifier(id: string, name = '', provider: SafetyProvider = 'safer'): ClassifierDef {
  return {
    id,
    name,
    description: '',
    tags: [],
    provider,
    url: '',
    model: {},
    threshold: 0.5,
    prompt: '',
    categories: [],
    keywords: [],
    rails_config: '',
    rails_prompts: '',
    controversial_unsafe: false,
    timeout: 15,
    on_error: 'allow',
    notes: '',
  };
}

/** Nodes that talk to the user: the entry plus everything reachable by handoff. */
export function userFacingNodes(system: Pick<SystemDef, 'entry' | 'links'>): Set<string> {
  const out = new Set<string>();
  if (!system.entry) return out;
  const queue = [system.entry];
  while (queue.length) {
    const id = queue.shift() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const l of system.links) if (l.type === 'handoff' && l.source === id) queue.push(l.target);
  }
  return out;
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) if (!set.has(`${base}_${i}`)) return `${base}_${i}`;
}

export function newPersona(id: string, name = ''): PersonaDef {
  return { id, name, description: '', tags: [], profile: '', model: {}, notes: '' };
}

export function newScenario(id: string, name = ''): ScenarioDef {
  return {
    id,
    name,
    description: '',
    tags: [],
    persona: '',
    opening: '',
    opening_mode: 'exact',
    situation: '',
    facts: {},
    goal: '',
    max_turns: 8,
    expectations: [],
    profile: '',
    notes: '',
  };
}

export function newRubric(id: string, name = ''): RubricDef {
  return { id, name, description: '', tags: [], instructions: '', criteria: [], grade_expectations: true, model: {}, notes: '' };
}

export function newSimConfig(): SimRunConfig {
  return {
    name: '',
    systems: [],
    scenarios: [],
    personas: [],
    repetitions: 1,
    max_turns: null,
    concurrency: 4,
    rubric: '',
    profile_mode: 'fresh',
    simulator_model: null,
    judge_model: null,
    notes: '',
  };
}

/** "3m 12s" between two timestamps of the same clock. */
export function fmtDuration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '';
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return '';
  return fmtSeconds(Math.max(0, (b - a) / 1000));
}

export function fmtSeconds(sec: number | null | undefined): string {
  if (sec == null) return '';
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
