import { useState, type ReactNode } from 'react';
import { clipText, fmtMs, fmtTime, toDisplay, toInline } from '../../lib/util';
import type { TraceEvent } from '../../types';

type Data = Record<string, unknown>;

const asData = (d: unknown): Data => (d && typeof d === 'object' && !Array.isArray(d) ? (d as Data) : {});
const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : toInline(v));

function Expand({ label, text, max = 160, mono = true }: { label?: ReactNode; text: string; max?: number; mono?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > max || text.includes('\n');
  return (
    <div className="trace-expand">
      {label && <span className="trace-key">{label} </span>}
      {open ? (
        <pre className={`trace-pre${mono ? ' mono' : ''}`}>{text}</pre>
      ) : (
        <span className={mono ? 'mono' : ''}>{clipText(text.replace(/\s+/g, ' '), max)}</span>
      )}
      {long && (
        <button type="button" className="link-btn small" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

function Details({ summary, text }: { summary: ReactNode; text: string }) {
  if (!text) return null;
  return (
    <details className="trace-details">
      <summary>{summary}</summary>
      <pre className="trace-pre mono">{text}</pre>
    </details>
  );
}

const TONES: Record<string, string> = {
  llm_call: 'llm',
  llm_output: 'out',
  tool_call: 'tool',
  tool_result: 'tool',
  spawn: 'spawn',
  result: 'spawn',
  error: 'err',
  run_error: 'err',
  reply_fallback: 'err',
  reply_recovery: 'warn',
  nudge: 'warn',
  turn_start: 'turn',
  turn_done: 'turn',
  guard: 'guard',
};

/** One trace event, compact. Handles both live (clipped) and stored (full) data. */
export function TraceRow({ trace, showAgent }: { trace: TraceEvent; showAgent?: boolean }) {
  const d = asData(trace.data);
  let body: ReactNode = null;

  switch (trace.event) {
    case 'llm_call': {
      const parts = [
        d.seconds != null && `${String(d.seconds)}s`,
        d.prompt_tokens != null && `in ${String(d.prompt_tokens)}`,
        d.output_tokens != null && `out ${String(d.output_tokens)}`,
        d.thinking_tokens != null && `think ${String(d.thinking_tokens)}`,
      ].filter(Boolean);
      body = (
        <>
          <span className="mono">{parts.join(' · ')}</span> {d.model != null && <span className="muted">{str(d.model)}</span>}
          {d.truncated === true && <span className="trace-flag warn">truncated</span>}
          {d.error != null && <div className="text-danger">{str(d.error)}</div>}
        </>
      );
      break;
    }
    case 'llm_output':
      body = (
        <>
          {str(d.text) && <Expand text={str(d.text)} max={240} mono={false} />}
          {str(d.thinking) && <Details summary="thinking" text={str(d.thinking)} />}
        </>
      );
      break;
    case 'tool_call':
      body = (
        <>
          <strong className="mono">{str(d.name)}</strong>
          <Expand text={toDisplay(d.args)} max={200} />
        </>
      );
      break;
    case 'tool_result':
      body = (
        <>
          <strong className="mono">← {str(d.name)}</strong> <Details summary={clipText(str(d.result).replace(/\s+/g, ' '), 120)} text={toDisplay(d.result)} />
        </>
      );
      break;
    case 'spawn':
      body = (
        <>
          {d.observe ? 'observing' : d.via != null ? 'delegated' : 'spawned'} from <strong>{str(d.from)}</strong>
          {d.via != null && (
            <>
              {' '}
              via <code>{str(d.via)}</code>
            </>
          )}
          {d.model != null && <span className="muted"> · {str(d.model)}</span>}
          {d.prior_notes != null && <span className="muted"> · {str(d.prior_notes)} prior notes</span>}
          {d.request != null && <Details summary="request" text={toDisplay(d.request)} />}
          {d.args != null && <Details summary="args" text={toDisplay(d.args)} />}
        </>
      );
      break;
    case 'result': {
      const live = 'complete' in d;
      body = live ? (
        <>
          {d.complete ? <span className="trace-flag ok">complete</span> : <span className="trace-flag warn">incomplete</span>}
          {d.tool_calls != null && <span className="muted"> · {str(d.tool_calls)} tool calls</span>}
          <Details summary="result" text={toDisplay(d.result)} />
        </>
      ) : (
        <Details summary="result" text={toDisplay(trace.data)} />
      );
      break;
    }
    case 'inject':
      body = (
        <>
          memory snapshot{d.chars != null && <> · {str(d.chars)} chars</>}
          {d.block != null && <Details summary="block" text={str(d.block)} />}
        </>
      );
      break;
    case 'search': {
      // Live: hits is a count; stored: the hit list.
      const hits = Array.isArray(d.hits) ? d.hits : null;
      body = (
        <>
          <code>{str(d.query)}</code> → {hits ? hits.length : str(d.hits)} hits
          {hits && hits.length > 0 && <Details summary="hits" text={toDisplay(hits)} />}
        </>
      );
      break;
    }
    case 'write': {
      const stored = Array.isArray(d.stored) ? d.stored : null;
      body = (
        <>
          {stored ? stored.length : str(d.rows)} note(s) written{d.profile != null && <span className="muted"> · profile {str(d.profile)}</span>}
          {stored && stored.length > 0 && <Details summary="notes" text={toDisplay(stored)} />}
        </>
      );
      break;
    }
    case 'text_reply':
      body = (
        <>
          {d.delivered ? 'delivered' : <span className="text-danger">not delivered</span>} · {str(d.chars)} chars
        </>
      );
      break;
    case 'reply_recovery':
      body = (
        <>
          recovering missing reply{d.after_truncation ? ' (after truncation)' : ''}
          {d.thinking === false && ' · thinking off'}
        </>
      );
      break;
    case 'nudge':
      body = <Expand text={str(d.text)} max={160} mono={false} />;
      break;
    case 'turn_start':
      body = (
        <>
          {d.user_message != null && <Expand text={str(d.user_message)} max={120} mono={false} />}
          {d.snapshot != null && <span className="muted mono small">snapshot {str(d.snapshot)}</span>}
        </>
      );
      break;
    case 'turn_done':
      body = null;
      break;
    case 'guard': {
      // A safety check: verdict, categories, and what the guard did about it.
      const cats = Array.isArray(d.categories) ? d.categories.map(str) : [];
      const outcome = str(d.outcome);
      const label = str(d.label);
      const tone = d.error ? 'warn' : d.safe ? 'ok' : 'bad';
      const scores = d.scores && typeof d.scores === 'object' ? (d.scores as Record<string, unknown>) : null;
      body = (
        <>
          <span className={`guard-badge ${tone}`} title={`guard ${str(d.guard)} · classifier ${str(d.classifier)}`}>
            ⛨ {str(d.check) === 'output' ? 'reply' : 'input'} · {d.error ? 'error' : d.safe ? 'safe' : label || 'unsafe'}
          </span>{' '}
          <code className="small">{str(d.guard)}</code>
          {cats.length > 0 && <span className="guard-cats"> {cats.join(', ')}</span>}
          {outcome && outcome !== 'passed' && (
            <span className={`trace-flag ${outcome === 'superseded' || outcome === 'flag' ? 'warn' : 'bad'}`}>→ {outcome.replace('_', ' ')}</span>
          )}
          {d.latency_ms != null && <span className="muted"> · {fmtMs(Math.round(Number(d.latency_ms)))}</span>}
          {d.error != null && d.error !== '' && <div className="text-warn">{str(d.error)}</div>}
          {scores && Object.keys(scores).length > 0 && <Details summary="scores" text={toDisplay(scores)} />}
          {d.detail != null && d.detail !== '' && <Details summary="detail" text={toDisplay(d.detail)} />}
        </>
      );
      break;
    }
    case 'error':
    case 'run_error':
      body = <span className="text-danger">{str(d.error ?? trace.data)}</span>;
      break;
    default: {
      const text = toDisplay(trace.data);
      body = text && text !== '{}' ? <Expand text={text} max={160} /> : null;
    }
  }

  return (
    <div className={`trace-row trace-${TONES[trace.event] ?? 'other'}`}>
      <span className="trace-time">{fmtTime(trace.ts)}</span>
      <span className="trace-event">{trace.event}</span>
      {showAgent && <span className="trace-agent">{trace.agent}</span>}
      <div className="trace-body">{body}</div>
    </div>
  );
}
