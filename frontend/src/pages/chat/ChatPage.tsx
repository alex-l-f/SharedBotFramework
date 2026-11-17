import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { Markdown } from '../../components/Markdown';
import { ScopeToggle, useScope } from '../../components/team';
import { Badge, ErrorBox, Loading, Spinner } from '../../components/ui';
import { useDragResize, useLoad, useLocalStorage } from '../../lib/hooks';
import { userFacingNodes } from '../../lib/util';
import type { ViewerOutput } from '../../types';
import { ProfilePicker, SessionsDrawer, useReadOnlyReason, ViewerPanel } from './ChatParts';
import { DebugPanel } from './DebugPanel';
import { OutputView } from './OutputView';
import { statusFromTrace } from './status';
import { useChat } from './useChat';

export function ChatPage() {
  const { systemId = '', chatId } = useParams();
  const navigate = useNavigate();
  const system = useLoad(() => api.systems.get(systemId), [systemId]);
  const [profileScopePref, setProfileScopePref] = useLocalStorage<'mine' | 'all'>('sbf.chat.profileScope', 'mine');
  const profileScope = useScope(profileScopePref);
  const profiles = useLoad(() => api.profiles.list(profileScope), [profileScope]);
  const [prefProfile, setPrefProfile] = useLocalStorage<number | null>(`sbf.profile.${systemId}`, null);
  const [debug, setDebug] = useLocalStorage('sbf.chat.debug', false);
  const [debugHeight, setDebugHeight] = useLocalStorage('sbf.chat.debugHeight', 300);
  const [viewerWidth, setViewerWidth] = useLocalStorage('sbf.chat.viewerWidth', 560);
  const [viewer, setViewer] = useState<{ url: string; title: string } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [input, setInput] = useState('');
  const onDebugResize = useDragResize(debugHeight, setDebugHeight, 'y', -1, 120, 900);
  const onViewerResize = useDragResize(viewerWidth, setViewerWidth, 'x', -1, 320, 1400);

  const sys = system.data;
  const showViewerRef = useRef(true);
  showViewerRef.current = sys?.ui.show_viewer ?? true;
  const openViewer = useCallback((o: ViewerOutput) => {
    if (showViewerRef.current && o.url) setViewer({ url: o.url, title: o.title });
  }, []);

  // A remembered profile that no longer exists counts as none.
  const prefValid = prefProfile != null && (!profiles.data || profiles.data.some((p) => p.id === prefProfile)) ? prefProfile : null;

  const onChatCreated = useCallback((id: string) => navigate(`/chat/${systemId}/${id}`, { replace: true }), [navigate, systemId]);
  const { state, send } = useChat({ systemId, chatId, profileId: prefValid, onChatCreated, onViewer: openViewer });

  // Close the viewer when switching to another chat (not when we just created this one).
  const shownChat = state.chat?.id;
  const shownChatRef = useRef(shownChat);
  shownChatRef.current = shownChat;
  useEffect(() => {
    if (shownChatRef.current !== chatId) setViewer(null);
  }, [chatId]);

  const activeProfile = state.chat ? state.chat.profile_id : prefValid;
  const locked = !!sys?.ui.require_profile && activeProfile == null;
  // A visitor conversation from a chat link: name the link it came through.
  const linkId = state.chat?.origin === 'link' ? (state.chat.link_id ?? null) : null;
  const link = useLoad(() => (linkId ? api.links.get(linkId) : Promise.resolve(null)), [linkId]);
  // Someone else's chat (or a simulated or visitor one) can be read but not written in.
  const readOnly = useReadOnlyReason(state.chat, link.data?.label);

  const entryNode = sys?.nodes.find((n) => n.id === sys.entry);
  const facing = useMemo(() => (sys ? userFacingNodes(sys) : new Set<string>()), [sys]);
  const nodeLabel = useCallback((id: string | null) => (id ? sys?.nodes.find((n) => n.id === id)?.label || id : 'assistant'), [sys]);
  const delegates = useMemo(
    () => new Map((sys?.links ?? []).filter((l) => l.type === 'delegate' && l.tool_name).map((l) => [l.tool_name as string, l.target])),
    [sys],
  );

  // Current mode: the latest mode output, else the session state, else the entry's initial mode.
  const mode = useMemo(() => {
    for (let i = state.items.length - 1; i >= 0; i--) {
      const it = state.items[i];
      if (it.kind === 'output' && it.output.type === 'mode') return { id: it.output.mode, label: it.output.label };
    }
    const modes = state.sessionState.modes as Record<string, string> | undefined;
    const id = modes?.[sys?.entry ?? ''] ?? entryNode?.initial_mode ?? entryNode?.modes[0]?.id;
    if (!id) return null;
    return { id, label: entryNode?.modes.find((m) => m.id === id)?.label || id };
  }, [state.items, state.sessionState, sys, entryNode]);

  const status = useMemo(() => {
    if (!state.streamOpen && !state.turnActive) return null;
    const turnTraces = state.liveTraces.filter((t) => t.turn === state.currentTurn);
    const last = turnTraces[turnTraces.length - 1];
    if (state.turnActive) return { busy: true, text: statusFromTrace(last, { entry: sys?.entry ?? '', label: nodeLabel, delegates }) };
    return { busy: false, text: last ? `${nodeLabel(last.agent)} is finishing up in the background…` : 'Finishing up…' };
  }, [state.streamOpen, state.turnActive, state.liveTraces, state.currentTurn, sys, nodeLabel, delegates]);

  // Keep the newest message in view unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [state.items.length, status?.text]);
  useEffect(() => {
    stick.current = true;
  }, [chatId]);

  const submit = (text: string) => {
    if (!text.trim() || locked || readOnly || state.turnActive) return;
    stick.current = true;
    void send(text);
    setInput('');
  };

  const newChat = () => {
    setDrawer(false);
    navigate(`/chat/${systemId}`);
  };

  if (system.error != null)
    return (
      <div className="page">
        <ErrorBox error={system.error} onRetry={system.reload} title={`Could not load system "${systemId}"`} />
        <Link to="/chat">← Choose a system</Link>
      </div>
    );
  if (!sys)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const title = sys.ui.title || sys.name || sys.id;
  const empty = state.items.length === 0 && !state.loading;
  const inputDisabled = locked || state.turnActive || state.loading;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-title">
          <h1>{title}</h1>
          {mode && (
            <Badge tone="accent" title={`mode: ${mode.id}`}>
              {mode.label}
            </Badge>
          )}
          {state.chat && <span className="muted small mono" title="Chat id">{state.chat.id.slice(0, 8)}</span>}
          {readOnly && <Badge tone="muted">read-only</Badge>}
        </div>
        <div className="chat-actions">
          <ScopeToggle value={profileScope} onChange={setProfileScopePref} />
          <ProfilePicker
            profiles={profiles.data ?? []}
            showOwner={profileScope === 'all'}
            value={activeProfile}
            allowNone={!sys.ui.require_profile}
            onChange={(id) => {
              setPrefProfile(id);
              if (chatId || state.items.length) navigate(`/chat/${systemId}`);
            }}
            onCreated={(p) => {
              profiles.reload();
              setPrefProfile(p.id);
              if (chatId || state.items.length) navigate(`/chat/${systemId}`);
            }}
          />
          <button className="btn btn-sm" onClick={newChat}>
            New chat
          </button>
          <button className="btn btn-sm" onClick={() => setDrawer(true)}>
            Sessions
          </button>
          <label className="check small debug-toggle">
            <input type="checkbox" checked={debug} onChange={(e) => setDebug(e.target.checked)} /> Debug
          </label>
          <Link className="btn btn-sm btn-ghost" to={`/systems/${systemId}`} title="Edit system">
            ⚙
          </Link>
        </div>
      </header>

      <div className="chat-main">
        <div className="chat-column">
          <div
            className="chat-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="chat-thread">
              {state.loading && <Loading label="Loading chat…" />}
              {state.loadError != null && (
                <ErrorBox error={state.loadError} title="Could not load this chat" />
              )}
              {empty && state.loadError == null && (
                <div className="welcome">
                  <h2>{title}</h2>
                  {sys.ui.welcome && <Markdown>{sys.ui.welcome}</Markdown>}
                  {readOnly ? null : locked ? (
                    <div className="notice notice-info">Choose or create a profile (top right) to start chatting.</div>
                  ) : (
                    sys.ui.starters.length > 0 && (
                      <div className="starters">
                        {sys.ui.starters.map((s) => (
                          <button key={s} type="button" className="starter" disabled={inputDisabled} onClick={() => submit(s)}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )
                  )}
                </div>
              )}
              {state.items.map((item) => (
                <OutputView
                  key={item.key}
                  item={item}
                  nodeLabel={nodeLabel}
                  showNode={facing.size > 1}
                  onOpenViewer={sys.ui.show_viewer ? (o) => setViewer({ url: o.url, title: o.title }) : undefined}
                  onRetry={(text) => submit(text)}
                />
              ))}
            </div>
          </div>
          {status && (
            <div className={`chat-status${status.busy ? '' : ' background'}`}>
              {status.busy && <Spinner />} {status.text}
            </div>
          )}
          {readOnly && (
            <div className="chat-readonly">
              {readOnly}.{' '}
              {link.data && (
                <>
                  <Link to={`/links/${link.data.id}`}>Link settings</Link> ·{' '}
                </>
              )}
              <button type="button" className="link-btn" onClick={newChat}>
                Start your own chat
              </button>
            </div>
          )}
          <form
            hidden={!!readOnly}
            className="chat-input"
            onSubmit={(e) => {
              e.preventDefault();
              submit(input);
            }}
          >
            <textarea
              value={input}
              rows={Math.min(8, Math.max(1, input.split('\n').length))}
              placeholder={locked ? 'Choose a profile to start' : state.turnActive ? 'Waiting for the reply…' : 'Message… (Enter to send, Shift+Enter for a new line)'}
              disabled={locked || state.loading}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit(input);
                }
              }}
            />
            <button type="submit" className="btn btn-primary" disabled={inputDisabled || !input.trim()}>
              Send
            </button>
          </form>
        </div>
        {viewer && sys.ui.show_viewer && (
          <ViewerPanel url={viewer.url} title={viewer.title} width={viewerWidth} onResizeStart={onViewerResize} onClose={() => setViewer(null)} />
        )}
      </div>

      {debug && (
        <>
          <div className="splitter-y" onMouseDown={onDebugResize} title="Drag to resize" />
          <div className="debug-wrap" style={{ height: debugHeight }}>
            <DebugPanel
              chatId={state.chat?.id ?? chatId ?? null}
              liveTraces={state.liveTraces}
              liveTurns={state.liveTurns}
              snapshots={state.snapshots}
              streamOpen={state.streamOpen}
            />
          </div>
        </>
      )}

      {drawer && (
        <SessionsDrawer
          systemId={systemId}
          currentChatId={chatId}
          profiles={profiles.data ?? []}
          onClose={() => setDrawer(false)}
          onNew={newChat}
          onOpen={(id) => {
            setDrawer(false);
            navigate(`/chat/${systemId}/${id}`);
          }}
        />
      )}
    </div>
  );
}

