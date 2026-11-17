// The standalone chat page of a chat link (/c/<token>), for visitors without
// an account: none of the management interface. It loads what the link
// shows, asks for the access code when there is one, resumes this browser's
// open conversation (re-attaching to a reply in progress), and otherwise
// starts on the welcome screen, where the first message creates the
// conversation.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../components/Markdown';
import type { PublicConversation, PublicInfo, PublicViewerOutput } from '../types';
import { Composer, CourseViewer, Dialog, fmtWhen, Menu, MessageView, Screen, Spinner, Typing, useMediaQuery, type MenuItem } from './parts';
import { messageOf, publicApi, statusOf, tokenFromPath, type PublicApi } from './publicApi';
import { useConversation } from './useConversation';

type Phase =
  | { kind: 'loading' }
  | { kind: 'problem'; title: string; message: string; retry?: boolean }
  | { kind: 'code' }
  | { kind: 'chat' };

type Flash = { tone: 'info' | 'error'; text: string };

const CLOSED: Record<string, { title: string; message: string }> = {
  expired: { title: 'This chat has ended', message: 'The link has expired, so it no longer takes messages.' },
  full: { title: 'This chat is full', message: "It isn't taking new conversations at the moment." },
  unavailable: { title: "This chat isn't available", message: 'Something is wrong on our side. Please try again later.' },
};

function problemFor(err: unknown): Phase {
  const status = statusOf(err);
  if (status === 404)
    return {
      kind: 'problem',
      title: 'Link not found',
      message: `${messageOf(err)} Check that you have the whole address, or ask whoever shared it for a new one.`,
    };
  if (status === 410) return { kind: 'problem', title: 'This chat is closed', message: messageOf(err) };
  return { kind: 'problem', title: "Can't load the chat", message: messageOf(err), retry: true };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The quiet line under the message box: is this kept, and is the visitor remembered? */
function savingLine(info: PublicInfo): string {
  const idle = info.idle_minutes ? `after ${info.idle_minutes} minutes without a message` : 'after a while without a message';
  let line = info.saving
    ? 'Saved — the people who run this chat can read this conversation.'
    : `Not saved — erased when you end it or ${idle}.`;
  if (info.remembers) line += ' This chat keeps anonymous notes between your visits from this browser.';
  return line;
}

export function PublicChat() {
  const token = useMemo(() => tokenFromPath(window.location.pathname), []);
  const api = useMemo(() => publicApi(token), [token]);
  const [info, setInfo] = useState<PublicInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [history, setHistory] = useState<PublicConversation[]>([]);
  const [consent, setConsent] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [dialog, setDialog] = useState<'end' | 'earlier' | 'about' | null>(null);
  const [viewer, setViewer] = useState<{ url: string; title: string } | null>(null);
  const wide = useMediaQuery('(min-width: 900px)');
  const wideRef = useRef(wide);
  wideRef.current = wide;
  const infoRef = useRef(info);
  infoRef.current = info;

  const refreshHistory = useCallback(async () => {
    try {
      setHistory(await api.conversations());
    } catch {
      /* keep the list we have */
    }
  }, [api]);

  const convo = useConversation({
    api,
    // A course page arriving live opens beside the chat; on phones it waits for a tap.
    onViewer: (o) => {
      if (infoRef.current?.show_viewer && wideRef.current) setViewer({ url: o.url, title: o.title });
    },
    onStarted: () => void refreshHistory(),
    onNeedsCode: () => setPhase({ kind: 'code' }),
  });
  const { open, reset } = convo;
  const c = convo.state;

  const boot = useCallback(async () => {
    setPhase({ kind: 'loading' });
    let i: PublicInfo;
    try {
      i = await api.info();
    } catch (e) {
      setPhase(problemFor(e));
      return;
    }
    setInfo(i);
    if (i.needs_code) {
      setPhase({ kind: 'code' });
      return;
    }
    if (i.status === 'expired' || i.status === 'unavailable') {
      setPhase({ kind: 'problem', ...CLOSED[i.status] });
      return;
    }
    let list: PublicConversation[] = [];
    try {
      list = await api.conversations();
    } catch {
      /* start afresh */
    }
    setHistory(list);
    // Resume the latest conversation that is still going (a full link still lets it finish).
    const current = list.find((h) => !h.ended);
    if (current) {
      try {
        await open(current.id);
        setPhase({ kind: 'chat' });
        return;
      } catch {
        /* gone meanwhile: start afresh */
      }
    }
    setPhase(i.status === 'full' ? { kind: 'problem', ...CLOSED.full } : { kind: 'chat' });
  }, [api, open]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    document.title = info?.title || 'Chat';
  }, [info?.title]);

  // Keep the newest message in view unless the visitor scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [c.items.length, c.turnActive, c.replied, c.ended]);

  const startFresh = useCallback(
    (message: Flash | null = null) => {
      reset();
      setConsent(false);
      setViewer(null);
      setFlash(message);
      stick.current = true;
      void refreshHistory();
    },
    [reset, refreshHistory],
  );

  if (!token)
    return (
      <Screen icon="chat" title="Link not found">
        <p>This address isn't a complete chat link. Check that you have the whole address.</p>
      </Screen>
    );
  if (phase.kind === 'loading')
    return (
      <Screen>
        <Spinner label="Loading…" />
      </Screen>
    );
  if (phase.kind === 'problem')
    return (
      <Screen icon="chat" title={phase.title}>
        <p>{phase.message}</p>
        {phase.retry && (
          <button type="button" className="pc-btn pc-btn-primary" onClick={() => void boot()}>
            Try again
          </button>
        )}
      </Screen>
    );
  if (phase.kind === 'code' || !info) return <CodeScreen title={info?.title} api={api} onDone={() => void boot()} />;

  const started = c.conv != null || c.items.length > 0;
  const limitReached = !!c.conv && !c.turnActive && c.turns >= info.max_turns;
  const needsConsent = !started && info.require_consent && !consent;
  const canSend = !c.turnActive && !c.ended && !limitReached && !c.loading && !needsConsent;
  const left = info.max_turns - c.turns;
  const earlier = history.filter((h) => h.id !== c.conv?.id);
  const openCourse = info.show_viewer ? (o: PublicViewerOutput) => setViewer({ url: o.url, title: o.title }) : undefined;

  const submit = (text: string, retry?: string) => {
    if (!canSend) return;
    stick.current = true;
    setFlash(null);
    void convo.send(text, consent, retry);
  };

  const end = async () => {
    const id = c.conv?.id;
    setDialog(null);
    if (!id) return;
    try {
      const r = await api.end(id);
      startFresh({ tone: 'info', text: r.erased ? 'Your conversation has ended and was erased.' : 'Your conversation has ended.' });
    } catch (e) {
      const status = statusOf(e);
      if (status === 404 || status === 410) startFresh({ tone: 'info', text: 'That conversation had already ended.' });
      else setFlash({ tone: 'error', text: messageOf(e) });
    }
  };

  const openEarlier = async (id: string) => {
    setDialog(null);
    setViewer(null);
    setFlash(null);
    stick.current = true;
    try {
      await open(id);
    } catch (e) {
      const status = statusOf(e);
      setFlash({ tone: 'error', text: status === 404 || status === 410 ? 'That conversation is no longer available.' : messageOf(e) });
      void refreshHistory();
    }
  };

  const menu: MenuItem[] = [{ label: 'New conversation', onSelect: () => startFresh(), disabled: !started }];
  if (c.conv && !c.ended)
    menu.push({ label: info.saving ? 'End conversation' : 'End and erase', onSelect: () => setDialog('end'), danger: !info.saving });
  if (earlier.length)
    menu.push({
      label: 'Earlier conversations',
      onSelect: () => {
        void refreshHistory();
        setDialog('earlier');
      },
    });
  menu.push({ label: 'About this chat', onSelect: () => setDialog('about') });

  const placeholder = needsConsent
    ? info.notice
      ? 'Accept the notice above to start'
      : 'Agree above to start'
    : c.turnActive
      ? c.replied
        ? 'Still replying…'
        : 'Waiting for the reply…'
      : 'Type your message…';

  return (
    <div className="pc-app">
      <header className="pc-header">
        <h1 className="pc-title">{info.title}</h1>
        <Menu items={menu} />
      </header>
      <div className="pc-body">
        <main className="pc-main">
          <div
            className="pc-scroll"
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="pc-thread">
              {flash && (
                <div className={`pc-flash ${flash.tone}`} role={flash.tone === 'error' ? 'alert' : 'status'}>
                  {flash.text}
                </div>
              )}
              {c.loading && <Spinner label="Loading your conversation…" />}
              {!started && !c.loading && (
                <section className="pc-welcome" aria-labelledby="pc-welcome-title">
                  <h2 id="pc-welcome-title">{info.title}</h2>
                  {info.welcome && <Markdown>{info.welcome}</Markdown>}
                  {(info.notice || info.require_consent) && (
                    <div className="pc-notice">
                      {info.notice && <Markdown>{info.notice}</Markdown>}
                      {info.require_consent && (
                        <label className="pc-consent">
                          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                          <span>{info.notice ? 'I have read this and agree' : 'I agree to take part in this conversation'}</span>
                        </label>
                      )}
                    </div>
                  )}
                  {info.starters.length > 0 && (
                    <div className="pc-starters" role="group" aria-label="Suggested messages">
                      {info.starters.map((s) => (
                        <button key={s} type="button" className="pc-starter" disabled={!canSend} onClick={() => submit(s)}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
              <div className="pc-messages" role="log" aria-live="polite" aria-label="Conversation">
                {c.items.map((item) => (
                  <MessageView key={item.key} item={item} onOpenCourse={openCourse} onRetry={canSend ? submit : undefined} />
                ))}
                {/* Until turn_done: systems often send a quick first line, then keep working. */}
                {c.turnActive && <Typing />}
              </div>
              {(limitReached || c.ended) && (
                <div className="pc-endcard">
                  <p>
                    {c.ended
                      ? 'This conversation has ended.'
                      : `You've reached the limit of ${plural(info.max_turns, 'message')} for this conversation.`}
                  </p>
                  <button type="button" className="pc-btn pc-btn-primary" onClick={() => startFresh()}>
                    Start a new conversation
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="pc-bottom">
            {!(limitReached || c.ended) && (
              <Composer
                disabled={c.loading || needsConsent}
                canSend={canSend}
                placeholder={placeholder}
                onSend={(text) => submit(text)}
                focusKey={c.conv?.id ?? 'new'}
              />
            )}
            <p className="pc-foot">
              {savingLine(info)}
              {c.conv && !limitReached && !c.ended && left > 0 && left <= 5 && <> {plural(left, 'message')} left in this conversation.</>}
            </p>
          </div>
        </main>
        {viewer && <CourseViewer url={viewer.url} title={viewer.title} full={!wide} onClose={() => setViewer(null)} />}
      </div>

      {dialog === 'end' && (
        <Dialog
          title={info.saving ? 'End this conversation?' : 'End and erase this conversation?'}
          onClose={() => setDialog(null)}
          actions={
            <>
              <button type="button" className="pc-btn pc-btn-quiet" data-autofocus onClick={() => setDialog(null)}>
                Keep chatting
              </button>
              <button type="button" className={`pc-btn ${info.saving ? 'pc-btn-primary' : 'pc-btn-danger'}`} onClick={() => void end()}>
                {info.saving ? 'End conversation' : 'End and erase'}
              </button>
            </>
          }
        >
          <p>
            {info.saving
              ? "It stays saved, but you won't be able to add to it. You can start a new conversation afterwards."
              : "It's deleted right away and can't be recovered. You can start a new conversation afterwards."}
          </p>
        </Dialog>
      )}
      {dialog === 'earlier' && (
        <Dialog title="Earlier conversations" onClose={() => setDialog(null)}>
          {earlier.length === 0 ? (
            <p className="pc-muted">No other conversations.</p>
          ) : (
            <ul className="pc-list">
              {earlier.map((h) => (
                <li key={h.id}>
                  <button type="button" className="pc-list-item" onClick={() => void openEarlier(h.id)}>
                    <span className="pc-list-title">{h.title || `Conversation of ${fmtWhen(h.started_at)}`}</span>
                    <span className="pc-list-sub">
                      {fmtWhen(h.last_at)} · {plural(h.turns, 'message')}
                      {h.ended ? ' · ended' : h.running ? ' · replying' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Dialog>
      )}
      {dialog === 'about' && (
        <Dialog title="About this chat" onClose={() => setDialog(null)}>
          {info.notice && <Markdown>{info.notice}</Markdown>}
          <p className="pc-muted">{savingLine(info)}</p>
          <p className="pc-muted">Each conversation can have up to {plural(info.max_turns, 'message')}.</p>
        </Dialog>
      )}
    </div>
  );
}

function CodeScreen({ title, api, onDone }: { title?: string; api: PublicApi; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Screen icon="lock" title={title || 'Chat'}>
      <p>This chat needs an access code. Enter the one you were given with the link.</p>
      <form
        className="pc-code-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!code.trim() || busy) return;
          setBusy(true);
          setError(null);
          try {
            await api.access(code.trim());
            onDone();
          } catch (err) {
            setError(messageOf(err));
            setBusy(false);
          }
        }}
      >
        <label htmlFor="pc-code">Access code</label>
        <input
          id="pc-code"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={code}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'pc-code-error' : undefined}
          onChange={(e) => setCode(e.target.value)}
        />
        {error && (
          <p className="pc-danger" id="pc-code-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="pc-btn pc-btn-primary" disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>
    </Screen>
  );
}
