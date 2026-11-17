// Typed client for the SBF backend (/api). Non-2xx responses throw ApiError,
// which carries the JSON body's `detail`, `problems` and (409 on a stale
// If-Match) `conflict`. A 401 anywhere but the sign-in calls reports to the
// handler the auth gate installs, which shows the sign-in page.

import type {
  AgentDef,
  AgentDetail,
  AgentSummary,
  AuthStatus,
  BundlePlan,
  BundleRef,
  Chat,
  ChatDetail,
  ChatLink,
  ChatLinkBody,
  ChatLinkConversation,
  ClassifierDef,
  ClassifierStatus,
  ClassifierSummary,
  ConflictInfo,
  DefKindName,
  DatasetDef,
  DatasetDetail,
  DatasetSummary,
  EntriesResult,
  ExtractPreview,
  Fragment,
  HistoryMessage,
  ImportPreview,
  ImportResult,
  IndexStatus,
  ItemDetail,
  ItemsPage,
  KnowledgeBackend,
  Library,
  MemoryNote,
  MemorySchema,
  MemorySchemaSummary,
  MemoryTemplateInfo,
  Meta,
  ModelSpec,
  NotesPage,
  PersonaDef,
  PersonaSummary,
  PresenceEntry,
  PreviewRequest,
  PreviewResult,
  ProcessMode,
  Profile,
  PromptPreview,
  RagMeta,
  RetrieverDef,
  RetrieverSummary,
  Revision,
  RevisionDetail,
  Role,
  RubricDef,
  RunRequest,
  RunResult,
  SafetyMeta,
  ScenarioDef,
  Settings,
  SimConversationDetail,
  SimPlan,
  SimRunConfig,
  SimRunDetail,
  SimRunSummary,
  SimSummary,
  StoredTrace,
  SystemDef,
  SystemSummary,
  ToolInfo,
  UploadResult,
  User,
  ValidateResult,
  Verdict,
  WizardAnswers,
  WizardDraft,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  /** Raw `detail` from the body: a string, a list of strings, or FastAPI's validation objects. */
  readonly detail: unknown;
  /** `problems` from a CompileError (422). */
  readonly problems: string[];
  /** Human-readable lines derived from detail + problems. */
  readonly lines: string[];
  /** 409 from a write whose If-Match is no longer current (other 409s have none). */
  readonly conflict: ConflictInfo | null;

  constructor(status: number, detail: unknown, problems: string[], conflict: ConflictInfo | null = null) {
    const lines = [...formatDetail(detail), ...problems];
    super(lines.length ? lines.join('\n') : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.problems = problems;
    this.lines = lines.length ? lines : [`HTTP ${status}`];
    this.conflict = conflict;
  }
}

/** The version conflict of a failed save, if that is why it failed. */
export function conflictOf(err: unknown): ConflictInfo | null {
  return err instanceof ApiError && err.status === 409 ? err.conflict : null;
}

// ------------------------------------------------------------------ sign-in

export type AuthProblem = 'signed-out' | 'password';
let authHandler: ((problem: AuthProblem) => void) | null = null;

/** Installed by the auth gate: called when a request needs signing in (again). */
export function setAuthHandler(fn: ((problem: AuthProblem) => void) | null): void {
  authHandler = fn;
}

/** Paths whose 401 / 403 is the answer itself (a wrong password), not a lost session. */
const AUTH_QUIET = new Set(['/auth/login', '/auth/setup', '/auth/status', '/auth/password']);

function noteAuth(res: Response, path: string, detail: unknown): void {
  if (!authHandler || AUTH_QUIET.has(path.split('?')[0])) return;
  if (res.status === 401) authHandler('signed-out');
  else if (res.status === 403 && typeof detail === 'string' && detail.startsWith('Change your temporary password')) authHandler('password');
}

function formatDetail(detail: unknown): string[] {
  if (detail == null) return [];
  if (typeof detail === 'string') return [detail];
  if (Array.isArray(detail)) {
    return detail.map((d) => {
      // Model-level validator errors have an empty location (": Value error, …").
      if (typeof d === 'string') return d.replace(/^:\s*/, '');
      if (d && typeof d === 'object' && 'msg' in d) {
        const o = d as { loc?: unknown[]; msg: unknown };
        const loc = Array.isArray(o.loc) ? o.loc.filter((p) => p !== 'body').join('.') : '';
        return loc ? `${loc}: ${String(o.msg)}` : String(o.msg);
      }
      return JSON.stringify(d);
    });
  }
  return [JSON.stringify(detail)];
}

/** Error lines for display, for any thrown value. */
export function errorLines(err: unknown): string[] {
  if (err instanceof ApiError) return err.lines;
  if (err instanceof Error) return [err.message];
  return [String(err)];
}

async function toError(res: Response, path: string): Promise<ApiError> {
  let detail: unknown = null;
  let problems: string[] = [];
  let conflict: ConflictInfo | null = null;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as { detail?: unknown; problems?: unknown; conflict?: unknown };
      detail = b.detail ?? null;
      if (Array.isArray(b.problems)) problems = b.problems.map(String);
      if (b.conflict && typeof b.conflict === 'object') conflict = b.conflict as ConflictInfo;
    }
  } catch {
    detail = res.statusText || null;
  }
  noteAuth(res, path, detail);
  return new ApiError(res.status, detail, problems, conflict);
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** Chats and profiles: one's own, or everyone's (editors and admins). */
export type Scope = 'mine' | 'all';

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface RequestOptions {
  signal?: AbortSignal;
  /** The version a write is based on (If-Match header); null/undefined: unconditional. */
  ifMatch?: string | null;
  /** Survives page unload (presence "leaving"). */
  keepalive?: boolean;
}

async function send(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
    keepalive: opts.keepalive,
  });
  if (!res.ok) throw await toError(res, path);
  return res;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const res = await send(method, path, body, opts);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(path: string, query?: Query) => request<T>('GET', withQuery(path, query));
const post = <T>(path: string, body: unknown) => request<T>('POST', path, body);
const put = <T>(path: string, body: unknown, ifMatch?: string | null) => request<T>('PUT', path, body, { ifMatch });
const del = <T = { ok: boolean }>(path: string, ifMatch?: string | null) => request<T>('DELETE', path, undefined, { ifMatch });

/** Multipart upload; the browser sets the Content-Type (with its boundary). */
async function upload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, { method: 'POST', body: form });
  if (!res.ok) throw await toError(res, path);
  return (await res.json()) as T;
}

/** A file download answering a POST: the blob and the server's file name. */
async function download(path: string, body: unknown): Promise<{ blob: Blob; filename: string | null }> {
  const res = await send('POST', path, body);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  const filename = m ? decodeURIComponent(m[1] ?? m[2]) : null;
  return { blob: await res.blob(), filename };
}

/** Opens a streaming (SSE) response; throws ApiError on non-2xx. */
async function stream(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json', Accept: 'text/event-stream' } : { Accept: 'text/event-stream' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) throw await toError(res, path);
  return res;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => get<Meta>('/meta'),
  tools: () => get<ToolInfo[]>('/tools'),

  settings: {
    get: () => get<Settings>('/settings'),
    put: (s: Settings, ifMatch?: string | null) => put<Settings>('/settings', s, ifMatch),
  },

  // Writes take the version the edit is based on (If-Match); without it they are unconditional.
  agents: {
    list: () => get<AgentSummary[]>('/agents'),
    get: (id: string) => get<AgentDetail>(`/agents/${enc(id)}`),
    create: (a: AgentDef) => post<AgentDef>('/agents', a),
    update: (id: string, a: AgentDef, ifMatch?: string | null) => put<AgentDef>(`/agents/${enc(id)}`, a, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/agents/${enc(id)}`, ifMatch),
  },

  systems: {
    list: () => get<SystemSummary[]>('/systems'),
    get: (id: string) => get<SystemDef>(`/systems/${enc(id)}`),
    create: (s: SystemDef) => post<SystemDef>('/systems', s),
    update: (id: string, s: SystemDef, ifMatch?: string | null) => put<SystemDef>(`/systems/${enc(id)}`, s, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/systems/${enc(id)}`, ifMatch),
    validate: (id: string, draft: SystemDef | null) =>
      post<ValidateResult>(`/systems/${enc(id)}/validate`, { draft }),
    preview: (id: string, body: PreviewRequest) => post<PreviewResult>(`/systems/${enc(id)}/preview`, body),
  },

  safety: {
    /** Each provider's defaults and categories, and the guard actions. */
    meta: () => get<SafetyMeta>('/safety/meta'),
  },

  classifiers: {
    list: () => get<ClassifierSummary[]>('/classifiers'),
    get: (id: string) => get<ClassifierSummary>(`/classifiers/${enc(id)}`),
    create: (c: ClassifierDef) => post<ClassifierSummary>('/classifiers', c),
    update: (id: string, c: ClassifierDef, ifMatch?: string | null) => put<ClassifierSummary>(`/classifiers/${enc(id)}`, c, ifMatch),
    /** 409 while a system's guards use it. */
    remove: (id: string, ifMatch?: string | null) => del(`/classifiers/${enc(id)}`, ifMatch),
    /**
     * Classifies the last message (a saved classifier or a draft). A draft
     * nemo_guardrails classifier still runs the saved rails config.
     */
    test: (body: { classifier?: string; draft?: ClassifierDef; messages: { role: 'user' | 'assistant'; content: string }[] }) =>
      post<Verdict>('/classifiers/test', body),
    /** Whether its service answers (safer and nemo_guardrails). */
    status: (id: string) => get<ClassifierStatus>(`/classifiers/${enc(id)}/status`),
  },

  /** The setup wizard: answers → new agents, classifier and system (editors). */
  wizard: {
    /** What would be created, with problems and warnings (nothing is saved). */
    draft: (answers: WizardAnswers) => post<WizardDraft>('/wizard/draft', answers),
    /** All or nothing; 400 with the problems. */
    create: (answers: WizardAnswers) => post<WizardDraft>('/wizard/create', answers),
  },

  fragments: {
    list: () => get<Fragment[]>('/fragments'),
    put: (id: string, text: string, ifMatch?: string | null) => put<Fragment>(`/fragments/${enc(id)}`, { text }, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/fragments/${enc(id)}`, ifMatch),
  },

  memorySchemas: {
    list: () => get<MemorySchemaSummary[]>('/memory-schemas'),
    get: (id: string) => get<MemorySchema>(`/memory-schemas/${enc(id)}`),
    put: (id: string, data: unknown, ifMatch?: string | null) => put<MemorySchema>(`/memory-schemas/${enc(id)}`, data, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/memory-schemas/${enc(id)}`, ifMatch),
  },

  /** Libraries of a knowledge backend (default: the settings default). */
  libraries: (backend?: KnowledgeBackend) => get<Library[]>('/knowledge/libraries', { backend }),

  datasets: {
    list: () => get<DatasetSummary[]>('/datasets'),
    get: (id: string) => get<DatasetDetail>(`/datasets/${enc(id)}`),
    create: (d: Partial<DatasetDef> & { id: string }) => post<DatasetSummary>('/datasets', d),
    update: (id: string, d: DatasetDef, ifMatch?: string | null) => put<DatasetSummary>(`/datasets/${enc(id)}`, d, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/datasets/${enc(id)}`, ifMatch),
    upload: (id: string, files: File[]) => {
      const form = new FormData();
      for (const f of files) form.append('files', f, f.name);
      return upload<UploadResult>(`/datasets/${enc(id)}/files`, form);
    },
    removeFile: (id: string, fileId: number) => del(`/datasets/${enc(id)}/files/${fileId}`),
    rawUrl: (id: string, fileId: number) => `/api/datasets/${enc(id)}/files/${fileId}/raw`,
    process: (id: string, body: { mode: ProcessMode; file_ids?: number[]; only_stale?: boolean }) =>
      post<{ queued: number }>(`/datasets/${enc(id)}/process`, body),
    items: (id: string, q: { q?: string; file_id?: number; limit?: number; offset?: number }) =>
      get<ItemsPage>(`/datasets/${enc(id)}/items`, q),
    item: (id: string, itemId: number) => get<ItemDetail>(`/datasets/${enc(id)}/items/${itemId}`),
    updateItem: (id: string, itemId: number, body: { title?: string; fields?: Record<string, unknown> }, ifMatch?: string | null) =>
      put<ItemDetail>(`/datasets/${enc(id)}/items/${itemId}`, body, ifMatch),
    itemFileUrl: (id: string, itemId: number) => `/api/datasets/${enc(id)}/items/${itemId}/file`,
    /** Runs field extraction on one item with the draft definition (one LLM call; nothing is saved). */
    extractPreview: (id: string, itemId: number, draft?: DatasetDef) =>
      post<ExtractPreview>(`/datasets/${enc(id)}/extract-preview`, { item_id: itemId, draft }),
  },

  rag: {
    meta: () => get<RagMeta>('/rag/meta'),
  },

  retrievers: {
    list: () => get<RetrieverSummary[]>('/retrievers'),
    get: (id: string) => get<RetrieverSummary>(`/retrievers/${enc(id)}`),
    create: (r: Partial<RetrieverDef> & { id: string }) => post<RetrieverDef>('/retrievers', r),
    update: (id: string, r: RetrieverDef, ifMatch?: string | null) => put<RetrieverDef>(`/retrievers/${enc(id)}`, r, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/retrievers/${enc(id)}`, ifMatch),
    /** Builds (embeds) the index; slow the first time a local embedder loads. */
    index: (id: string, draft?: RetrieverDef) => post<IndexStatus>(`/retrievers/${enc(id)}/index`, { draft }),
    /** What the mapping produces: the first entries, as searched and shown. */
    entries: (id: string, draft: RetrieverDef | undefined, limit = 20) =>
      post<EntriesResult>(`/retrievers/${enc(id)}/entries`, { draft, limit }),
    run: (body: RunRequest, signal?: AbortSignal) => request<RunResult>('POST', '/retrievers/run', body, { signal }),
  },

  profiles: {
    /** Own profiles, or everyone's (`all`: editors and admins). */
    list: (scope: Scope = 'mine') => get<Profile[]>('/profiles', { scope }),
    create: (name: string) => post<Profile>('/profiles', { name }),
    remove: (id: number) => del(`/profiles/${id}`),
  },

  chats: {
    /** Own chats, or everyone's (`all`: editors and admins). */
    list: (systemId?: string, limit = 100, scope: Scope = 'mine') => get<Chat[]>('/chats', { system_id: systemId, limit, scope }),
    create: (systemId: string, profileId: number | null) =>
      post<Chat>('/chats', { system_id: systemId, profile_id: profileId }),
    get: (id: string) => get<ChatDetail>(`/chats/${enc(id)}`),
    remove: (id: string) => del(`/chats/${enc(id)}`),
    traces: (id: string, turn?: number) => get<StoredTrace[]>(`/chats/${enc(id)}/traces`, { turn }),
    history: (id: string) => get<HistoryMessage[]>(`/chats/${enc(id)}/history`),
    exportData: (id: string) => get<Record<string, unknown>>(`/chats/${enc(id)}/export`),
    /** Starts a turn; the response body is its SSE event stream. */
    send: (id: string, text: string, signal?: AbortSignal) =>
      stream('POST', `/chats/${enc(id)}/messages`, { text }, signal),
    /** Re-attaches to a running turn (replays its events so far). */
    attach: (id: string, signal?: AbortSignal) => stream('GET', `/chats/${enc(id)}/stream`, undefined, signal),
  },

  snapshot: (hash: string) => get<Record<string, unknown>>(`/snapshots/${enc(hash)}`),

  /** Chat links: a system at a secret URL for visitors without an account (editors). */
  links: {
    list: (systemId?: string) => get<ChatLink[]>('/links', { system_id: systemId }),
    get: (id: string) => get<ChatLink>(`/links/${enc(id)}`),
    create: (body: ChatLinkBody & { label: string; system_id: string }) => post<ChatLink>('/links', body),
    update: (id: string, body: ChatLinkBody) => put<ChatLink>(`/links/${enc(id)}`, body),
    /** A new URL: the old one stops working and its visitors start afresh. */
    rotate: (id: string) => post<ChatLink>(`/links/${enc(id)}/rotate`, {}),
    /** Deletes the link, its saved conversations and its visitors' memory profiles. */
    remove: (id: string) => del<{ ok: boolean; conversations: number; profiles: number }>(`/links/${enc(id)}`),
    conversations: (id: string) => get<ChatLinkConversation[]>(`/links/${enc(id)}/conversations`),
  },

  personas: {
    list: () => get<PersonaSummary[]>('/personas'),
    get: (id: string) => get<PersonaSummary>(`/personas/${enc(id)}`),
    create: (p: PersonaDef) => post<PersonaSummary>('/personas', p),
    update: (id: string, p: PersonaDef, ifMatch?: string | null) => put<PersonaSummary>(`/personas/${enc(id)}`, p, ifMatch),
    /** 409 while scenarios use it as their default persona. */
    remove: (id: string, ifMatch?: string | null) => del(`/personas/${enc(id)}`, ifMatch),
  },

  scenarios: {
    list: () => get<ScenarioDef[]>('/scenarios'),
    get: (id: string) => get<ScenarioDef>(`/scenarios/${enc(id)}`),
    create: (s: ScenarioDef) => post<ScenarioDef>('/scenarios', s),
    update: (id: string, s: ScenarioDef, ifMatch?: string | null) => put<ScenarioDef>(`/scenarios/${enc(id)}`, s, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/scenarios/${enc(id)}`, ifMatch),
  },

  rubrics: {
    list: () => get<RubricDef[]>('/rubrics'),
    get: (id: string) => get<RubricDef>(`/rubrics/${enc(id)}`),
    create: (r: RubricDef) => post<RubricDef>('/rubrics', r),
    update: (id: string, r: RubricDef, ifMatch?: string | null) => put<RubricDef>(`/rubrics/${enc(id)}`, r, ifMatch),
    remove: (id: string, ifMatch?: string | null) => del(`/rubrics/${enc(id)}`, ifMatch),
  },

  simulations: {
    list: () => get<SimRunSummary[]>('/simulations'),
    /** Conversation scores come from `rubric` (default: the run's own). */
    get: (id: string, rubric?: string | null) =>
      get<SimRunDetail>(`/simulations/${enc(id)}${rubric ? `?rubric=${enc(rubric)}` : ''}`),
    /** What a config would run (count, turn bound, problems) without starting it. */
    plan: (c: SimRunConfig) => post<SimPlan>('/simulations/plan', c),
    /** Starts the run immediately (real LLM calls). */
    start: (c: SimRunConfig) => post<SimRunDetail>('/simulations', c),
    cancel: (id: string) => post<SimRunDetail>(`/simulations/${enc(id)}/cancel`, {}),
    /** Re-runs failed / cancelled conversations (409 while the run is going). */
    retry: (id: string, conversationIds?: number[]) =>
      post<{ retried: number }>(`/simulations/${enc(id)}/retry`, { conversation_ids: conversationIds }),
    /** Grades finished conversations with a rubric in the background (409 while already judging). */
    judge: (id: string, body: { rubric: string; conversation_ids?: number[]; model?: ModelSpec | null }) =>
      post<{ judging: number }>(`/simulations/${enc(id)}/judge`, body),
    remove: (id: string) => del(`/simulations/${enc(id)}`),
    summary: (id: string, rubric?: string | null) => get<SimSummary>(`/simulations/${enc(id)}/summary`, { rubric }),
    exportUrl: (id: string, format: 'jsonl' | 'csv', full: boolean, rubric?: string | null) =>
      withQuery(`/api/simulations/${enc(id)}/export`, { format, full, rubric }),
    conversation: (convId: number) => get<SimConversationDetail>(`/simulations/conversations/${convId}`),
    /** The simulator's (and judge's) prompt; drafts allowed so unsaved edits preview. */
    previewPrompts: (body: {
      persona: string | Partial<PersonaDef>;
      scenario: string | Partial<ScenarioDef>;
      rubric?: string | Partial<RubricDef> | null;
    }) => post<PromptPreview>('/simulations/preview-prompts', body),
  },

  auth: {
    status: () => get<AuthStatus>('/auth/status'),
    login: (username: string, password: string) => post<User>('/auth/login', { username, password }),
    /** The first admin (only while no account exists, from the server's machine). */
    setup: (body: { username: string; password: string; display_name: string }) =>
      post<User & { adopted: { chats: number; profiles: number } }>('/auth/setup', body),
    logout: () => post<{ ok: boolean }>('/auth/logout', {}),
    me: () => get<User>('/auth/me'),
    updateMe: (display_name: string) => put<User>('/auth/me', { display_name }),
    changePassword: (current_password: string, new_password: string) =>
      post<{ ok: boolean; other_sessions_ended: number }>('/auth/password', { current_password, new_password }),
  },

  /** Accounts (admins). */
  users: {
    list: () => get<User[]>('/users'),
    create: (body: { username: string; password: string; role: Role; display_name: string; must_change_password: boolean }) =>
      post<User>('/users', body),
    update: (id: number, body: { display_name?: string; role?: Role; disabled?: boolean }) => put<User>(`/users/${id}`, body),
    /** Sets a (by default temporary) password and signs them out everywhere. */
    resetPassword: (id: number, password: string, must_change_password = true) =>
      post<User>(`/users/${id}/password`, { password, must_change_password }),
    signOut: (id: number) => post<{ ended: number }>(`/users/${id}/sign-out`, {}),
    remove: (id: number) => del(`/users/${id}`),
  },

  revisions: {
    list: (kind: DefKindName, id: string, limit = 100) => get<Revision[]>(`/revisions/${kind}/${enc(id)}`, { limit }),
    get: (kind: DefKindName, id: string, revId: number) => get<RevisionDetail>(`/revisions/${kind}/${enc(id)}/${revId}`),
    recent: (limit = 50, actor?: string) => get<Revision[]>('/revisions', { limit, actor }),
  },

  /** Heartbeat of an open editor: who else has `resource` open. */
  presence: (resource: string, editing: boolean, leaving = false) =>
    request<{ others: PresenceEntry[] }>('POST', '/presence', { resource, editing, leaving }, { keepalive: leaving }),

  bundles: {
    plan: (items: BundleRef[], dependencies: boolean) => post<BundlePlan>('/bundles/plan', { items, dependencies }),
    /** The zip (a download). */
    export: (items: BundleRef[], dependencies: boolean, dataset_data: boolean) =>
      download('/bundles/export', { items, dependencies, dataset_data }),
    upload: (file: File) => {
      const form = new FormData();
      form.append('file', file, file.name);
      return upload<ImportPreview>('/bundles/import', form);
    },
    preview: (token: string) => get<ImportPreview>(`/bundles/import/${enc(token)}`),
    compare: (token: string, kind: string, id: string) =>
      get<{ bundle: Record<string, unknown> | null; local: Record<string, unknown> | null; error: string | null }>(
        `/bundles/import/${enc(token)}/items/${kind}/${enc(id)}`,
      ),
    /** Consumes the token. */
    apply: (token: string, body: { actions: Record<string, string>; presets: Record<string, string>; import_data: boolean }) =>
      post<ImportResult>(`/bundles/import/${enc(token)}/apply`, body),
    discard: (token: string) => del(`/bundles/import/${enc(token)}`),
  },

  memory: {
    templates: (systemId: string) => get<Record<string, MemoryTemplateInfo>>(`/memory/${enc(systemId)}/templates`),
    notes: (systemId: string, q: { profile_id: number; q?: string; template?: string; limit?: number; offset?: number }) =>
      get<NotesPage>(`/memory/${enc(systemId)}/notes`, q),
    snapshot: (systemId: string, profileId: number) =>
      get<{ block: string }>(`/memory/${enc(systemId)}/snapshot`, { profile_id: profileId }),
    add: (systemId: string, profileId: number, template: string, slots: Record<string, unknown>) =>
      post<{ id: number; template: string; rendered: string }>(`/memory/${enc(systemId)}/notes`, {
        profile_id: profileId,
        template,
        slots,
      }),
    update: (systemId: string, noteId: number, slots: Record<string, unknown>) =>
      put<MemoryNote>(`/memory/${enc(systemId)}/notes/${noteId}`, { slots }),
    remove: (systemId: string, noteId: number) => del(`/memory/${enc(systemId)}/notes/${noteId}`),
  },
};
