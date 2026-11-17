import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { Markdown } from '../../components/Markdown';
import { modelSummary } from '../../components/ModelSpecEditor';
import { Badge, Collapsible, EmptyState, ErrorBox, Loading, MessageList, PageHeader, Spinner } from '../../components/ui';
import { fmtCost, fmtDateTime, fmtSeconds, isEmptyModel } from '../../lib/util';
import type { Judgment, PersonaDef, ScenarioDef, SimConversationDetail, SimConvMetrics, TranscriptMessage } from '../../types';
import { ChecksChips, ENDED_BY_HELP, fmtPct, fmtScore, isBusyConv, LevelBadge, MeterBar, SimStatusBadge, SimTabs } from './simUi';

const POLL_MS = 3000;

/** Loads one simulated conversation; polls while it is queued / running / judging. */
function useConversation(convId: number, refreshKey?: string) {
  const [data, setData] = useState<SimConversationDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const current = useRef(convId);
  current.current = convId;

  const load = useCallback(async () => {
    const id = convId;
    try {
      const d = await api.simulations.conversation(id);
      if (current.current !== id) return;
      setData(d);
      setError(null);
    } catch (e) {
      if (current.current !== id) return;
      setError(e);
    } finally {
      if (current.current === id) setTick((t) => t + 1);
    }
  }, [convId]);

  useEffect(() => {
    setData(null);
    setError(null);
  }, [convId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const busy = !!data && isBusyConv(data.status);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => void load(), error ? POLL_MS * 3 : POLL_MS);
    return () => clearTimeout(t);
  }, [busy, tick, error, load]);

  return { data, error, reload: load };
}

/** /simulations/conversations/:convId — one conversation as a page. */
export function ConversationPage() {
  const { convId = '' } = useParams();
  const id = Number(convId);
  return (
    <div className="page page-wide">
      <PageHeader
        title={
          <>
            <span className="crumbs" style={{ display: 'block', fontWeight: 400 }}>
              <Link to="/simulations">Simulations</Link> / <Link to="/simulations">Runs</Link> /
            </span>
            Simulated conversation
          </>
        }
      />
      <SimTabs />
      {Number.isFinite(id) ? <ConversationDetail convId={id} showRunLink /> : <ErrorBox error={`Invalid conversation id "${convId}"`} />}
    </div>
  );
}

/** Everything about one simulated conversation: outcome, judgments, transcript, metrics, definitions. */
export function ConversationDetail({
  convId,
  refreshKey,
  showRunLink,
  onRetry,
}: {
  convId: number;
  /** Changes when the run's row for it changes (re-fetch). */
  refreshKey?: string;
  showRunLink?: boolean;
  /** Retry a failed / cancelled conversation (only offered when given). */
  onRetry?: (convId: number) => void;
}) {
  const { data: c, error, reload } = useConversation(convId, refreshKey);

  if (error != null && !c) return <ErrorBox error={error} onRetry={() => void reload()} title="Could not load the conversation" />;
  if (!c) return <Loading />;

  const m = c.metrics ?? {};
  const busy = isBusyConv(c.status);
  const turnSeconds = m.turn_seconds ?? [];
  const total = turnSeconds.reduce((a, b) => a + b, 0);

  return (
    <div className="sim-conv stack">
      {error != null && <ErrorBox error={error} title="Could not refresh" />}
      <div className="sim-conv-head">
        <div className="row gap-sm wrap">
          <SimStatusBadge status={c.status} />
          <strong>#{c.idx + 1}</strong>
          <Badge tone="neutral" title="System">
            {c.system_id}
          </Badge>
          <span className="muted">×</span>
          <Badge tone="accent" title="Scenario">
            {c.scenario_id}
          </Badge>
          <span className="muted">×</span>
          <Badge tone="observe" title="Persona">
            {c.persona_id}
          </Badge>
          <span className="muted small">rep {c.rep}</span>
        </div>
        <div className="row gap-sm wrap">
          {c.chat_id && (
            <Link className="btn btn-sm" to={`/chat/${c.system_id}/${c.chat_id}`} title="The chat page shows it live, with the debug / trace panel">
              Open in chat view{busy ? ' (live)' : ''}
            </Link>
          )}
          {showRunLink && (
            <Link className="btn btn-sm btn-ghost" to={`/simulations/runs/${c.run.id}?conv=${c.id}`}>
              Run: {c.run.name || c.run.id}
            </Link>
          )}
          {onRetry && (c.status === 'failed' || c.status === 'cancelled') && (
            <button className="btn btn-sm" onClick={() => onRetry(c.id)} title="Runs it again in a fresh chat (real LLM calls)">
              Retry this conversation
            </button>
          )}
        </div>
      </div>

      {c.error && (
        <div className="notice notice-error">
          <strong>Failed</strong>
          <div className="pre-wrap small mono">{c.error}</div>
        </div>
      )}
      <MessageList tone="warn" title="Warnings" items={m.warnings ?? []} />

      <div className="meta-grid small">
        <span className="muted">turns</span>
        <span>
          {c.turns}
          {c.ended_by && (
            <span className="muted" title={ENDED_BY_HELP[c.ended_by]}>
              {' '}
              · ended by {c.ended_by}
            </span>
          )}
          {busy && (
            <span className="muted">
              {' '}
              · <Spinner /> {c.status}…
            </span>
          )}
        </span>
        <span className="muted">time</span>
        <span>
          {fmtSeconds(total)} in turns{turnSeconds.length > 0 && <span className="muted"> · {fmtSeconds(total / turnSeconds.length)} / turn</span>}
          {c.started_at && <span className="muted"> · started {fmtDateTime(c.started_at)}</span>}
          {c.finished_at && <span className="muted"> · finished {fmtDateTime(c.finished_at)}</span>}
        </span>
        {m.memory_copied != null && (
          <>
            <span className="muted">memory</span>
            <span>
              {m.memory_copied} note(s) copied from profile <em>{c.scenario?.profile}</em>
            </span>
          </>
        )}
        <span className="muted">checks</span>
        <span>
          <ChecksChips checks={m.checks} />
        </span>
      </div>

      <Judgments judgments={c.judgments} busy={c.status === 'judging'} />

      <section>
        <h3 className="sim-section-title">Transcript</h3>
        <Transcript messages={c.transcript} turnSeconds={turnSeconds} live={busy} />
      </section>

      <Metrics m={m} />

      <Collapsible title="Scenario & persona (as frozen in the run)">
        <ScenarioSummary s={c.scenario} />
        <PersonaSummaryView p={c.persona} />
      </Collapsible>
    </div>
  );
}

// ---------------------------------------------------------------- transcript

const NOTE_RE = /^\[The assistant (shared a file|opened a page beside the chat): [\s\S]*\]$/;
const NO_REPLY = '(no reply)';

function Transcript({ messages, turnSeconds, live }: { messages: TranscriptMessage[]; turnSeconds: number[]; live: boolean }) {
  if (!messages.length) return <EmptyState>{live ? 'Waiting for the first turn…' : 'No messages.'}</EmptyState>;
  let userIdx = -1;
  return (
    <div className="sim-transcript">
      {messages.map((msg, i) => {
        if (msg.role === 'user') {
          userIdx += 1;
          return (
            <div key={i} className="msg msg-user">
              <div className="bubble">{msg.content}</div>
              <div className="msg-meta muted">simulated user · turn {userIdx + 1}</div>
            </div>
          );
        }
        const last = i === messages.length - 1;
        return <AssistantMessage key={i} content={msg.content} seconds={turnSeconds[userIdx]} pending={live && last && msg.content === NO_REPLY} />;
      })}
    </div>
  );
}

/** The assistant's turn as the user saw it: message text (markdown) and "[shared a file …]" notes as system lines. */
function AssistantMessage({ content, seconds, pending }: { content: string; seconds?: number; pending: boolean }) {
  if (pending)
    return (
      <div className="sys-line">
        <Spinner /> the system is replying…
      </div>
    );
  if (content === NO_REPLY) return <div className="sys-line sys-error">no reply from the system</div>;
  const blocks: { note: boolean; text: string }[] = [];
  for (const part of content.split('\n\n')) {
    const note = NOTE_RE.test(part.trim());
    const prev = blocks[blocks.length - 1];
    if (!note && prev && !prev.note) prev.text += `\n\n${part}`;
    else blocks.push({ note, text: part });
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.note ? (
          <div key={i} className="sys-line">
            {b.text.trim().slice(1, -1)}
          </div>
        ) : (
          <div key={i} className="msg msg-assistant">
            <div className="bubble">
              <Markdown>{b.text}</Markdown>
            </div>
          </div>
        ),
      )}
      {seconds != null && <div className="msg-meta muted sim-turn-time">{fmtSeconds(seconds)}</div>}
    </>
  );
}

// ----------------------------------------------------------------- judgments

function Judgments({ judgments, busy }: { judgments: Judgment[]; busy: boolean }) {
  if (!judgments.length && !busy) return null;
  const ordered = [...judgments].reverse();
  return (
    <section>
      <h3 className="sim-section-title">
        Judgments {judgments.length > 1 && <Badge tone="muted">{judgments.length}</Badge>}
      </h3>
      {busy && (
        <div className="muted small">
          <Spinner /> the judge is grading…
        </div>
      )}
      <div className="stack">
        {ordered.map((j, i) => (
          <JudgmentCard key={j.id ?? i} j={j} latest={i === 0} />
        ))}
      </div>
    </section>
  );
}

export function JudgmentCard({ j, latest }: { j: Judgment; latest?: boolean }) {
  const r = j.result ?? {};
  return (
    <div className="card judgment-card">
      <div className="card-head">
        <span className="row gap-sm wrap">
          <Link to={`/simulations/rubrics/${j.rubric_id}`} className="badge badge-accent">
            {j.rubric_id || 'rubric'}
          </Link>
          {j.status !== 'completed' && <SimStatusBadge status={j.status} />}
          {latest === false && <Badge tone="muted">earlier</Badge>}
        </span>
        <span className="row gap-sm">
          {j.expectation_score != null && (
            <span className="small" title="Expectation score: mean level / 3">
              expectations <strong>{fmtPct(j.expectation_score)}</strong>
            </span>
          )}
          <span className="sim-score" title="Weighted criteria mean, 0–100">
            {fmtScore(j.score)}
            <span className="muted small"> / 100</span>
          </span>
        </span>
      </div>
      <div className="muted small">
        {j.model && <span className="mono">{j.model}</span>}
        {j.cost ? <> · {fmtCost(j.cost)}</> : null}
        {j.created_at && <> · {fmtDateTime(j.created_at)}</>}
      </div>
      {j.error && <div className="notice notice-error small pre-wrap">{j.error}</div>}
      {r.criteria && r.criteria.length > 0 && (
        <table className="table table-compact sim-criteria">
          <tbody>
            {r.criteria.map((c) => (
              <tr key={c.key}>
                <td className="nowrap">
                  <strong>{c.title || c.key}</strong>
                  {c.weight !== 1 && <span className="muted small"> ×{c.weight}</span>}
                  <MeterBar value={c.score == null ? null : (c.score - c.min) / (c.max - c.min)} />
                </td>
                <td className="num nowrap">
                  {c.score == null ? <span className="muted">—</span> : <strong>{c.score}</strong>}
                  <span className="muted small"> / {c.max}</span>
                </td>
                <td className="small">{c.justification}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.expectations && r.expectations.length > 0 && (
        <table className="table table-compact">
          <tbody>
            {r.expectations.map((e) => (
              <tr key={e.name}>
                <td className="nowrap">{e.name}</td>
                <td>
                  <LevelBadge level={e.level} />
                </td>
                <td className="small">{e.evidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.comment && <div className="judgment-comment">{r.comment}</div>}
    </div>
  );
}

// ------------------------------------------------------------------- metrics

function Metrics({ m }: { m: SimConvMetrics }) {
  const chat = m.chat ?? {};
  const llm = Object.entries(chat.llm ?? {});
  const tools = Object.entries(chat.tools ?? {}).sort((a, b) => b[1] - a[1]);
  const events = Object.entries(chat.events ?? {});
  const sim = m.simulator;
  const ret = chat.retrieval;
  if (!llm.length && !sim && !ret) return null;
  return (
    <section>
      <h3 className="sim-section-title">Metrics</h3>
      {llm.length > 0 && (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="num">LLM calls</th>
              <th className="num">Prompt tokens</th>
              <th className="num">Output tokens</th>
              <th className="num">Thinking tokens</th>
              <th className="num">Seconds</th>
            </tr>
          </thead>
          <tbody>
            {llm.map(([agent, a]) => (
              <tr key={agent}>
                <td className="mono">{agent}</td>
                <td className="num">{a.calls}</td>
                <td className="num">{a.prompt_tokens.toLocaleString()}</td>
                <td className="num">{a.output_tokens.toLocaleString()}</td>
                <td className="num">{a.thinking_tokens.toLocaleString()}</td>
                <td className="num">{a.seconds?.toFixed(1)}</td>
              </tr>
            ))}
            {chat.llm_total && llm.length > 1 && (
              <tr>
                <td>
                  <strong>total</strong>
                </td>
                <td className="num">
                  <strong>{chat.llm_total.calls}</strong>
                </td>
                <td className="num">{chat.llm_total.prompt_tokens.toLocaleString()}</td>
                <td className="num">{chat.llm_total.output_tokens.toLocaleString()}</td>
                <td className="num">{chat.llm_total.thinking_tokens.toLocaleString()}</td>
                <td />
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="meta-grid small" style={{ marginTop: 8 }}>
        <span className="muted">tools</span>
        <span className="badges">
          {tools.length ? (
            tools.map(([name, n]) => (
              <Badge key={name} tone="delegate">
                {name} ×{n}
              </Badge>
            ))
          ) : (
            <span className="muted">none</span>
          )}
        </span>
        <span className="muted">retrieval</span>
        <span>
          {ret ? (
            <>
              {ret.calls} call(s) · {ret.llm_calls} LLM call(s) · {fmtCost(ret.cost, '$0')}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
        <span className="muted">issues</span>
        <span className="badges">
          {events.length ? (
            events.map(([ev, n]) => (
              <Badge key={ev} tone={ev === 'run_error' || ev === 'context_error' ? 'danger' : 'warn'}>
                {ev} ×{n}
              </Badge>
            ))
          ) : (
            <span className="muted">none</span>
          )}
        </span>
        <span className="muted">simulator</span>
        <span>
          {sim ? (
            <>
              {sim.calls} call(s) · {sim.tokens.toLocaleString()} tokens · {fmtCost(sim.cost, '$0')}
            </>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
      </div>
    </section>
  );
}

// --------------------------------------------------------------- definitions

function ScenarioSummary({ s }: { s: ScenarioDef | null }) {
  if (!s) return <div className="muted small">Scenario definition not stored.</div>;
  return (
    <div className="sim-def">
      <div className="subsection-title">
        Scenario · <Link to={`/simulations/scenarios/${s.id}`}>{s.name || s.id}</Link>
      </div>
      <div className="meta-grid small">
        {s.opening && (
          <>
            <span className="muted">opening ({s.opening_mode})</span>
            <span>“{s.opening}”</span>
          </>
        )}
        {s.situation && (
          <>
            <span className="muted">situation</span>
            <span className="pre-wrap">{s.situation}</span>
          </>
        )}
        {Object.entries(s.facts).map(([k, v]) => (
          <span key={k} className="contents">
            <span className="muted">fact: {k}</span>
            <span>{v}</span>
          </span>
        ))}
        {s.goal && (
          <>
            <span className="muted">goal</span>
            <span className="pre-wrap">{s.goal}</span>
          </>
        )}
        <span className="muted">max turns</span>
        <span>{s.max_turns}</span>
        {s.profile && (
          <>
            <span className="muted">memory profile</span>
            <span>{s.profile}</span>
          </>
        )}
      </div>
      {s.expectations.length > 0 && (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Expectation</th>
              <th>Description</th>
              <th>Pattern</th>
            </tr>
          </thead>
          <tbody>
            {s.expectations.map((e) => (
              <tr key={e.name}>
                <td className="nowrap">{e.name}</td>
                <td className="small">{e.description}</td>
                <td className="small mono">{e.pattern}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PersonaSummaryView({ p }: { p: PersonaDef | null }) {
  if (!p) return <div className="muted small">Persona definition not stored.</div>;
  return (
    <div className="sim-def">
      <div className="subsection-title">
        Persona · <Link to={`/simulations/personas/${p.id}`}>{p.name || p.id}</Link>
        {!isEmptyModel(p.model) && <span className="mono"> · {modelSummary(p.model)}</span>}
      </div>
      <div className="small pre-wrap">{p.profile || <span className="muted">(no profile)</span>}</div>
    </div>
  );
}
