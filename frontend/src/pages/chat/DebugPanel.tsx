import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Badge, ErrorBox, Loading, Modal } from '../../components/ui';
import { useLoad } from '../../lib/hooks';
import { downloadJson, toDisplay } from '../../lib/util';
import type { HistoryMessage, StoredTrace, TraceEvent } from '../../types';
import { TraceRow } from './TraceView';
import type { LiveTrace } from './useChat';

type AnyTrace = TraceEvent & { turn: number | null; key: string };

export function DebugPanel({
  chatId,
  liveTraces,
  liveTurns,
  snapshots,
  streamOpen,
}: {
  chatId: string | null;
  liveTraces: LiveTrace[];
  liveTurns: number[];
  snapshots: Record<number, string>;
  streamOpen: boolean;
}) {
  const [stored, setStored] = useState<{ chatId: string; traces: StoredTrace[] } | null>(null);
  const [storedError, setStoredError] = useState<unknown>(null);
  const [modal, setModal] = useState<'trace' | 'history' | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  // Earlier turns come from the database; turns seen live come from the stream.
  useEffect(() => {
    if (!chatId) {
      setStored(null);
      return;
    }
    let alive = true;
    setStoredError(null);
    api.chats
      .traces(chatId)
      .then((traces) => alive && setStored({ chatId, traces }))
      .catch((e: unknown) => alive && setStoredError(e));
    return () => {
      alive = false;
    };
  }, [chatId]);

  const traces: AnyTrace[] = useMemo(() => {
    const history = stored && stored.chatId === chatId ? stored.traces.filter((t) => !liveTurns.includes(t.turn)) : [];
    return [
      ...history.map((t) => ({ ...t, key: `s${t.id}` })),
      ...liveTraces.map((t) => ({ ...t, key: `l${t.seq}` })),
    ];
  }, [stored, chatId, liveTraces, liveTurns]);

  const agents = useMemo(() => {
    const order: string[] = [];
    for (const t of traces) if (!order.includes(t.agent)) order.push(t.agent);
    return order;
  }, [traces]);

  const turnSnapshots = useMemo(() => {
    const map: Record<number, string> = {};
    for (const t of traces) {
      const d = t.data as Record<string, unknown> | null;
      if (t.event === 'turn_start' && t.turn != null && d && typeof d.snapshot === 'string') map[t.turn] = d.snapshot;
    }
    return { ...map, ...snapshots };
  }, [traces, snapshots]);
  const lastTurn = Math.max(0, ...Object.keys(turnSnapshots).map(Number));
  const lastHash = turnSnapshots[lastTurn];

  const exportChat = async () => {
    if (!chatId) return;
    setExporting(true);
    setExportError(null);
    try {
      downloadJson(`chat-${chatId}.json`, await api.chats.exportData(chatId));
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-header">
        <strong>Debug</strong>
        {streamOpen && <Badge tone="accent">live</Badge>}
        <Badge tone="muted">{traces.length} events</Badge>
        {lastHash && (
          <span className="small">
            turn {lastTurn} snapshot{' '}
            <a href={`/api/snapshots/${lastHash}`} target="_blank" rel="noreferrer" className="mono">
              {lastHash}
            </a>
          </span>
        )}
        <span className="grow" />
        <button className="btn btn-sm" disabled={!chatId} onClick={() => setModal('trace')}>
          Full trace
        </button>
        <button className="btn btn-sm" disabled={!chatId} onClick={() => setModal('history')}>
          Model history
        </button>
        <button className="btn btn-sm" disabled={!chatId || exporting} onClick={exportChat}>
          {exporting ? 'Exporting…' : 'Export JSON'}
        </button>
      </div>
      {storedError != null && <ErrorBox error={storedError} title="Stored traces unavailable" />}
      {exportError != null && <ErrorBox error={exportError} title="Export failed" />}
      <div className="debug-panes">
        {agents.length === 0 && <div className="muted small debug-empty">{chatId ? 'No trace events yet.' : 'Send a message to see trace events.'}</div>}
        {agents.map((agent) => (
          <AgentPane key={agent} agent={agent} traces={traces.filter((t) => t.agent === agent)} />
        ))}
      </div>
      {modal === 'trace' && chatId && <FullTraceModal chatId={chatId} onClose={() => setModal(null)} />}
      {modal === 'history' && chatId && <HistoryModal chatId={chatId} onClose={() => setModal(null)} />}
    </div>
  );
}

function AgentPane({ agent, traces }: { agent: string; traces: AnyTrace[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [traces.length]);
  let prevTurn: number | null | undefined;
  return (
    <div className="debug-pane">
      <div className="debug-pane-header">
        <strong>{agent}</strong> <span className="muted small">{traces.length}</span>
      </div>
      <div
        className="debug-pane-body"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {traces.map((t) => {
          const divider = t.turn !== prevTurn && t.turn != null;
          prevTurn = t.turn;
          return (
            <div key={t.key}>
              {divider && <div className="turn-divider">turn {t.turn}</div>}
              <TraceRow trace={t} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FullTraceModal({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const traces = useLoad(() => api.chats.traces(chatId), [chatId]);
  const [agent, setAgent] = useState('');
  const agents = useMemo(() => [...new Set((traces.data ?? []).map((t) => t.agent))], [traces.data]);
  const rows = (traces.data ?? []).filter((t) => !agent || t.agent === agent);
  let prevTurn = -1;
  return (
    <Modal
      title="Full trace"
      onClose={onClose}
      size="xl"
      footer={
        traces.data && (
          <button className="btn btn-sm" onClick={() => downloadJson(`traces-${chatId}.json`, traces.data)}>
            Download JSON
          </button>
        )
      }
    >
      {traces.loading && <Loading />}
      {traces.error != null && <ErrorBox error={traces.error} onRetry={traces.reload} />}
      {traces.data && (
        <>
          <div className="row gap-sm">
            <select value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">All agents ({traces.data.length})</option>
              {agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
          <div className="full-trace">
            {rows.map((t) => {
              const divider = t.turn !== prevTurn;
              prevTurn = t.turn;
              return (
                <div key={t.id}>
                  {divider && <div className="turn-divider">turn {t.turn}</div>}
                  <TraceRow trace={t} showAgent />
                </div>
              );
            })}
            {rows.length === 0 && <div className="muted">No events.</div>}
          </div>
        </>
      )}
    </Modal>
  );
}

function HistoryModal({ chatId, onClose }: { chatId: string; onClose: () => void }) {
  const history = useLoad(() => api.chats.history(chatId), [chatId]);
  return (
    <Modal
      title="Model history"
      onClose={onClose}
      size="xl"
      footer={
        history.data && (
          <button className="btn btn-sm" onClick={() => downloadJson(`history-${chatId}.json`, history.data)}>
            Download JSON
          </button>
        )
      }
    >
      <p className="muted small">The model-side history: ADK session events as OpenAI-style messages.</p>
      {history.loading && <Loading />}
      {history.error != null && <ErrorBox error={history.error} onRetry={history.reload} />}
      {history.data && history.data.length === 0 && <div className="muted">Empty.</div>}
      <div className="history-list">
        {(history.data ?? []).map((m, i) => (
          <HistoryRow key={i} m={m} />
        ))}
      </div>
    </Modal>
  );
}

function HistoryRow({ m }: { m: HistoryMessage }) {
  return (
    <div className={`history-msg role-${m.role}`}>
      <div className="history-head">
        <Badge tone={m.role === 'user' ? 'accent' : m.role === 'tool' ? 'muted' : 'ok'}>{m.role}</Badge>
        {m.agent && <code className="small">{m.agent}</code>}
        {m.name && <code className="small">{m.name}</code>}
        {m.nudge && <Badge tone="warn">nudge</Badge>}
      </div>
      {m.reasoning && (
        <details className="trace-details">
          <summary>reasoning</summary>
          <pre className="trace-pre mono">{m.reasoning}</pre>
        </details>
      )}
      {m.content != null && <pre className="trace-pre mono history-content">{m.content}</pre>}
      {m.tool_calls?.map((c) => (
        <div key={c.id || c.function.name} className="small">
          → <strong className="mono">{c.function.name}</strong> <code className="small">{prettyArgs(c.function.arguments)}</code>
        </div>
      ))}
    </div>
  );
}

function prettyArgs(args: string): string {
  try {
    return toDisplay(JSON.parse(args));
  } catch {
    return args;
  }
}
