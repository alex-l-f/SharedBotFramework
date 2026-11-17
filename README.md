# SharedBotFramework

Assemble, run and study multi-agent systems (MAS) built on Google's
[Agent Development Kit](https://google.github.io/adk-docs/) (ADK), from a web UI.

The aim is a small set of **core agents** (coaching, memory, research, teaching, …)
that are defined once, deployed into different **systems**, and evaluated as the same
agents across tasks. The first system is a faithful port of the BotBase R2MR coaching bot.

| Area | What it holds | Status |
|---|---|---|
| **Agents** | Reusable agents: prompt, tools (with per-binding config), model, limits | done |
| **Systems (MAS)** | Nodes (agent instances + system-specific prompt/tool/mode overrides), links between them, which node faces the user, fragments, memory, UI | done |
| **Chat** | Per-system chat UI: markdown, files/players, side viewer, profiles, live per-agent debug panes, export | done |
| **Memory** | Privacy-preserving template memory, schema-driven, per system namespace | done |
| **RAG Data** | Datasets (uploads → extraction pipeline → items + chunks), retrievers (the search layer), RAG tools and context injection | done |
| **Simulations** | Personas, scenarios and rubrics; single or batch runs of LLM-simulated users against systems; LLM judge + deterministic checks; per-system summaries; JSONL/CSV export | done |
| **Team use** | Accounts and roles, owned chats/profiles, conflict-safe saving with merge, revision history, presence, export/import bundles | done |
| **Safety** | Configurable classifiers (MIRA's SAFER, NVIDIA NeMo Guardrails and NemoGuard, Qwen3Guard, LLM judge, keyword rules) attached to nodes as input/output guards | done |
| **Setup wizard** | A guided, optional way to create agents and a system (helpers, knowledge, memory, safety, chat page), refined afterwards in the full editors | done |
| **Chat links** | A system at a secret URL for end users without accounts: standalone chat page; per link transcripts kept or not, remembered visitors, notice/consent, access code, expiry, limits | done |

## Quick start

```bash
# 1. Python env (inherits the ML stack from the conda env, like BotBase)
E:\conda_envs\ai\python.exe -m venv --system-site-packages venv
venv\Scripts\python -m pip install -r requirements.txt

# 2. API keys
copy .env.example .env      # set OPENROUTER_API_KEY

# 3. (BotBase port) definitions, then its libraries as datasets
venv\Scripts\python scripts\import_botbase.py
venv\Scripts\python scripts\import_botbase_datasets.py
venv\Scripts\python scripts\import_botbase_sims.py        # personas, scenarios, rubrics
#    r2mr-coach itself still searches through BotBase's embedding service on :8201:
..\BotBase\venv\Scripts\python scripts\run_botbase_embedding.py

# 4. Web UI
cd frontend && npm install && npm run build && cd ..

# 5. Server → http://127.0.0.1:5600 (on first visit from this machine, create the admin account)
venv\Scripts\python run.py            # --reload for development (from a console window:
                                      # on Windows the reloader stops the server with Ctrl+C)
```

`SBF_AUTH=off` in the environment turns accounts off (single-user development: every
request acts as a local admin). See [Team use](#team-use).

Frontend development: `cd frontend && npm run dev` (Vite on :5173, proxies `/api` and `/scorm` to :5600).

Terminal client (smoke tests): `venv\Scripts\python scripts\chat_cli.py r2mr-coach --profile "Test" --trace "I'm stressed"`.

Tests (offline, scripted fake LLM): `venv\Scripts\python -m pytest tests`.

## Concepts

### Agents (`workspace/agents/<id>.yaml`)
An agent is a prompt, a list of **tool bindings**, a model spec and limits. It knows nothing
about the systems it is deployed in, so the same `coach` can run in several systems.

- `reply_mode: text` — when the agent talks to the user, its visible text *is* the reply
  (`send_message` / `finish_turn` stay available). `tool` — only `send_message` reaches the user.
- `model` — a preset from `settings.yaml` plus optional overrides (provider, model,
  reasoning effort, sampling). Presets can build on other presets (`helper: {preset: default,
  reasoning_effort: low}`).
- A **tool binding** = registered tool id + config (validated against the tool's config schema)
  + optional function-name/description override, per-run call `budget`, `result_cap`.

### Systems (`workspace/systems/<id>.yaml`)
- **Nodes** — agent instances. A node can override the agent's model, add system-specific
  tools, override tool config (`tool_config`), wrap the agent's prompt in a
  `prompt_template`, define **modes**, and `inject_memory`.
- **Links**
  - `delegate` — the source gets a tool (e.g. `ask_library`) that runs the target in an
    isolated session and returns the target's **terminal-tool** result (agent-as-tool).
    Request built from a Jinja `request_template`; optional `require_state` preconditions.
  - `handoff` — the source can transfer the conversation to the target (ADK
    `transfer_to_agent`); the target becomes user-facing. Handoffs form a tree from the entry.
  - `observe` — the target runs after each completed turn on that turn's transcript
    (e.g. memory extraction), after the user already has their reply.
- **Entry** — the node that talks to the user.
- **Modes** — context variants of a node: each has a prompt block and the session `state` it
  sets (e.g. `library: coping_stress`). The `switch_mode` tool moves between them; the
  instruction is re-rendered on every model call, so a switch applies mid-turn.
- **Fragments** — reusable prompt text: shared (`workspace/fragments/*.md`) or per system.

### Prompts are Jinja templates
A node's instruction = `prompt_template` (default `{{ agent_prompt }}`) + reply note
(user-facing text agents) + memory snapshot (`inject_memory`) + retrieved context. Variables:
`agent_prompt`, `mode` (`id/label/description/prompt`), `modes`, `state`, `vars`,
`fragments.<id>`, `system`, `node`, `agent`, `turn.user_message`, `context.<name>`, `now`. The system editor's
**Preview prompt** shows the exact text for any node and mode.

### Terminal tools
Tools flagged `terminal` (`return_summary`, `record_memories`, `return_result`) are output
contracts: an accepted call ends the agent's run and becomes its result. A delegate or
observer that ends without one is reminded once (`nudge`), then the tool's fallback result
stands in — the caller always gets the same shape.

### Runtime data (`data/`)
- `sessions.db` — ADK's persistent sessions (the model-side history and state of each chat).
- `sbf.db` — `chats`, `outputs` (the transcript as the user saw it), `traces` (every model
  call, tool call/result, spawn, retrieval — the analysis corpus), `snapshots` (the resolved
  definitions each turn ran on, by content hash), `profiles`, `memories`.
- `sbf.db` also holds `sim_runs`, `sim_conversations`, `sim_judgments` (simulations), `users`,
  `auth_sessions` and `revisions` (every saved version of every definition).
- `datasets/<id>/` — uploaded files and `dataset.db` (files, items, sections, chunks).
- `embeddings.db` — the embedding cache.

Every turn records the hash of the exact system/agents/fragments/models it ran on, so any
transcript can be traced back to its configuration even after the definitions change.
`GET /api/chats/{id}/export` bundles transcript, traces, model history and snapshots.

## Adding a tool

Create a module in `sbf/tools/builtin/` (core) or `workspace/plugins/` (project-specific):

```python
from pydantic import BaseModel, Field
from sbf.tools import Tool, ToolContext, register

class WeatherConfig(BaseModel):
    units: str = Field("metric", description="metric or imperial")

@register
class Weather(Tool):
    id = "get_weather"
    category = "utility"
    description = "Current weather for a city."
    parameters = {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    Config = WeatherConfig            # rendered as a form in the agent editor

    async def run(self, args: dict, ctx: ToolContext):
        ...                            # ctx.state, ctx.emit("file", {...}), ctx.resources, ctx.trace(...)
        return {"city": args["city"], "temp": 21, "units": self.config.units}
```

It is discovered at startup and appears in the tool catalog. `ToolContext` gives tools the
session state, the user-facing output channel (`emit`, `deliver_message`), retrieved
resources, the trace, `finish()` (terminal tools) and the compiled system/node.

## The BotBase port

`scripts/import_botbase.py` generates the R2MR definitions from BotBase's own prompt modules
and memory registry, then verifies that every mode's rendered instruction is identical to the
prompt BotBase builds (`r2mr-coach` = BotBase `multi`, `r2mr-single` = BotBase `single`):

| BotBase | Here |
|---|---|
| coach `LlmAgent` + topic profiles + `switch_mode` | `coach` agent; node with 6 modes (router + 5 topics), each setting `state.library` |
| `COACH_ROLE`, `TONE`, router overlay | shared fragments `r2mr_*`; composed by the coach node's `prompt_template` |
| `ask_library` → summarizer sub-run | `delegate` link coach → summarizer (`library_summarizer` agent, budgets 6 search / 5 examine) |
| memory agent after each turn | `observe` link coach → memory (`memory_keeper` agent, `record_memories`) |
| `memory_templates.py` | `workspace/memory_schemas/r2mr.yaml` (vocabularies, templates, Jinja renderers) |
| `memory.db` profiles/notes/trace_log | `sbf.db` profiles / memories (namespace `r2mr`) / traces |
| `/api/file/...`, `/scorm/...` | `/api/knowledge/{library}/files/{id}`, `/scorm/...` (paths in `settings.yaml`) |
| `processed_resources/<lib>` + embedding service | datasets `<lib>` (`import_botbase_datasets.py`) |
| `rag_lab` retrievers | retriever methods/presentations (hybrid, facets, catalog, map-reduce brief) |
| polling `get-messages` | SSE stream per turn |

`scripts/import_botbase_datasets.py` imports BotBase's five processed libraries as datasets
(same ids, item ids, fields and chunks; files linked in place), three retrievers and two
systems to compare with `r2mr-coach`:

- `r2mr-coach-datasets` — `r2mr-coach` with its library tools on the datasets backend instead
  of the embedding service (node `tool_config` overrides `backend: datasets`). On test queries
  the two return 7–8 of the same top 8 resources.
- `r2mr-coach-catalog` — that, plus the `r2mr-catalog` retriever's material injected into the
  coach's instruction in topic modes (rag_lab's "inject" delivery).

## RAG data

Three layers, each in the web UI under **Data**:

```
files ──► dataset ──► items (+ fields) ──► chunks ──► retriever ──► agent
         extraction pipeline                          method +      rag_search tool, or
                                                      presentation  context injected into a node
```

### Datasets (`workspace/datasets/<id>.yaml`, content in `data/datasets/<id>/`)
A dataset is a resource repository plus **what to extract** from it:

- **Fields** — name, type (`text`, `long_text`, `list`, `enum`, `number`, `boolean`),
  description (the extractor's instructions), options, required. An LLM fills them per
  document as JSON; replies are type-checked and retried once; *Test extraction* runs a draft
  on one item without saving. Changing fields marks extracted items **stale** (re-extract
  only those, from stored text — files are not re-read).
- **Pipeline** (background workers, progress per file): convert (txt, md, html, pdf, docx,
  pptx, vtt/srt; csv/tsv/json/jsonl/xlsx → one item per row with the row as its fields) →
  **vision** (photos, scanned PDF pages, image-only slides are read by a vision model when
  enabled; the default model reads images) → field extraction → chunking (sections packed to
  `chunk_chars` with overlap, plus a summary chunk of title + fields).
- Audio/video files are stored and deliverable but not transcribed; upload a transcript.
- Item ids are stable across reprocessing (citations and memory notes keep working).

### Retrievers (`workspace/retrievers/<id>.yaml`)
The search layer between datasets and agents — the thing to compare:

| Part | Options |
|---|---|
| **Sources** | one or more datasets; `where` filters (source_type, file, any field); per-source mapping overrides |
| **Mapping** | Jinja over `item` / `chunk` → `title`, `text` (shown), `index_text` (searched), `chunk_text`, `chunk_index_text`, `url`: map dataset features to RAG fields, or pass items as raw JSON (presentation `json`) |
| **Unit** | `chunks`, `items`, `items+chunks` |
| **Method** | `hybrid` (dense + BM25, RRF, `max_per_item`), `facets` (an LLM lists the angles of the situation; coverage selection), `catalog` (an LLM picks items from a one-line catalog), `all` (everything in scope) |
| **Presentation** | `passages` (numbered, with item ids), `json`, `template` (your Jinja), `brief` (an LLM brief for the situation; map-reduce in batches when large) |

`all` + `brief` is rag_lab's map-reduce (its best); `catalog` its fastest strong method.
Embeddings come from a named embedder in settings (default `google/embeddinggemma-300m`
locally, as in BotBase; or any LiteLLM embeddings API) and are cached in
`data/embeddings.db`; indexes rebuild when a source dataset's content version changes.
The retriever page has a **playground** (run a draft on a query or conversation: rendered
text, passages, queries, timings, LLM calls, cost) and **Compare** runs several retrievers on
the same situation side by side. Every run has the same contract: `RetrievalRequest` →
`ContextPack` of passages → text within a character budget.

Measured on the R2MR library (exam-anxiety situation, qwen3.8-flash): `r2mr-hybrid` 0 LLM
calls, ~0.1 s once the index is built; `r2mr-catalog` 1 call, ~5 s, ~$0.002;
`r2mr-mapreduce` 16 calls, ~32 s, ~$0.03.

### Using a retriever in a system
- **`rag_search` tool** — config `retriever`, optional `budget`, `scope_state_key` (search only
  the dataset named in session state, e.g. the active topic). `rag_read` reads an item in full.
  Results are registered as resources under their ids (`<dataset>:<item>`), so
  `provide_file`, `open_course_page`, `return_summary` and `record_memories` accept them.
- **Context injection** — a node's `context` list: retriever, `question` (Jinja; default the
  latest user message or the delegated request), `condition` (Jinja expression, e.g.
  `mode.id != 'router'`), `scope_state_key`, `budget`, `placement` (appended under its label,
  or only where the template uses `{{ context.<name> }}`). Retrieved once per turn (again only
  if a mode switch changes the question or scope); traced with the full text.
- **Library tools on datasets** — `search_resources` & co. take `backend: datasets` (library id
  = dataset id), or set `knowledge.backend` in settings.

Each turn's snapshot includes the retriever definitions and the content version of every
dataset they read, so a transcript records what it searched.

## Simulations

LLM-played users run against systems, one at a time or in large batches, with the raw data
kept for analysis. Under **Simulations** in the web UI:

- **Personas** (`workspace/personas/<id>.yaml`) — who the simulated user is and how they type,
  and the model playing them (thinking off unless the spec sets it; ideally another model family
  than the bots).
- **Scenarios** (`workspace/scenarios/<id>.yaml`) — the opening message (`exact`: sent verbatim,
  so every run starts alike; or `guide`), the situation, **facts** revealed only when the
  assistant asks, the goal, `max_turns`, a default persona, optionally a real profile whose
  memory the simulated user starts with (copied), and **expectations**: what a good
  conversation covers, each with a description for the judge and an optional regex check.
- **Rubrics** (`workspace/rubrics/<id>.yaml`) — an LLM judge: instructions, weighted criteria
  with ranges, and (optionally) a 0–3 grade per scenario expectation (absent / named /
  explained / applied to this user).
- **Runs** — systems × scenarios × personas × repetitions, `concurrency` at a time. Each system
  is compiled once and **pinned** for the run (snapshot hash recorded); each conversation is an
  ordinary chat (origin `simulation`, watchable live in the chat view, with traces) with a
  throwaway profile so memory agents run. Runs can be cancelled, failed conversations retried,
  finished ones **re-judged** with any rubric. A server restart resumes queued conversations.

Per conversation: transcript, turns, how it ended (`persona` / `max_turns` / …), seconds per
turn, LLM calls and tokens per agent, tools used, retrieval cost, recovery events, simulator
cost, regex checks, and the judge's scores (weighted criteria → 0–100; expectations → 0–1).
The run summary compares systems (mean ± 95% CI per score and metric, criterion and
expectation means, a system × scenario table, costs). **Export**: JSONL (one record per
conversation: transcript, metrics, judgments, and with `full` its outputs, traces and the
persona/scenario definitions) or CSV (one row per conversation, a column per criterion,
expectation and check).

`scripts/import_botbase_sims.py` brings in rag_lab's 22 expert scenarios + 2 out-of-scope
ones (intake answers as facts; the experts' skills and concepts as expectations, with
rag_lab's alias regexes as checks), a memory follow-up scenario, rag_lab's simulated member
and BotBase's warehouse-worker persona, and two rubrics (`r2mr-expert`, adapted from rag_lab's
judge; `core-quality`, from BotBase's simulator).

## Team use

### Accounts and roles

| Role | Can |
|---|---|
| **viewer** | read every definition and result; chat with systems (own chats and profiles); preview prompts, validate systems, plan simulations; export bundles |
| **editor** | everything a viewer can, plus create/edit/delete definitions and data, upload and process files, run retrievers and simulations, import bundles; read everyone's chats |
| **admin** | everything, plus settings and accounts; delete anyone's chats and profiles |

The first account (an admin) is created on the sign-in page, which offers this only while no
account exists and only to a browser on the server's own machine; or from a console:
`venv\Scripts\python scripts\users.py add <name> --role admin`. Chats and profiles made
before accounts existed go to that first admin. Admins add people under **Users** with a
temporary password they change at first sign-in. `scripts/users.py` also lists accounts,
resets passwords (prompted, never on the command line), changes roles and signs people out.

Sessions are HttpOnly cookies (14 days from the last request); passwords are scrypt hashes;
5 wrong passwords lock a name for 15 minutes; cross-site writes are refused. Chats and
profiles belong to who made them: viewers see only theirs, editors and admins can switch to
everyone's. Simulation runs record who started them.

**As a shared server:** `venv\Scripts\python run.py --host 0.0.0.0` after creating the
admin, ideally behind a reverse proxy that adds HTTPS (cookies are marked Secure when the
proxy sends `X-Forwarded-Proto: https`). Run one server process: version checks, sessions
and presence live in that process.

### Editing together

- **Conflict-safe saving.** Every definition carries a `version` (a hash of its file). The
  editors send the version they started from (`If-Match`); if someone saved in between, the
  server answers 409 with what is stored now, and the editor shows who changed it and which
  fields each side changed. When no field changed on both sides, the two sets of changes
  merge; otherwise you choose: save yours anyway, load theirs, or keep editing.
  Requests without `If-Match` (scripts) still write unconditionally.
- **History.** Every save, delete and import is kept (`revisions`, 200 per definition), with
  who and when; a file edited by hand is captured before the next save through the app. Any
  revision can be loaded back into the editor.
- **Presence.** Editors show who else has the same definition open, and whether they have
  unsaved changes.

### Export / import

**Import / Export** packs definitions into a zip bundle: `manifest.json` (who exported what,
when; the model presets the definitions name) plus the YAML files as they are in the
workspace, and optionally the datasets' contents (`dataset.db` and uploaded files; linked
files outside the dataset are not included, their extracted text is). Export can add
everything the selection depends on: a system's agents, retrievers, datasets, memory schema
and shared fragments; a retriever's datasets; a scenario's persona.

Import previews each definition as new / same / changed / invalid, and lets you create,
replace, skip, or copy it under a new id (the bundle's other definitions then point at the
copy). Missing model presets are added to the settings. Every import is recorded in the
history, so a replaced definition can be restored.

## Safety

**Safety → Classifiers** (`workspace/classifiers/<id>.yaml`) defines safety classifiers. Each
answers the same question — is this message, or this user message + reply, safe, and which
categories apply — so any of them can guard any node:

| Provider | What it runs | Start it |
|---|---|---|
| `safer` | MIRA's SAFER classifier: ModernBERT-large with MIRA's fine-tuned checkpoint (13 categories, ~85 ms on the GPU) | `venv\Scripts\python scripts\run_safer.py` (:8100) |
| `nemo_guardrails` | NVIDIA NeMo Guardrails with the classifier's own rails config (`config.yml`, `prompts.yml`; default: self-check input/output rails through OpenRouter) | `venv\Scripts\python scripts\run_guardrails.py` (:8300; its own venv in `services/nemo_guardrails/`, created on first run) |
| `nemoguard` | NVIDIA's Llama 3.1 NemoGuard content-safety model (Aegis taxonomy) | NVIDIA NIM: `NVIDIA_NIM_API_KEY` for build.nvidia.com, or a self-hosted NIM |
| `qwen3guard` | Qwen3Guard-Gen (the model MIRA tried) | any OpenAI-compatible server (vLLM, llama.cpp) |
| `llm` | any model as a judge, with your categories | — |
| `keywords` | regular expressions per category | — |

Each classifier sets what happens when it can't answer (`on_error`: let the message through, or
treat it as unsafe). The editor's **Try it** panel classifies a message or a reply on the spot.

**Guards** attach a classifier to a node in the system graph (`SystemDef.guards`):

- **Input** — checks each user message before the agents run: `block` (a fixed reply; the agents
  don't run), `inform` (the node's instruction gets a safety note this turn), `add_message` (e.g.
  crisis resources shown first, then the agents answer), `flag` (recorded only).
- **Output** — checks each message the node sends before the user sees it, alone or with the
  user's message (`exchange`, as MIRA does): `regenerate` (the node is asked for a different
  reply, up to `max_retries`, then the rule's message replaces it), `replace`, `add_message`,
  `flag`.

Rules match the verdict's categories (e.g. self-harm → crisis message, anything else → block).
Every verdict is a `guard` trace (debug panel, exports, simulations); guards apply to chat links
too, and the classifiers a turn used are part of its snapshot.

## Setup wizard

**Systems → Set up a new system** walks through: name and purpose; the main agent (reuse one or
describe a new one: role, instructions, model); helpers (a researcher it can ask, a specialist
it can hand over to, a memory keeper, any agent as a tool); knowledge (a retriever, as context
every turn or as a search tool); memory; safety (a classifier and plain-language policies, with
a crisis message); and the chat page. The review shows exactly what will be created and checks
it first; creation is all or nothing. The result is ordinary agents, classifiers and a system,
refined afterwards in the full editors.

## Chat links

**Links** publishes a system at a secret URL (`/c/<token>`) for people without an account. They
get a standalone chat page (its own small bundle, none of the management interface: no
traces, no debug panes) talking to `/api/public/<token>`, which only ever returns what the
user side of a chat sees and serves only the files and course pages delivered in that
visitor's conversation. Per link:

| Setting | |
|---|---|
| **Save transcripts** | On: conversations are ordinary chats (origin `link`) that editors read in the chat view. Off: the conversation (ADK session, transcript, traces) exists only in the server's memory while it is open — nothing is written to disk — and is erased when the visitor ends it, after `idle_minutes` without a message, or on a restart; the link keeps only counts (when, how many turns). |
| **Remember visitors** | A memory profile per visitor (a random id in a cookie in their browser), so the system's memory agent keeps its anonymous template notes across visits. Off: every conversation starts without memory. |
| **Page** | Title, welcome, starters (default: the system's UI settings), a notice, and whether visitors must accept it to start (recorded per conversation). |
| **Access** | Optional access code (stored hashed; 5 wrong tries lock for 15 minutes), expiry, on/off; replacing the URL makes the old one stop working. |
| **Limits** | Messages per conversation, messages per minute per visitor, conversations in total. |

Visitors are anonymous: the database keeps a hash of their cookie, never an IP or name. A
link follows the system's latest saved version — duplicate the system first if a study needs
it frozen. Others can reach the page only if the server is reachable for them (see *As a
shared server* above).

## Roadmap

- **Audio/video** — transcription in the extraction pipeline.
- **API tokens** — for scripts that call the API with accounts on.
- **Chat links** — pinning a link to a system version; embedding the chat page in other sites.
