// Chat state: outputs (history + live), live traces, and the SSE turn stream.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api, errorLines } from '../../api';
import { readSSE } from '../../lib/sse';
import type { Chat, ChatDetail, ChatOutput, StreamEvent, TraceEvent, ViewerOutput } from '../../types';

export type ChatItem =
  | { key: string; kind: 'output'; output: ChatOutput; pending?: boolean; failed?: boolean }
  | { key: string; kind: 'error'; message: string };

export interface LiveTrace extends TraceEvent {
  turn: number | null;
  seq: number;
}

export interface ChatState {
  chat: Chat | null;
  items: ChatItem[];
  sessionState: Record<string, unknown>;
  liveTraces: LiveTrace[];
  liveTurns: number[];
  snapshots: Record<number, string>;
  currentTurn: number | null;
  /** Between sending a message and turn_done: input is disabled. */
  turnActive: boolean;
  /** Some SSE stream is open (observers may still run after turn_done). */
  streamOpen: boolean;
  /** Open streams: a new turn may start while the previous one's observers finish. */
  openStreams: number;
  /** The stream whose turn is active; only its turn_done/end clear turnActive. */
  activeStream: number | null;
  loading: boolean;
  loadError: unknown;
}

type Action =
  | { type: 'reset' }
  | { type: 'loading' }
  | { type: 'loaded'; detail: ChatDetail }
  | { type: 'loadError'; error: unknown }
  | { type: 'chatCreated'; chat: Chat }
  | { type: 'localUser'; text: string; key: string }
  | { type: 'turnRequested'; stream: number }
  | { type: 'streamOpen' }
  | { type: 'event'; ev: StreamEvent; stream?: number }
  | { type: 'streamClosed'; stream: number }
  | { type: 'sendFailed'; key: string; message: string };

const initial: ChatState = {
  chat: null,
  items: [],
  sessionState: {},
  liveTraces: [],
  liveTurns: [],
  snapshots: {},
  currentTurn: null,
  turnActive: false,
  streamOpen: false,
  openStreams: 0,
  activeStream: null,
  loading: false,
  loadError: null,
};

let seq = 0;
const outputKey = (o: ChatOutput) => (o.id != null ? `o${o.id}` : `t${o.turn}-${o.type}-${++seq}`);

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'loading':
      return { ...initial, loading: true };
    case 'loaded':
      return {
        ...initial,
        chat: action.detail.chat,
        sessionState: action.detail.state,
        items: action.detail.outputs.map((o) => ({ key: outputKey(o), kind: 'output', output: o })),
        currentTurn: action.detail.chat.turns || null,
      };
    case 'loadError':
      return { ...initial, loadError: action.error };
    case 'chatCreated':
      return { ...state, chat: action.chat };
    case 'localUser':
      return {
        ...state,
        items: [
          ...state.items,
          {
            key: action.key,
            kind: 'output',
            pending: true,
            output: { type: 'user', content: action.text, node: null, turn: (state.currentTurn ?? 0) + 1, ts: new Date().toISOString() },
          },
        ],
      };
    case 'turnRequested':
      return { ...state, turnActive: true, activeStream: action.stream };
    case 'streamOpen':
      return { ...state, openStreams: state.openStreams + 1, streamOpen: true };
    case 'streamClosed': {
      const openStreams = Math.max(0, state.openStreams - 1);
      const owned = state.activeStream === action.stream;
      return {
        ...state,
        openStreams,
        streamOpen: openStreams > 0,
        turnActive: owned ? false : state.turnActive,
        activeStream: owned ? null : state.activeStream,
      };
    }
    case 'sendFailed':
      return {
        ...state,
        turnActive: false,
        items: [
          ...state.items.map((i) => (i.key === action.key && i.kind === 'output' ? { ...i, pending: false, failed: true } : i)),
          { key: `err-${++seq}`, kind: 'error', message: action.message },
        ],
      };
    case 'event':
      return applyEvent(state, action.ev, action.stream);
  }
}

function applyEvent(state: ChatState, ev: StreamEvent, stream?: number): ChatState {
  // turn_done / end from an older stream (its observers finishing) must not
  // end the turn that is running now.
  const owns = stream === undefined || stream === state.activeStream;
  switch (ev.kind) {
    case 'turn_start':
      return {
        ...state,
        currentTurn: ev.turn,
        turnActive: true,
        snapshots: { ...state.snapshots, [ev.turn]: ev.snapshot },
        liveTurns: state.liveTurns.includes(ev.turn) ? state.liveTurns : [...state.liveTurns, ev.turn],
        chat: state.chat ? { ...state.chat, turns: Math.max(state.chat.turns, ev.turn) } : state.chat,
      };
    case 'output': {
      const { kind: _kind, ...rest } = ev;
      const out = rest as ChatOutput;
      if (out.id != null && state.items.some((i) => i.kind === 'output' && i.output.id === out.id)) return state;
      if (out.type === 'user') {
        // Replace the optimistic bubble.
        const idx = state.items.findIndex((i) => i.kind === 'output' && i.pending && i.output.type === 'user');
        if (idx >= 0) {
          const items = [...state.items];
          items[idx] = { key: outputKey(out), kind: 'output', output: out };
          return { ...state, items };
        }
      }
      return { ...state, items: [...state.items, { key: outputKey(out), kind: 'output', output: out }] };
    }
    case 'trace': {
      const { kind: _kind, ...trace } = ev;
      const turn = typeof trace.turn === 'number' ? trace.turn : state.currentTurn;
      return { ...state, liveTraces: [...state.liveTraces, { ...trace, turn, seq: ++seq }] };
    }
    case 'turn_done':
      return owns ? { ...state, turnActive: false } : state;
    case 'error':
      return { ...state, items: [...state.items, { key: `err-${++seq}`, kind: 'error', message: ev.message }] };
    case 'end':
      return owns ? { ...state, turnActive: false } : state;
    default:
      return state;
  }
}

export function useChat({
  systemId,
  chatId,
  profileId,
  onChatCreated,
  onViewer,
}: {
  systemId: string;
  chatId: string | undefined;
  profileId: number | null;
  onChatCreated: (id: string) => void;
  onViewer: (o: ViewerOutput) => void;
}) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Every open stream's controller: switching chats aborts them all, but a
  // new turn leaves the previous turn's observer stream running.
  const ctrlsRef = useRef(new Set<AbortController>());
  const createdRef = useRef<string | null>(null);
  const onViewerRef = useRef(onViewer);
  onViewerRef.current = onViewer;

  const abortAll = useCallback(() => {
    ctrlsRef.current.forEach((c) => c.abort());
    ctrlsRef.current.clear();
  }, []);

  const consume = useCallback(
    async (open: () => Promise<Response>, ctrl: AbortController, stream: number, localKey?: string) => {
      ctrlsRef.current.add(ctrl);
      dispatch({ type: 'streamOpen' });
      try {
        const res = await open();
        await readSSE<StreamEvent>(res, (ev) => {
          if (ctrl.signal.aborted) return;
          dispatch({ type: 'event', ev, stream });
          if (ev.kind === 'output' && ev.type === 'viewer') onViewerRef.current(ev);
        });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const message = errorLines(e).join('\n');
        if (localKey) dispatch({ type: 'sendFailed', key: localKey, message });
        else dispatch({ type: 'event', ev: { kind: 'error', message }, stream });
      } finally {
        ctrlsRef.current.delete(ctrl);
        if (!ctrl.signal.aborted) dispatch({ type: 'streamClosed', stream });
      }
    },
    [],
  );

  const startTurn = useCallback(
    async (id: string, text: string, localKey: string): Promise<void> => {
      const ctrl = new AbortController();
      const stream = ++seq;
      dispatch({ type: 'turnRequested', stream });
      await consume(() => api.chats.send(id, text, ctrl.signal), ctrl, stream, localKey);
    },
    [consume],
  );

  // Load (or reset) when the chat changes.
  useEffect(() => {
    if (chatId && createdRef.current === chatId) {
      // We just created this chat and are already streaming into it.
      createdRef.current = null;
      return;
    }
    abortAll();
    if (!chatId) {
      dispatch({ type: 'reset' });
      return;
    }
    const ctrl = new AbortController();
    ctrlsRef.current.add(ctrl);
    dispatch({ type: 'loading' });
    api.chats
      .get(chatId)
      .then((detail) => {
        if (ctrl.signal.aborted) return;
        dispatch({ type: 'loaded', detail });
        if (detail.running || detail.observing) {
          const stream = ++seq;
          if (detail.running) dispatch({ type: 'turnRequested', stream });
          void consume(() => api.chats.attach(chatId, ctrl.signal), ctrl, stream);
        } else {
          ctrlsRef.current.delete(ctrl);
        }
      })
      .catch((error: unknown) => {
        if (!ctrl.signal.aborted) dispatch({ type: 'loadError', error });
      });
  }, [systemId, chatId, consume, abortAll]);

  useEffect(() => abortAll, [abortAll]);

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      const s = stateRef.current;
      if (!t || s.turnActive) return;
      const key = `local-${++seq}`;
      let id = chatId ?? s.chat?.id;
      if (!id) {
        try {
          const chat = await api.chats.create(systemId, profileId);
          id = chat.id;
          createdRef.current = chat.id;
          dispatch({ type: 'chatCreated', chat });
          onChatCreated(chat.id);
        } catch (e) {
          dispatch({ type: 'event', ev: { kind: 'error', message: `Could not start a chat: ${errorLines(e).join('; ')}` } });
          return;
        }
      }
      dispatch({ type: 'localUser', text: t, key });
      // The server accepts the next turn as soon as the previous one sent
      // turn_done; its observers keep streaming on their own connection.
      await startTurn(id, t, key);
    },
    [chatId, systemId, profileId, onChatCreated, startTurn],
  );

  return { state, send };
}
