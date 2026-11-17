// TypeScript mirrors of sbf/schemas.py plus the shapes the API returns.

// ------------------------------------------------------------- definitions

export type Provider = 'openrouter' | 'llama_cpp' | 'gemini' | 'litellm';
export const PROVIDERS: Provider[] = ['openrouter', 'llama_cpp', 'gemini', 'litellm'];

/** Which LLM an agent runs on. Unset fields inherit (preset → agent → node). */
export interface ModelSpec {
  preset?: string | null;
  provider?: Provider | null;
  model?: string | null;
  api_base?: string | null;
  reasoning_effort?: string | null;
  temperature?: number | null;
  top_p?: number | null;
  top_k?: number | null;
  presence_penalty?: number | null;
  max_output_tokens?: number | null;
}

export interface ToolBinding {
  tool: string;
  name?: string | null;
  description?: string | null;
  config: Record<string, unknown>;
  budget?: number | null;
  result_cap?: number | null;
  enabled: boolean;
}

export type ReplyMode = 'text' | 'tool';

export interface AgentDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  prompt: string;
  tools: ToolBinding[];
  model: ModelSpec;
  max_llm_calls: number;
  reply_mode: ReplyMode;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export interface AgentUsage {
  system: string;
  name: string;
  nodes: string[];
}

/** GET /api/agents/:id */
export interface AgentDetail extends AgentDef {
  used_by: AgentUsage[];
}

/** GET /api/agents (prompt omitted) */
export interface AgentSummary extends Omit<AgentDef, 'prompt'> {
  prompt_chars: number;
  used_by: string[];
}

export interface ModeDef {
  id: string;
  label: string;
  description: string;
  prompt: string;
  state: Record<string, unknown>;
}

export interface NodeDef {
  id: string;
  agent: string;
  label: string;
  prompt_template: string;
  tools: ToolBinding[];
  tool_config: Record<string, Record<string, unknown>>;
  model?: ModelSpec | null;
  max_llm_calls?: number | null;
  modes: ModeDef[];
  initial_mode?: string | null;
  inject_memory: boolean;
  /** Retrieved material added to the instruction before the node runs. */
  context?: ContextDef[];
  position: { x: number; y: number };
}

/** Retrieve-before-the-turn RAG on a node ({{ context.<name> }}). */
export interface ContextDef {
  name: string;
  retriever: string;
  label: string;
  placement: 'append' | 'template';
  question: string;
  condition: string;
  scope_state_key: string;
  budget?: number | null;
}

export type LinkType = 'delegate' | 'handoff' | 'observe';
export const LINK_TYPES: LinkType[] = ['delegate', 'handoff', 'observe'];

export interface LinkDef {
  id: string;
  type: LinkType;
  source: string;
  target: string;
  tool_name?: string | null;
  tool_description: string;
  parameters?: Record<string, unknown> | null;
  require_state: string[];
  require_state_error: string;
  request_template: string;
  max_llm_calls?: number | null;
  nudge: string;
  share_resources: boolean;
  requires_profile: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  schema_id?: string | null;
  namespace?: string | null;
}

export interface UIConfig {
  title: string;
  welcome: string;
  starters: string[];
  require_profile: boolean;
  show_viewer: boolean;
}

export interface SystemDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  entry: string;
  nodes: NodeDef[];
  links: LinkDef[];
  fragments: Record<string, string>;
  variables: Record<string, unknown>;
  state: Record<string, unknown>;
  memory: MemoryConfig;
  ui: UIConfig;
  /** Safety classifiers attached to nodes. */
  guards: GuardDef[];
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

// -------------------------------------------------------------------- safety

export type SafetyProvider = 'safer' | 'qwen3guard' | 'nemoguard' | 'nemo_guardrails' | 'llm' | 'keywords';
export const SAFETY_PROVIDERS: SafetyProvider[] = ['safer', 'nemo_guardrails', 'llm', 'keywords', 'qwen3guard', 'nemoguard'];

export interface KeywordRule {
  category: string;
  /** Regular expression (case-insensitive, Python syntax). */
  pattern: string;
}

/** A safety classifier: something that labels a message safe or unsafe (with categories). */
export interface ClassifierDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  provider: SafetyProvider;
  /** safer, nemo_guardrails; empty = the default. */
  url: string;
  /** qwen3guard, nemoguard, llm. */
  model: ModelSpec;
  /** safer: score above which a category applies. */
  threshold: number;
  /** nemoguard, llm: prompt template; empty = the default. */
  prompt: string;
  /** llm: the categories it may report. */
  categories: string[];
  keywords: KeywordRule[];
  /** nemo_guardrails: config.yml / prompts.yml; empty = the defaults. */
  rails_config: string;
  rails_prompts: string;
  /** qwen3guard: treat "Controversial" as unsafe. */
  controversial_unsafe: boolean;
  /** Seconds. */
  timeout: number;
  /** What a failed check (service down, timeout) counts as. */
  on_error: 'allow' | 'block';
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

/** GET /api/classifiers (+ the systems whose guards use it). */
export interface ClassifierSummary extends ClassifierDef {
  used_by: { system: string; guards: string[] }[];
}

export interface SafetyProviderMeta {
  label: string;
  /** Absent for providers without a fixed list (nemo_guardrails). */
  categories?: string[];
  /** How to start the service. */
  setup?: string;
  url?: string;
  model?: ModelSpec;
  prompt?: string;
  rails_config?: string;
  rails_prompts?: string;
}

/** GET /api/safety/meta */
export interface SafetyMeta {
  providers: Record<SafetyProvider, SafetyProviderMeta>;
  input_actions: InputAction[];
  output_actions: OutputAction[];
}

/** POST /api/classifiers/test */
export interface Verdict {
  safe: boolean;
  label: 'safe' | 'unsafe' | 'controversial' | 'error' | string;
  categories: string[];
  scores: Record<string, number>;
  latency_ms: number;
  error: string | null;
  detail: unknown;
}

/** GET /api/classifiers/:id/status (only safer and nemo_guardrails are checked). */
export interface ClassifierStatus {
  checked: boolean;
  ok: boolean | null;
  detail: string;
  url?: string;
}

export type InputAction = 'block' | 'inform' | 'add_message' | 'flag';
export type OutputAction = 'regenerate' | 'replace' | 'add_message' | 'flag';
export type GuardAction = InputAction | OutputAction;
export const INPUT_ACTIONS: InputAction[] = ['block', 'inform', 'add_message', 'flag'];
export const OUTPUT_ACTIONS: OutputAction[] = ['regenerate', 'replace', 'add_message', 'flag'];

/** What happens on an unsafe verdict whose categories match (the first matching rule applies). */
export interface GuardRule {
  /** Empty = any unsafe verdict; else any of these (case-insensitive, partial match). */
  categories: string[];
  action: GuardAction;
  message: string;
}

/** A classifier attached to a node: checks the user's message (input) or the node's reply (output). */
export interface GuardDef {
  id: string;
  classifier: string;
  /** Empty = the entry node. */
  node: string;
  check: 'input' | 'output';
  /** output: the reply alone, or the user's message + the reply. */
  scope: 'message' | 'exchange';
  /** Empty = block (input) / regenerate (output). */
  rules: GuardRule[];
  max_retries: number;
  enabled: boolean;
  position: { x: number; y: number };
}

// -------------------------------------------------------------------- wizard

export interface WizardNewAgent {
  name: string;
  role: string;
  instructions: string;
  model_preset: string;
}

export type HelperKind = 'researcher' | 'specialist' | 'memory' | 'delegate';

export interface WizardHelper {
  kind: HelperKind;
  existing: string;
  new: WizardNewAgent;
  retriever: string;
}

export interface WizardAnswers {
  id: string;
  name: string;
  description: string;
  main: { existing: string; new: WizardNewAgent };
  helpers: WizardHelper[];
  knowledge: { retriever: string; mode: 'none' | 'context' | 'tool' };
  memory: MemoryConfig;
  safety: {
    classifier: string;
    new_classifier: ClassifierDef | null;
    input_policy: 'none' | 'block' | 'inform' | 'flag';
    output_policy: 'none' | 'regenerate' | 'flag';
    crisis_message: string;
    block_message: string;
    safe_reply: string;
  };
  ui: UIConfig;
}

/** POST /api/wizard/draft and /create (create adds the system's version). */
export interface WizardDraft {
  system: SystemDef;
  agents: AgentDef[];
  classifiers: ClassifierDef[];
  problems: string[];
  warnings: string[];
  version?: string;
}

/** GET /api/systems */
export interface SystemSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  entry: string;
  nodes: { id: string; agent: string }[];
  links: number;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
  ui: UIConfig;
  memory?: MemoryConfig;
}

export interface MemorySlotDef {
  enum?: string | string[] | null;
  ref?: 'resource' | null;
  required: boolean;
}

export interface MemoryTemplateDef {
  description: string;
  slots: Record<string, MemorySlotDef>;
  follow_up: boolean;
  render: string;
}

export interface MemorySchema {
  id: string;
  name: string;
  description: string;
  vocabularies: Record<string, string[]>;
  labels: Record<string, string>;
  templates: Record<string, MemoryTemplateDef>;
  snapshot_max_chars: number;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export interface MemorySchemaSummary {
  id: string;
  name: string;
  description: string;
  templates: number;
}

export interface Fragment {
  id: string;
  text: string;
  version?: string | null;
}

// ------------------------------------------------------------------ settings

export type KnowledgeBackend = 'embedding_service' | 'datasets';

export interface KnowledgeSettings {
  backend: KnowledgeBackend;
  url: string;
  processed_root: string;
  file_root: string;
  libraries: Record<string, Record<string, unknown>>;
}

export interface StaticMount {
  prefix: string;
  directory: string;
}

export type EmbedderProvider = 'sentence_transformers' | 'litellm' | 'hash';
export const EMBEDDER_PROVIDERS: EmbedderProvider[] = ['sentence_transformers', 'litellm', 'hash'];

/** A text embedding model for the retrievers. */
export interface EmbedderSpec {
  provider: EmbedderProvider;
  model: string;
  api_base?: string | null;
  batch_size: number;
}

export interface Settings {
  default_model: string;
  models: Record<string, ModelSpec>;
  llm_retries: number;
  knowledge: KnowledgeSettings;
  embedders: Record<string, EmbedderSpec>;
  default_embedder: string;
  /** Files processed at once. */
  processing_workers: number;
  /** LLM calls (vision, extraction) in flight. */
  processing_llm_calls: number;
  static_mounts: StaticMount[];
  scorm_root: string;
  /** Hash of settings.yaml (send it back as If-Match). */
  version?: string | null;
}

export interface Meta {
  version: string;
  workspace: string;
  data: string;
  /** Accounts are on (false: everyone acts as a local admin). */
  auth?: boolean;
  errors: {
    agents: Record<string, string>;
    systems: Record<string, string>;
    memory_schemas: Record<string, string>;
    datasets?: Record<string, string>;
    retrievers?: Record<string, string>;
  };
}

// --------------------------------------------------------------------- tools

/** A (subset of a) pydantic JSON schema. */
export interface JSONSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  $ref?: string;
  $defs?: Record<string, JSONSchema>;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  additionalProperties?: boolean | JSONSchema;
}

export interface ToolInfo {
  id: string;
  label: string;
  category: string;
  summary: string;
  description: string;
  parameters: Record<string, unknown> | null;
  config_schema: JSONSchema;
  terminal: boolean;
  requires: string[];
}

// ----------------------------------------------------------- validate/preview

export interface ValidateResult {
  ok: boolean;
  problems: string[];
  warnings: string[];
  hash: string | null;
  user_facing?: string[];
  models?: Record<string, ModelSpec>;
}

export interface PreviewTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  terminal?: boolean;
  delegate_to?: string;
  error?: string;
}

export interface PreviewResult {
  instruction: string;
  chars: number;
  tools: PreviewTool[];
  state: Record<string, unknown>;
  handoffs: string[];
  warnings: string[];
}

export interface PreviewRequest {
  node: string;
  draft?: SystemDef | null;
  mode?: string | null;
  state?: Record<string, unknown> | null;
  profile_id?: number | null;
}

// ----------------------------------------------------------------- knowledge

export interface Library {
  id: string;
  label: string;
  description: string;
  resources: number;
  /** Listed in settings.knowledge.libraries. */
  configured?: boolean;
}

// --------------------------------------------------------------- datasets

export type FieldType = 'text' | 'long_text' | 'list' | 'enum' | 'number' | 'boolean';
export const FIELD_TYPES: FieldType[] = ['text', 'long_text', 'list', 'enum', 'number', 'boolean'];

/** One piece of information the extractor pulls out of every document. */
export interface FieldDef {
  name: string;
  type: FieldType;
  description: string;
  options: string[];
  required: boolean;
}

export interface ExtractionConfig {
  enabled: boolean;
  model: ModelSpec;
  instructions: string;
  max_chars: number;
}

export interface VisionConfig {
  enabled: boolean;
  model: ModelSpec;
  prompt: string;
  min_page_chars: number;
  max_images: number;
}

export interface ChunkingConfig {
  chunk_chars: number;
  overlap: number;
  summary_chunk: boolean;
}

export interface RecordsConfig {
  title_field: string;
  text_template: string;
  extract: boolean;
}

export interface DatasetDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  fields: FieldDef[];
  extraction: ExtractionConfig;
  vision: VisionConfig;
  chunking: ChunkingConfig;
  records: RecordsConfig;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export type FileStatus = 'queued' | 'processing' | 'ready' | 'error' | 'unsupported';
export const FILE_STATUSES: FileStatus[] = ['ready', 'queued', 'processing', 'error', 'unsupported'];

export interface DatasetStats {
  files: number;
  items: number;
  chunks: number;
  /** File status → count. */
  status: Record<string, number>;
  stale: number;
  cost: number;
  version: number;
  extraction_errors: number;
}

/** GET /api/datasets */
export interface DatasetSummary extends DatasetDef {
  stats: DatasetStats;
  processing: boolean;
  /** Retriever ids. */
  used_by: string[];
}

export interface DatasetFile {
  id: number;
  name: string;
  path: string;
  linked: boolean;
  kind: string | null;
  mime: string | null;
  size: number | null;
  sha256: string | null;
  status: FileStatus | string;
  stage: string | null;
  error: string | null;
  warnings: string[];
  cost: number;
  uploaded_at: string;
  processed_at: string | null;
  items: number;
}

/** GET /api/datasets/:id */
export interface DatasetDetail extends DatasetSummary {
  files: DatasetFile[];
  extraction_hash: string | null;
  accepted: string[];
}

export interface UploadResult {
  added: DatasetFile[];
  skipped: { name: string; reason: string }[];
}

/** full = re-read the file; fields = re-run LLM extraction; chunks = re-chunk only. */
export type ProcessMode = 'full' | 'fields' | 'chunks';

export interface DatasetItem {
  id: number;
  file_id: number | null;
  title: string;
  source_type: string;
  fields: Record<string, unknown>;
  meta: Record<string, unknown>;
  extraction_hash: string | null;
  extraction_error: string | null;
  updated_at: string | null;
  chars?: number;
  key: string;
  stale?: boolean;
}

export interface ItemsPage {
  total: number;
  items: DatasetItem[];
}

export interface ItemSection {
  idx: number;
  label: string;
  kind: string;
  /** text | vision */
  source: string;
  text: string;
}

export interface ItemChunk {
  item_id: number;
  idx: number;
  label: string;
  text: string;
}

/** GET /api/datasets/:id/items/:item */
export interface ItemDetail extends DatasetItem {
  /** What an edit is based on (title + fields); send it back as If-Match. */
  version?: string;
  text: string;
  url: string;
  file: DatasetFile | null;
  sections: ItemSection[];
  chunks: ItemChunk[];
}

export interface LlmLedger {
  llm_calls: number;
  cost: number;
  tokens: number;
}

export interface ExtractPreview extends LlmLedger {
  fields: Record<string, unknown>;
  problems: string[];
  current: Record<string, unknown>;
}

// ------------------------------------------------------------- retrievers

export type RetrieverUnit = 'chunks' | 'items' | 'items+chunks';
export type RetrieverMethod = 'hybrid' | 'facets' | 'catalog' | 'all';
export type Presentation = 'passages' | 'json' | 'template' | 'brief';

export interface RetrieverSource {
  dataset: string;
  /** source_type, file or a field name → allowed values. */
  where: Record<string, string[]>;
  /** Overrides of the retriever's mapping for this dataset. */
  mapping: Record<string, string>;
}

export interface RetrieverDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  sources: RetrieverSource[];
  mapping: Record<string, string>;
  unit: RetrieverUnit;
  method: RetrieverMethod;
  k: number;
  max_per_item: number;
  dense_weight: number;
  bm25_weight: number;
  query_rewrite: boolean;
  catalog_line: string;
  catalog_max: number;
  presentation: Presentation;
  budget: number;
  template: string;
  json_fields: string[];
  brief_prompt: string;
  model: ModelSpec;
  embedder: string;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export interface RetrieverUsage {
  kind: 'system' | 'agent';
  id: string;
  nodes?: string[];
}

export interface IndexStatus {
  built: boolean;
  entries?: number;
  items?: number;
  /** Dataset id → content version the index was built on. */
  datasets?: Record<string, number>;
  warnings?: string[];
  build_ms?: number;
  embedder?: string;
  building?: boolean;
  error?: string;
}

/** GET /api/retrievers, /api/retrievers/:id */
export interface RetrieverSummary extends RetrieverDef {
  used_by: RetrieverUsage[];
  index: IndexStatus;
}

export type MappingKey = 'title' | 'text' | 'index_text' | 'chunk_text' | 'chunk_index_text' | 'url';
export const MAPPING_KEYS: MappingKey[] = ['title', 'text', 'index_text', 'chunk_text', 'chunk_index_text', 'url'];

/** GET /api/rag/meta */
export interface RagMeta {
  methods: RetrieverMethod[];
  presentations: Presentation[];
  units: RetrieverUnit[];
  default_mapping: Record<MappingKey, string>;
  default_catalog_line: string;
  embedders: string[];
  default_embedder: string;
  mapping_variables: Record<string, string[]>;
}

export interface MappedEntry {
  item_key: string;
  kind: string;
  title: string;
  label: string;
  text: string;
  index_text: string;
  url: string;
}

export interface EntriesResult {
  total: number;
  items: number;
  warnings: string[];
  entries: MappedEntry[];
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunRequest {
  retriever?: string;
  draft?: RetrieverDef;
  query: string;
  queries?: string[];
  conversation?: ConversationTurn[];
  budget?: number | null;
  datasets?: string[] | null;
}

export interface RetrievedPassage {
  item_key: string;
  dataset: string;
  item_id: number;
  title: string;
  text?: string;
  /** chunk | item | brief */
  kind: string;
  label: string;
  source_type: string;
  url: string;
  score: number;
  fields: Record<string, unknown>;
}

export interface RunMeta extends Partial<LlmLedger> {
  retriever: string;
  method: RetrieverMethod;
  presentation: Presentation;
  unit: RetrieverUnit;
  budget: number;
  entries?: number;
  queries?: string[];
  selected?: number;
  shown?: number;
  chars?: number;
  ms?: { index: number; select: number; present: number; total: number };
  warnings?: string[];
  picked?: string[];
  scope?: string[];
  brief_batches?: number;
  brief_notes?: number;
  catalog_chars?: number;
  [key: string]: unknown;
}

/** POST /api/retrievers/run */
export interface RunResult {
  text: string;
  brief: string;
  passages: RetrievedPassage[];
  meta: RunMeta;
}

// --------------------------------------------------------------- chats/runtime

export interface Profile {
  id: number;
  name: string;
  created_at: string;
  last_active: string | null;
  memories?: number;
  /** user | simulation (simulated profiles are hidden from GET /api/profiles). */
  origin?: string;
  user_id?: number | null;
  /** Owner's username (null: no owner). */
  owner?: string | null;
}

export interface Chat {
  id: string;
  system_id: string;
  profile_id: number | null;
  title: string | null;
  origin: string;
  run_id: string | null;
  turns: number;
  created_at: string;
  updated_at: string;
  user_id?: number | null;
  /** Owner's username (null: no owner). */
  owner?: string | null;
  /** The chat link a visitor conversation (origin 'link') came through. */
  link_id?: string | null;
}

interface OutputBase {
  /** Database id; absent only on outputs of non-persisted turns. */
  id?: number;
  node: string | null;
  turn: number;
  ts: string;
}

export interface UserOutput extends OutputBase { type: 'user'; content: string }
export interface MessageOutput extends OutputBase {
  type: 'message';
  content: string;
  /** Delivered by a safety guard (a block reply, a replacement or an added message). */
  safety?: boolean;
}
export interface FileOutput extends OutputBase {
  type: 'file';
  resource_id: string;
  title: string;
  source_type: string;
  source_file: string;
  url: string;
  note: string;
  summary: string;
  /** Media type guessed from the file name (e.g. video/mp4). */
  mime?: string | null;
}
export interface ViewerOutput extends OutputBase {
  type: 'viewer';
  resource_id: string;
  lesson_id: string;
  title: string;
  section: string;
  url: string;
  note: string;
  summary: string;
}
export interface ModeOutput extends OutputBase { type: 'mode'; mode: string; label: string }
export interface HandoffOutput extends OutputBase { type: 'handoff'; from: string; to: string }

export type ChatOutput =
  | UserOutput
  | MessageOutput
  | FileOutput
  | ViewerOutput
  | ModeOutput
  | HandoffOutput;

export interface ChatDetail {
  chat: Chat;
  outputs: ChatOutput[];
  state: Record<string, unknown>;
  /** A turn is in progress. */
  running: boolean;
  /** The last turn is done but its observers are still running. */
  observing?: boolean;
  /** Turn number → definitions snapshot hash. */
  turn_snapshots?: Record<string, string>;
}

export interface TraceEvent {
  agent: string;
  run: string | null;
  event: string;
  ts: string;
  data: unknown;
  /** Turn the event belongs to (live events from the server carry it). */
  turn?: number | null;
}

/** GET /api/chats/:id/traces (data is the persisted, unclipped variant). */
export interface StoredTrace extends TraceEvent {
  id: number;
  chat_id: string;
  turn: number;
}

export type StreamEvent =
  | { kind: 'turn_start'; turn: number; snapshot: string }
  | ({ kind: 'output' } & ChatOutput)
  | ({ kind: 'trace' } & TraceEvent)
  | { kind: 'turn_done'; turn?: number }
  | { kind: 'error'; message: string }
  | { kind: 'end' };

export interface HistoryMessage {
  role: 'user' | 'assistant' | 'tool' | string;
  content: string | null;
  agent?: string;
  name?: string;
  tool_call_id?: string;
  reasoning?: string;
  nudge?: boolean;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

// -------------------------------------------------------------------- memory

export type MemorySlotInfo =
  | { enum: string[]; required: boolean; ref?: undefined }
  | { ref: 'resource'; required: boolean; enum?: undefined };

export interface MemoryTemplateInfo {
  description: string;
  follow_up: boolean;
  slots: Record<string, MemorySlotInfo>;
}

export interface MemoryNote {
  id: number;
  namespace: string;
  profile_id: number;
  chat_id: string | null;
  ts: string;
  template: string;
  slots: Record<string, unknown>;
  rendered: string;
  follow_up: boolean;
}

export interface NotesPage {
  total: number;
  memories: MemoryNote[];
}

// --------------------------------------------------------------- simulations

/** A simulated user: who they are and how they type, and the model playing them. */
export interface PersonaDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Background, personality, tone, message length, quirks. */
  profile: string;
  model: ModelSpec;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

/** GET /api/personas (+ the scenarios using it as their default persona). */
export interface PersonaSummary extends PersonaDef {
  used_by: string[];
}

/** Something a good conversation should cover (graded 0-3 by the judge; `pattern` = deterministic regex check). */
export interface Expectation {
  name: string;
  description: string;
  pattern: string;
}

export type OpeningMode = 'exact' | 'guide';

/** What a simulated user is dealing with and wants from the conversation. */
export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  /** Default persona id. */
  persona: string;
  opening: string;
  opening_mode: OpeningMode;
  situation: string;
  /** label → answer, revealed only when asked. */
  facts: Record<string, string>;
  goal: string;
  max_turns: number;
  expectations: Expectation[];
  /** Name of a real memory profile whose notes the simulated user starts with (copied). */
  profile: string;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export interface Criterion {
  key: string;
  title: string;
  description: string;
  min: number;
  max: number;
  weight: number;
}

/** How an LLM judge grades a simulated conversation. */
export interface RubricDef {
  id: string;
  name: string;
  description: string;
  tags: string[];
  instructions: string;
  criteria: Criterion[];
  grade_expectations: boolean;
  model: ModelSpec;
  notes: string;
  updated_at?: string | null;
  updated_by?: string | null;
  /** Hash of the stored file (send it back as If-Match). */
  version?: string | null;
}

export type ProfileMode = 'fresh' | 'none';

/** A simulation run: every system × scenario × persona × repetition. */
export interface SimRunConfig {
  name: string;
  systems: string[];
  scenarios: string[];
  /** Empty = each scenario's own persona. */
  personas: string[];
  repetitions: number;
  max_turns: number | null;
  concurrency: number;
  rubric: string;
  profile_mode: ProfileMode;
  simulator_model: ModelSpec | null;
  judge_model: ModelSpec | null;
  notes: string;
}

export type SimRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export type SimConvStatus = 'queued' | 'running' | 'judging' | 'completed' | 'failed' | 'cancelled';
export type SimEndedBy = 'persona' | 'max_turns' | 'empty_message' | 'cancelled';

interface SimRunBase {
  id: string;
  name: string;
  status: SimRunStatus;
  config: SimRunConfig;
  /** system id → snapshot hash it was pinned to. */
  systems: Record<string, string>;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** conversation status → count. */
  counts: Record<string, number>;
  /** The run task is going. */
  active: boolean;
  /** Username of whoever started it. */
  created_by?: string | null;
}

/** GET /api/simulations */
export interface SimRunSummary extends SimRunBase {
  mean_score: number | null;
}

/** One row of a run's conversations. */
export interface SimConversationRow {
  id: number;
  idx: number;
  system_id: string;
  scenario_id: string;
  persona_id: string;
  rep: number;
  status: SimConvStatus;
  chat_id: string | null;
  turns: number;
  ended_by: SimEndedBy | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  seconds: number;
  checks: Record<string, boolean> | null;
  score: number | null;
  expectation_score: number | null;
  judge_status: string | null;
}

/** GET /api/simulations/:id */
export interface SimRunDetail extends SimRunBase {
  conversations: SimConversationRow[];
  judging: boolean;
  definitions: {
    personas: Record<string, PersonaDef>;
    scenarios: Record<string, ScenarioDef>;
    rubric: RubricDef | null;
  };
}

export interface SimPlanEntry {
  system_id: string;
  scenario_id: string;
  persona_id: string;
  rep: number;
}

/** POST /api/simulations/plan */
export interface SimPlan {
  conversations: number;
  /** Upper bound of user turns over all conversations. */
  max_turns: number;
  problems: string[];
  judged: boolean;
  sample: SimPlanEntry[];
}

/** Mean with sd and 95% confidence interval. */
export interface Stats {
  n: number;
  mean: number;
  sd: number;
  ci95: [number, number];
}

export interface SimSystemSummary {
  system: string;
  snapshot: string | null;
  conversations: number;
  status: Record<string, number>;
  ended_by: Record<string, number>;
  score: Stats | null;
  expectation_score: Stats | null;
  check_recall: Stats | null;
  turns: Stats | null;
  seconds_per_turn: Stats | null;
  llm_calls: Stats | null;
  tokens: Stats | null;
  criteria: Record<string, Stats | null>;
  expectations: Record<string, Stats | null>;
  issues: Record<string, number>;
}

/** GET /api/simulations/:id/summary */
export interface SimSummary {
  run: string;
  rubric: string | null;
  /** Rubric ids judged in this run. */
  rubrics: string[];
  costs: { simulator: number; retrieval: number; judge: number };
  systems: SimSystemSummary[];
  /** system → scenario → score stats. */
  by_scenario: Record<string, Record<string, Stats | null>>;
}

export interface JudgedCriterion {
  key: string;
  title: string;
  score: number | null;
  min: number;
  max: number;
  weight: number;
  justification: string;
}

export interface JudgedExpectation {
  name: string;
  /** 0 absent, 1 named, 2 explained, 3 applied. */
  level: number;
  evidence: string;
}

export interface Judgment {
  id?: number;
  rubric_id: string;
  rubric?: RubricDef;
  model: string | null;
  status: 'completed' | 'failed' | string;
  score: number | null;
  expectation_score: number | null;
  result: { criteria?: JudgedCriterion[]; expectations?: JudgedExpectation[]; comment?: string } | null;
  error: string | null;
  cost: number | null;
  created_at: string;
}

export interface SimLlmUsage {
  calls: number;
  prompt_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  seconds?: number;
}

export interface SimChatMetrics {
  llm?: Record<string, SimLlmUsage>;
  llm_total?: SimLlmUsage;
  tools?: Record<string, number>;
  retrieval?: { calls: number; llm_calls: number; cost: number };
  events?: Record<string, number>;
}

export interface SimConvMetrics {
  turn_seconds?: number[];
  simulator?: { calls: number; cost: number; tokens: number };
  warnings?: string[];
  memory_copied?: number;
  chat?: SimChatMetrics;
  checks?: Record<string, boolean> | null;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  turn: number;
}

/** GET /api/simulations/conversations/:id */
export interface SimConversationDetail {
  id: number;
  run_id: string;
  idx: number;
  system_id: string;
  scenario_id: string;
  persona_id: string;
  rep: number;
  status: SimConvStatus;
  chat_id: string | null;
  profile_id: number | null;
  turns: number;
  ended_by: SimEndedBy | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  metrics: SimConvMetrics;
  run: { id: string; name: string; status: SimRunStatus; config: SimRunConfig; systems: Record<string, string> };
  transcript: TranscriptMessage[];
  judgments: Judgment[];
  scenario: ScenarioDef | null;
  persona: PersonaDef | null;
}

/** POST /api/simulations/preview-prompts */
export interface PromptPreview {
  simulator: string;
  judge?: string;
}

// ---------------------------------------------------------------------- team

export type Role = 'viewer' | 'editor' | 'admin';
export const ROLES: Role[] = ['viewer', 'editor', 'admin'];

/** An account (never the password hash). The local user (accounts off) has id null. */
export interface User {
  id: number | null;
  username: string;
  display_name: string;
  role: Role;
  must_change_password: boolean;
  disabled: boolean;
  created_at?: string;
  last_login?: string | null;
  /** Active sign-in sessions (GET /api/users). */
  sessions?: number;
}

/** GET /api/auth/status */
export interface AuthStatus {
  /** Accounts are on. */
  auth: boolean;
  user: User | null;
  /** No account exists yet. */
  setup_needed: boolean;
  /** …and this browser is on the server machine, so it may create the first admin. */
  setup_allowed: boolean;
}

/** Revision kinds (note memory_schemas with an underscore). */
export type DefKindName =
  | 'agents'
  | 'systems'
  | 'memory_schemas'
  | 'datasets'
  | 'retrievers'
  | 'personas'
  | 'scenarios'
  | 'rubrics'
  | 'classifiers'
  | 'fragments'
  | 'settings';

/** The `conflict` of a 409 from a write whose If-Match is stale. */
export interface ConflictInfo {
  kind: string;
  id: string;
  /** The version the write was based on. */
  expected: string;
  /** The stored version now (null when deleted). */
  version: string | null;
  deleted: boolean;
  updated_by: string | null;
  updated_at: string | null;
  /** The stored definition now (null when deleted). */
  current: Record<string, unknown> | null;
}

export type RevisionAction = 'save' | 'delete' | 'baseline' | 'external' | 'import';

export interface Revision {
  id: number;
  kind: DefKindName;
  item_id: string;
  version: string | null;
  action: RevisionAction;
  actor: string | null;
  ts: string;
  size?: number;
}

export interface RevisionDetail extends Revision {
  /** YAML (fragments: plain text). */
  content: string;
  /** The parsed definition (null for deletes); defaults are omitted. */
  data: Record<string, unknown> | null;
}

export interface PresenceEntry {
  username: string;
  display_name: string;
  editing: boolean;
  seconds_ago: number;
}

// ------------------------------------------------------------------- bundles

export type BundleKind =
  | 'memory_schemas'
  | 'fragments'
  | 'datasets'
  | 'retrievers'
  | 'agents'
  | 'systems'
  | 'classifiers'
  | 'personas'
  | 'scenarios'
  | 'rubrics';
export const BUNDLE_KINDS: BundleKind[] = [
  'systems',
  'agents',
  'classifiers',
  'memory_schemas',
  'fragments',
  'datasets',
  'retrievers',
  'personas',
  'scenarios',
  'rubrics',
];

export interface BundleRef {
  kind: BundleKind;
  id: string;
}

export interface BundlePlanItem extends BundleRef {
  name: string;
  reason: 'selected' | 'dependency';
  /** "kind/id" of what needs it. */
  required_by: string[];
  updated_at: string | null;
  updated_by: string | null;
}

/** POST /api/bundles/plan */
export interface BundlePlan {
  items: BundlePlanItem[];
  presets: string[];
  unknown_presets: string[];
  missing: { kind: string; id: string; required_by: string[] }[];
}

export type ImportStatus = 'new' | 'same' | 'changed' | 'invalid';

export interface ImportItem {
  key: string;
  kind: BundleKind;
  id: string;
  name: string;
  status: ImportStatus;
  error: string | null;
  bundle: { updated_at: string | null; updated_by: string | null };
  local: { updated_at: string | null; updated_by: string | null } | null;
  /** References to definitions in neither the bundle nor here. */
  unresolved: string[];
  default_action: string;
  /** Datasets: the bundle carries its contents. */
  has_data?: boolean;
  /** Datasets: items here now (replaced by an import with contents). */
  local_items?: number;
}

export interface ImportPreset {
  name: string;
  status: 'new' | 'same' | 'changed';
  spec: ModelSpec;
  default_action: string;
}

/** POST /api/bundles/import (and GET /api/bundles/import/:token) */
export interface ImportPreview {
  token: string;
  filename?: string;
  manifest: { sbf_version: string; exported_at: string; exported_by: string | null; warnings: string[] };
  items: ImportItem[];
  presets: ImportPreset[];
}

export interface ImportResult {
  items: { key: string; kind: BundleKind; id: string; target: string; action: string; ok: boolean; error?: string; items?: number }[];
  presets: { name: string; action: string; ok: boolean; error?: string }[];
}

// ---------------------------------------------------------------- chat links

export type ChatLinkStatus = 'active' | 'disabled' | 'expired' | 'full';

/** What a chat link's visitors get (every field has a server default). */
export interface ChatLinkSettings {
  /** Off: conversations live only in server memory while open. */
  save_transcripts: boolean;
  /** A memory profile per visitor (a cookie in their browser). */
  remember_visitors: boolean;
  /** Blank: the system's UI title, else its name. */
  title: string;
  /** null: the system's ui.welcome. */
  welcome: string | null;
  /** null: the system's ui.starters. */
  starters: string[] | null;
  notice: string;
  require_consent: boolean;
  /** ISO date/time. */
  expires_at: string | null;
  /** Messages per conversation. */
  max_turns: number;
  /** Conversations in total, all visitors. */
  max_conversations: number | null;
  /** Per visitor. */
  messages_per_minute: number;
  /** Unsaved conversations are erased after this long without a message. */
  idle_minutes: number;
}

export interface ChatLinkStats {
  conversations: number;
  visitors: number;
  turns: number;
  last_used: string | null;
  /** Unsaved conversations open in server memory now (GET /api/links/:id only). */
  live_unsaved?: number;
}

/** GET /api/links — a system published at a secret URL (/c/<token>). */
export interface ChatLink {
  id: string;
  token: string;
  /** "/c/<token>" */
  path: string;
  label: string;
  system_id: string;
  active: boolean;
  settings: ChatLinkSettings;
  has_access_code: boolean;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
  status: ChatLinkStatus;
  stats: ChatLinkStats;
}

/** POST /api/links (label, system_id required); PUT takes any of them. */
export interface ChatLinkBody {
  label?: string;
  system_id?: string;
  active?: boolean;
  settings?: ChatLinkSettings;
  /** PUT: null keeps it, "" removes it, a string sets it. */
  access_code?: string | null;
}

/** GET /api/links/:id/conversations (unsaved ones are counts only). */
export interface ChatLinkConversation {
  id: string;
  saved: boolean;
  /** Anonymous visitor id (8 characters). */
  visitor: string;
  /** The visitor has a memory profile. */
  remembered: boolean;
  started_at: string;
  last_at: string;
  turns: number;
  ended_at: string | null;
  ended_by: 'visitor' | 'idle' | null;
  consented_at: string | null;
  title: string | null;
  /** Saved ones: open them at /chat/<system_id>/<id>. */
  system_id: string | null;
  live: boolean;
}

// The standalone chat page's API (/api/public/<token>, no account).

/** GET /api/public/:token (while `needs_code`, only title, status and needs_code are sent) */
export interface PublicInfo {
  title: string;
  welcome: string;
  starters: string[];
  show_viewer: boolean;
  notice: string;
  require_consent: boolean;
  /** Transcripts are saved. */
  saving: boolean;
  /** Returning visitors are remembered. */
  remembers: boolean;
  max_turns: number;
  /** Unsaved conversations are erased after this many idle minutes. */
  idle_minutes?: number;
  status: 'active' | 'expired' | 'full' | 'unavailable';
  needs_code: boolean;
}

/** A visitor's conversation (GET /api/public/:token/conversations). */
export interface PublicConversation {
  id: string;
  title: string | null;
  turns: number;
  started_at: string;
  last_at: string;
  ended: boolean;
  saved: boolean;
  /** A reply is in progress (re-attach to its stream). */
  running: boolean;
}

interface PublicOutputBase {
  id?: number | null;
  turn: number | null;
  ts: string | null;
}

/** What the visitor sees of a conversation: no traces, no internal events. */
export type PublicOutput = PublicOutputBase &
  (
    | { type: 'user'; content: string }
    | { type: 'message'; content: string }
    | {
        type: 'file';
        resource_id: string;
        title: string;
        source_type: string;
        source_file: string;
        /** Already a public URL. */
        url: string;
        mime?: string | null;
        note: string;
        summary: string;
      }
    | {
        type: 'viewer';
        resource_id: string;
        lesson_id: string;
        title: string;
        section: string;
        /** A course page (with a #/lessons/... fragment). */
        url: string;
        note: string;
        summary: string;
      }
  );

export type PublicFileOutput = Extract<PublicOutput, { type: 'file' }>;
export type PublicViewerOutput = Extract<PublicOutput, { type: 'viewer' }>;

export interface PublicConversationDetail extends PublicConversation {
  outputs: PublicOutput[];
}

export type PublicStreamEvent =
  | { kind: 'turn_start'; turn: number }
  | ({ kind: 'output' } & PublicOutput)
  | { kind: 'turn_done'; turn?: number }
  | { kind: 'error'; message: string }
  | { kind: 'end' };
