// One visitor conversation on the chat page: its outputs (history + live),
// the reply in progress and its SSE streams. Like pages/chat/useChat, minus
// traces; the first message creates the conversation.

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { readSSE } from '../lib/sse';
import type { PublicConversation, PublicConversationDetail, PublicOutput, PublicStreamEvent, PublicViewerOutput } from '../types';
import { messageOf, statusOf, type PublicApi } from './publicApi';

export type Item =
  | { key: string; kind: 'output'; output: PublicOutput; pending?: boolean; failed?: string }
  | { key: string; kind: 'error'; message: string };

export interface ConversationState {
  conv: PublicConversation | null;
  items: Item[];
  /** Messages used so far (the link allows max_turns). */
  turns: number;
  /** From sending until turn_done: the visitor can't send again. */
  turnActive: boolean;
  /** The active turn has shown something already (waiting for more, not for a first reply). */
  replied: boolean;
  /** The stream whose turn is active; only its turn_done/end clear turnActive. */
  activeStream: number | null;
  loading: boolean;
  /** It can't go on: ended, or erased on the server. */
  ended: boolean;
}

type Action =
  | { type: 'reset' }
  | { type: 'loading' }
  | { type: 'loaded'; detail: PublicConversationDetail }
  | { type: 'summary'; conv: PublicConversation }
  | { type: 'started'; conv: PublicConversation }
  | { type: 'ended' }
  | { type: 'localUser'; text: string; key: string; replace?: string }
  | { type: 'turnRequested'; stream: number }
  | { type: 'event'; ev: PublicStreamEvent; stream?: number }
  | { type: 'streamClosed'; stream: number }
  | { type: 'sendFailed'; key: string; message: string };

const initial: ConversationState = {
  conv: null,
  items: [],
  turns: 0,
  turnActive: false,
  replied: false,
  activeStream: null,
  loading: false,
  ended: false,
};

let seq = 0;
const outputKey = (o: PublicOutput) => (o.id != null ? `o${o.id}` : `t${o.turn}-${o.type}-${++seq}`);
const hasOutput = (items: Item[], id: number | null | undefined) =>
  id != null && items.some((i) => i.kind === 'output' && i.output.id === id);

function reducer(state: ConversationState, action: Action): ConversationState {
  switch (action.type) {
    case 'reset':
      return initial;
    case 'loading':
      return { ...initial, loading: true };
    case 'loaded': {
      const { outputs, ...conv } = action.detail;
      return {
        ...initial,
        conv,
        turns: conv.turns,
        ended: conv.ended,
        items: outputs.map((o) => ({ key: outputKey(o), kind: 'output', output: o })),
      };
    }
    case 'summary':
      return { ...state, conv: action.conv, turns: Math.max(state.turns, action.conv.turns), ended: state.ended || action.conv.ended };
    case 'started':
      return { ...state, conv: action.conv };
    case 'ended':
      return { ...state, ended: true, turnActive: false };
    case 'localUser': {
      const items = action.replace ? state.items.filter((i) => i.key !== action.replace) : state.items;
      const output: PublicOutput = { type: 'user', content: action.text, turn: null, ts: new Date().toISOString() };
      return { ...state, items: [...items, { key: action.key, kind: 'output', pending: true, output }] };
    }
    case 'turnRequested':
      return { ...state, turnActive: true, replied: false, activeStream: action.stream };
    case 'streamClosed': {
      const owned = state.activeStream === action.stream;
      return owned ? { ...state, turnActive: false, activeStream: null } : state;
    }
    case 'sendFailed':
      return {
        ...state,
        turnActive: false,
        activeStream: null,
        items: state.items.map((i) => (i.key === action.key && i.kind === 'output' ? { ...i, pending: false, failed: action.message } : i)),
      };
    case 'event':
      return applyEvent(state, action.ev, action.stream);
  }
}

function applyEvent(state: ConversationState, ev: PublicStreamEvent, stream?: number): ConversationState {
  // turn_done / end of an older stream (memory work finishing after its
  // reply) must not end the turn that is running now.
  const owns = stream === undefined || stream === state.activeStream;
  switch (ev.kind) {
    case 'turn_start':
      return { ...state, turns: Math.max(state.turns, ev.turn), turnActive: true, replied: false };
    case 'output': {
      const { kind: _kind, ...rest } = ev;
      const out = rest as PublicOutput;
      if (hasOutput(state.items, out.id)) return state;
      if (out.type === 'user') {
        // Replace the optimistic bubble.
        const idx = state.items.findIndex((i) => i.kind === 'output' && i.pending && i.output.type === 'user');
        if (idx >= 0) {
          const items = [...state.items];
          items[idx] = { key: outputKey(out), kind: 'output', output: out };
          return { ...state, items };
        }
      }
      return {
        ...state,
        replied: state.replied || out.type !== 'user',
        items: [...state.items, { key: outputKey(out), kind: 'output', output: out }],
      };
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

export function useConversation({
  api,
  onViewer,
  onStarted,
  onNeedsCode,
}: {
  api: PublicApi;
  /** A course page arrived live. */
  onViewer: (o: PublicViewerOutput) => void;
  /** The first message created a conversation. */
  onStarted: (conv: PublicConversation) => void;
  /** The server wants the access code (again). */
  onNeedsCode: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initial);
  const stateRef = useRef(state);
  stateRef.current = state;
  const ctrlsRef = useRef(new Set<AbortController>());
  const callbacks = useRef({ onViewer, onStarted, onNeedsCode });
  callbacks.current = { onViewer, onStarted, onNeedsCode };

  const abortAll = useCallback(() => {
    ctrlsRef.current.forEach((c) => c.abort());
    ctrlsRef.current.clear();
  }, []);
  useEffect(() => abortAll, [abortAll]);

  /** Re-reads the conversation after a refused message: ended, erased, or out of messages. */
  const refresh = useCallback(
    async (id: string, withOutputs = false) => {
      try {
        const detail = await api.conversation(id);
        if (stateRef.current.conv?.id !== id) return;
        if (withOutputs) dispatch({ type: 'loaded', detail });
        else dispatch({ type: 'summary', conv: detail });
      } catch (e) {
        const status = statusOf(e);
        if (stateRef.current.conv?.id === id && (status === 404 || status === 410)) dispatch({ type: 'ended' });
      }
    },
    [api],
  );

  const consume = useCallback(
    async (open: () => Promise<Response>, ctrl: AbortController, stream: number, convId: string, localKey?: string) => {
      ctrlsRef.current.add(ctrl);
      try {
        const res = await open();
        await readSSE<PublicStreamEvent>(res, (ev) => {
          if (ctrl.signal.aborted) return;
          if (ev.kind === 'output' && ev.type === 'viewer' && !hasOutput(stateRef.current.items, ev.id)) {
            const { kind: _kind, ...viewer } = ev;
            callbacks.current.onViewer(viewer as PublicViewerOutput);
          }
          dispatch({ type: 'event', ev, stream });
        });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        const status = statusOf(e);
        if (!localKey && status === 404) {
          // The reply finished before we re-attached: show it as it ended.
          void refresh(convId, true);
        } else if (localKey) {
          dispatch({ type: 'sendFailed', key: localKey, message: messageOf(e) });
        } else {
          dispatch({ type: 'event', ev: { kind: 'error', message: messageOf(e) }, stream });
        }
        if (status === 403) callbacks.current.onNeedsCode();
        else if (localKey && (status === 404 || status === 409 || status === 410)) void refresh(convId);
      } finally {
        ctrlsRef.current.delete(ctrl);
        if (!ctrl.signal.aborted) dispatch({ type: 'streamClosed', stream });
      }
    },
    [refresh],
  );

  /** Shows one of this visitor's conversations (re-attaching to a reply in progress). Throws when it is gone. */
  const open = useCallback(
    async (id: string) => {
      abortAll();
      dispatch({ type: 'loading' });
      const ctrl = new AbortController();
      ctrlsRef.current.add(ctrl);
      try {
        const detail = await api.conversation(id);
        if (ctrl.signal.aborted) return;
        dispatch({ type: 'loaded', detail });
        if (detail.running) {
          const stream = ++seq;
          dispatch({ type: 'turnRequested', stream });
          void consume(() => api.attach(id, ctrl.signal), ctrl, stream, id);
        } else {
          ctrlsRef.current.delete(ctrl);
        }
      } catch (e) {
        ctrlsRef.current.delete(ctrl);
        if (ctrl.signal.aborted) return;
        dispatch({ type: 'reset' });
        throw e;
      }
    },
    [api, abortAll, consume],
  );

  /** Back to the welcome screen (an open conversation stays on the server). */
  const reset = useCallback(() => {
    abortAll();
    dispatch({ type: 'reset' });
  }, [abortAll]);

  /** Sends a message; the first one creates the conversation. `retry`: the failed bubble it replaces. */
  const send = useCallback(
    async (text: string, consent: boolean, retry?: string) => {
      const t = text.trim();
      const s = stateRef.current;
      if (!t || s.turnActive || s.ended) return;
      const key = `local-${++seq}`;
      dispatch({ type: 'localUser', text: t, key, replace: retry });
      let id = s.conv?.id;
      if (!id) {
        try {
          const conv = await api.start(consent);
          id = conv.id;
          dispatch({ type: 'started', conv });
          callbacks.current.onStarted(conv);
        } catch (e) {
          dispatch({ type: 'sendFailed', key, message: messageOf(e) });
          if (statusOf(e) === 403) callbacks.current.onNeedsCode();
          return;
        }
      }
      const convId = id;
      const ctrl = new AbortController();
      const stream = ++seq;
      dispatch({ type: 'turnRequested', stream });
      await consume(() => api.send(convId, t, ctrl.signal), ctrl, stream, convId, key);
    },
    [api, consume],
  );

  return { state, open, reset, send };
}
