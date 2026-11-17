import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Markdown } from '../../components/Markdown';
import { SavedBy } from '../../components/team';
import { Badge, DirtyDot, EmptyState, ErrorBox, Field, FieldGroup, Loading, MessageList, Modal, Notice, NumberInput, StringListEditor } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut, useUnsavedGuard } from '../../lib/hooks';
import { fmtDateTime, isEqual } from '../../lib/util';
import type { ChatLink, ChatLinkConversation, ChatLinkSettings } from '../../types';
import { CopyButton, DEFAULT_LINK_SETTINGS, LinkStatusBadge, linkUrl } from './linkParts';

interface Draft {
  label: string;
  system_id: string;
  active: boolean;
  settings: ChatLinkSettings;
}

const toDraft = (l: ChatLink): Draft => ({
  label: l.label,
  system_id: l.system_id,
  active: l.active,
  settings: { ...DEFAULT_LINK_SETTINGS, ...l.settings },
});

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** ISO date/time → a datetime-local input's value (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A random access code (no look-alike characters). */
function randomCode(length = 10): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/** A starting point for the notice, from the privacy settings. */
function suggestedNotice(s: ChatLinkSettings): string {
  const parts = [
    s.save_transcripts
      ? 'This conversation is saved, and the people who run this chat can read it.'
      : `This conversation isn't saved. It's erased when you end it, or after ${s.idle_minutes} minutes without a message.`,
  ];
  if (s.remember_visitors)
    parts.push('To help across visits, the chat keeps short anonymous notes linked to this browser — never the conversation itself.');
  parts.push("Please don't share names, contact details or other personal information.");
  return parts.join('\n\n');
}

function problemsOf(d: Draft, codeMode: 'keep' | 'set' | 'remove', codeText: string): string[] {
  const s = d.settings;
  const out: string[] = [];
  if (!d.system_id) out.push('Choose the system visitors chat with.');
  if (codeMode === 'set' && codeText.trim().length < 8) out.push('The access code needs at least 8 characters.');
  if (codeMode === 'set' && codeText.trim().length > 200) out.push('The access code can have at most 200 characters.');
  if (s.max_turns < 1 || s.max_turns > 500) out.push('Messages per conversation: 1 to 500.');
  if (s.messages_per_minute < 1 || s.messages_per_minute > 120) out.push('Messages per minute: 1 to 120.');
  if (s.idle_minutes < 5 || s.idle_minutes > 1440) out.push('Minutes idle before an unsaved conversation is erased: 5 to 1440.');
  if (s.max_conversations != null && s.max_conversations < 1) out.push('Conversations in total: at least 1 (blank: no limit).');
  if (s.require_consent && !s.notice.trim()) out.push('Write a notice for visitors to accept, or stop requiring it.');
  return out;
}

/** /links/:linkId (and /links/new?system=<id>) — one chat link: its settings, URL, counts and conversations. */
export function LinkEditor() {
  const { linkId = '' } = useParams();
  const isNew = linkId === 'new';
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const canEdit = useAuth().can('editor');
  const loaded = useLoad(() => (isNew || !canEdit ? Promise.resolve(null) : api.links.get(linkId)), [linkId, canEdit]);
  const convs = useLoad(() => (isNew || !canEdit ? Promise.resolve([] as ChatLinkConversation[]) : api.links.conversations(linkId)), [linkId, canEdit]);
  const systems = useLoad(api.systems.list, []);

  const [saved, setSaved] = useState<ChatLink | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // The access code is write-only: keep it, set a new one, or remove it.
  const [codeMode, setCodeMode] = useState<'keep' | 'set' | 'remove'>('keep');
  const [codeText, setCodeText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'delete' | null>(null);

  const presetSystem = params.get('system') ?? '';
  useEffect(() => {
    let next: Draft | null = null;
    if (isNew) next = { label: '', system_id: presetSystem, active: true, settings: { ...DEFAULT_LINK_SETTINGS } };
    else if (loaded.data) next = toDraft(loaded.data);
    if (!next) return;
    setSaved(isNew ? null : loaded.data ?? null);
    setBase(next);
    setDraft(next);
    setCodeMode('keep');
    setCodeText('');
  }, [isNew, presetSystem, loaded.data]);

  useEffect(() => {
    const f = (location.state as { flash?: string } | null)?.flash;
    if (f) setFlash(f);
  }, [location.state]);
  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 2500);
    return () => window.clearTimeout(t);
  }, [flash]);

  const dirty = !!draft && !!base && (!isEqual(draft, base) || codeMode !== 'keep');
  const { allowNext } = useUnsavedGuard(dirty && canEdit);
  const problems = useMemo(() => (draft ? problemsOf(draft, codeMode, codeText) : []), [draft, codeMode, codeText]);

  const save = async () => {
    if (!draft || busy || problems.length || (!dirty && !isNew)) return;
    setBusy(true);
    setError(null);
    const body = { label: draft.label.trim(), system_id: draft.system_id, active: draft.active, settings: draft.settings };
    try {
      if (isNew) {
        const created = await api.links.create({ ...body, access_code: codeMode === 'set' ? codeText.trim() : undefined });
        allowNext();
        navigate(`/links/${created.id}`, { replace: true, state: { flash: 'Link created' } });
      } else {
        const access_code = codeMode === 'keep' ? null : codeMode === 'remove' ? '' : codeText.trim();
        const updated = await api.links.update(linkId, { ...body, access_code });
        const next = toDraft(updated);
        setSaved(updated);
        setBase(next);
        setDraft(next);
        setCodeMode('keep');
        setCodeText('');
        setFlash('Saved');
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), canEdit && (dirty || isNew));

  /** Fresh counts and status, keeping unsaved edits. */
  const refresh = async () => {
    convs.reload();
    try {
      const l = await api.links.get(linkId);
      setSaved(l);
      if (!dirty) {
        setBase(toDraft(l));
        setDraft(toDraft(l));
      }
    } catch (e) {
      setError(e);
    }
  };

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const rotate = () =>
    act(async () => {
      setSaved(await api.links.rotate(linkId));
      setFlash('New URL ready');
    });

  const turnOff = () =>
    act(async () => {
      const l = await api.links.update(linkId, { active: false });
      setSaved(l);
      setBase((b) => (b ? { ...b, active: false } : b));
      setDraft((d) => (d ? { ...d, active: false } : d));
      setFlash('Turned off');
    });

  const remove = () =>
    act(async () => {
      const label = saved?.label ?? linkId;
      const r = await api.links.remove(linkId);
      allowNext();
      navigate('/links', {
        state: { flash: `Deleted “${label}”, with ${plural(r.conversations, 'saved conversation')} and ${plural(r.profiles, 'visitor memory profile')}.` },
      });
    });

  if (!canEdit)
    return (
      <div className="page">
        <Notice tone="warn">Only editors and admins manage chat links.</Notice>
      </div>
    );
  if (loaded.error != null)
    return (
      <div className="page">
        <ErrorBox error={loaded.error} onRetry={loaded.reload} title={`Could not load link ${linkId}`} />
        <Link to="/links">← Chat links</Link>
      </div>
    );
  if (!draft)
    return (
      <div className="page">
        <Loading />
      </div>
    );

  const s = draft.settings;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value });
  const setS = <K extends keyof ChatLinkSettings>(key: K, value: ChatLinkSettings[K]) =>
    setDraft({ ...draft, settings: { ...draft.settings, [key]: value } });
  const sys = systems.data?.find((x) => x.id === draft.system_id);
  const sysName = sys ? sys.name || sys.id : draft.system_id;
  const sysTitle = sys ? sys.ui.title || sys.name || sys.id : '';
  const hasCode = !!saved?.has_access_code;
  const list = convs.data ?? [];
  const savedConvs = list.filter((c) => c.saved).length;
  const remembered = new Set(list.filter((c) => c.remembered).map((c) => c.visitor)).size;
  const liveUnsaved = saved?.stats.live_unsaved ?? 0;
  const url = saved ? linkUrl(saved) : '';

  return (
    <div className="page page-wide">
      <div className="page-header sticky-header">
        <div>
          <div className="crumbs">
            <Link to="/links">Chat links</Link> /
          </div>
          <h1>
            {isNew ? 'New chat link' : saved?.label} <DirtyDot dirty={dirty} />
          </h1>
          <div className="page-subtitle row gap-sm wrap">
            {saved ? (
              <>
                <LinkStatusBadge status={saved.status} />
                <span>
                  for <Link to={`/systems/${saved.system_id}`}>{systems.data?.find((x) => x.id === saved.system_id)?.name || saved.system_id}</Link>
                </span>
                <span>
                  · <SavedBy at={saved.updated_at} by={saved.updated_by} prefix="saved" />
                </span>
              </>
            ) : (
              <span>Nothing is published until you create the link; its secret URL appears then.</span>
            )}
          </div>
        </div>
        <div className="page-actions">
          {flash && <span className="flash">{flash}</span>}
          {!isNew && (
            <button
              className="btn"
              disabled={!dirty}
              onClick={() => {
                setDraft(base);
                setCodeMode('keep');
                setCodeText('');
              }}
            >
              Revert
            </button>
          )}
          <button className="btn btn-primary" disabled={busy || problems.length > 0 || (!dirty && !isNew)} onClick={() => void save()} title="Ctrl+S">
            {busy ? 'Saving…' : isNew ? 'Create link' : 'Save'}
          </button>
        </div>
      </div>
      {error != null && <ErrorBox error={error} title="Not done" />}
      {(dirty || isNew) && <MessageList tone="warn" items={problems} />}

      {saved && (
        <section className="panel link-address">
          <div className="link-url-row">
            <input className="mono" readOnly value={url} aria-label="Link address" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={url} className="btn" />
            <a className="btn" href={url} target="_blank" rel="noreferrer" title="Open the chat page in a new tab">
              Open ↗
            </a>
            <button className="btn" disabled={busy} onClick={() => setConfirm('rotate')} title="Give the link a new secret URL">
              Replace URL…
            </button>
            <button className="btn btn-danger-ghost" disabled={busy} onClick={() => setConfirm('delete')}>
              Delete…
            </button>
          </div>
          <div className="link-stats">
            <Stat label="Conversations" value={saved.stats.conversations} />
            <Stat label="Visitors" value={saved.stats.visitors} />
            <Stat label="Messages" value={saved.stats.turns} />
            <Stat label="Open unsaved now" value={liveUnsaved} title="Unsaved conversations held in server memory right now" />
            <Stat label="Last used" value={saved.stats.last_used ? fmtDateTime(saved.stats.last_used) : 'never'} />
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refresh()} title="Reload the counts and conversations">
              ↻ Refresh
            </button>
          </div>
          {saved.status === 'disabled' && <Notice tone="warn">This link is off: visitors see a page saying it has been turned off.</Notice>}
          {saved.status === 'expired' && (
            <Notice tone="warn">This link expired {fmtDateTime(saved.settings.expires_at)}: visitors see a page saying so. Change or clear the expiry to reopen it.</Notice>
          )}
          {saved.status === 'full' && (
            <Notice tone="warn">
              This link has reached its limit of {plural(saved.settings.max_conversations ?? 0, 'conversation')}: visitors can finish open conversations but
              not start new ones.
            </Notice>
          )}
        </section>
      )}

      <div className="editor-columns">
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">General</h2>
            <div className="grid-2">
              <Field label="Label" hint="For you and other editors; visitors don't see it. Blank: the system's id.">
                <input value={draft.label} maxLength={120} placeholder="e.g. Pilot group, spring" onChange={(e) => set('label', e.target.value)} />
              </Field>
              <Field label="System" hint="The system visitors chat with.">
                <select value={draft.system_id} onChange={(e) => set('system_id', e.target.value)}>
                  {!draft.system_id && <option value="">Choose a system…</option>}
                  {(systems.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name || x.id}
                    </option>
                  ))}
                  {draft.system_id && systems.data && !sys && <option value={draft.system_id}>{draft.system_id} (not found)</option>}
                </select>
              </Field>
            </div>
          </section>

          <section className="panel">
            <h2 className="panel-title">Privacy</h2>
            <FieldGroup
              label="Transcripts"
              hint={
                saved && saved.settings.save_transcripts !== s.save_transcripts ? (
                  <strong className="text-warn">
                    Only new conversations change: ones already started stay {saved.settings.save_transcripts ? 'saved' : 'unsaved'}.
                  </strong>
                ) : (
                  'Changing this only affects new conversations.'
                )
              }
            >
              <div className="choice-list">
                <label className={`choice${s.save_transcripts ? ' active' : ''}`}>
                  <input type="radio" name="save_transcripts" checked={s.save_transcripts} onChange={() => setS('save_transcripts', true)} />
                  <span>
                    <strong>Save transcripts</strong>
                    <span className="muted small">
                      {' '}
                      — Conversations are stored on this server like other chats. Editors and admins can read them (Conversations, below) until
                      they are deleted; deleting this link deletes them.
                    </span>
                  </span>
                </label>
                <label className={`choice${!s.save_transcripts ? ' active' : ''}`}>
                  <input type="radio" name="save_transcripts" checked={!s.save_transcripts} onChange={() => setS('save_transcripts', false)} />
                  <span>
                    <strong>Don&apos;t save</strong>
                    <span className="muted small">
                      {' '}
                      — Conversations exist only in the server&apos;s memory while open; no transcript is written to disk and no one can read it
                      afterwards. Each is erased when the visitor ends it, after {s.idle_minutes} minutes without a message, or when the server
                      restarts. Only content-free counts are kept: when it started and ended, and how many messages.
                    </span>
                  </span>
                </label>
              </div>
            </FieldGroup>
            <FieldGroup label="Returning visitors">
              <label className={`choice${s.remember_visitors ? ' active' : ''}`}>
                <input type="checkbox" checked={s.remember_visitors} onChange={(e) => setS('remember_visitors', e.target.checked)} />
                <span>
                  <strong>Remember visitors</strong>
                  <span className="muted small">
                    {' '}
                    — Each visitor gets a memory profile, tied to a cookie in their browser, so the system&apos;s memory agent can carry
                    anonymous template notes (never transcript text) from one visit to the next. Clearing cookies or changing browser starts
                    afresh. Deleting this link deletes these profiles.
                  </span>
                </span>
              </label>
              {s.remember_visitors && sys && !sys.memory?.enabled && (
                <Notice tone="warn">{sysName} has memory turned off, so there is nothing to remember: this setting does nothing.</Notice>
              )}
            </FieldGroup>
          </section>

          <section className="panel">
            <h2 className="panel-title">What visitors see</h2>
            <Field label="Page title" hint="Blank: the system's chat title.">
              <input value={s.title} maxLength={200} placeholder={sysTitle || 'The system’s chat title'} onChange={(e) => setS('title', e.target.value)} />
            </Field>
            <FieldGroup label="Welcome message" hint="Markdown, shown before the first message.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.welcome === null}
                  onChange={(e) => setS('welcome', e.target.checked ? null : sys?.ui.welcome ?? '')}
                />
                Same as the system
              </label>
              {s.welcome === null ? (
                sys?.ui.welcome ? (
                  <div className="link-default-preview">
                    <Markdown>{sys.ui.welcome}</Markdown>
                  </div>
                ) : (
                  <span className="muted small">The system has no welcome message.</span>
                )
              ) : (
                <textarea rows={6} value={s.welcome} placeholder="Leave empty for no welcome message" onChange={(e) => setS('welcome', e.target.value)} />
              )}
            </FieldGroup>
            <FieldGroup label="Suggested messages" hint="Buttons visitors can tap to start.">
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.starters === null}
                  onChange={(e) => setS('starters', e.target.checked ? null : [...(sys?.ui.starters ?? [])])}
                />
                Same as the system
              </label>
              {s.starters === null ? (
                sys?.ui.starters.length ? (
                  <ul className="link-default-list muted small">
                    {sys.ui.starters.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                ) : (
                  <span className="muted small">The system has none.</span>
                )
              ) : (
                <StringListEditor value={s.starters} onChange={(v) => setS('starters', v)} addLabel="Add a message" placeholder="A first message" />
              )}
            </FieldGroup>
            <FieldGroup
              label="Notice"
              hint="Markdown, shown with the welcome before the chat starts, and later under “About this chat”. Say what is recorded and who can read it."
              actions={
                <button
                  type="button"
                  className="link-btn small"
                  onClick={() => {
                    if (!s.notice.trim() || window.confirm('Replace the notice with a suggestion based on the privacy settings?'))
                      setS('notice', suggestedNotice(s));
                  }}
                >
                  Suggest one
                </button>
              }
            >
              <textarea rows={4} value={s.notice} placeholder="No notice" onChange={(e) => setS('notice', e.target.value)} />
            </FieldGroup>
            <label className="check">
              <input
                type="checkbox"
                checked={s.require_consent}
                disabled={!s.notice.trim() && !s.require_consent}
                onChange={(e) => setS('require_consent', e.target.checked)}
              />
              Visitors must accept the notice before they can chat
            </label>
            <div className="field-hint">
              They tick “I have read this and agree”; the time is recorded with each conversation.
              {!s.notice.trim() && ' Write a notice first.'}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2 className="panel-title">Access</h2>
            <label className={`choice${draft.active ? ' active' : ''}`}>
              <input type="checkbox" checked={draft.active} onChange={(e) => set('active', e.target.checked)} />
              <span>
                <strong>Link is on</strong>
                <span className="muted small">
                  {' '}
                  — Off: visitors see a page saying the link has been turned off. Settings, counts and saved conversations stay.
                </span>
              </span>
            </label>
            <FieldGroup label="Access code">
              {codeMode === 'keep' && (
                <div className="row wrap">
                  <span className="grow small">
                    {hasCode ? 'An access code is set. Visitors enter it once per browser.' : 'No access code: anyone with the URL can chat.'}
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setCodeMode('set');
                      setCodeText('');
                    }}
                  >
                    {hasCode ? 'Change…' : 'Set an access code…'}
                  </button>
                  {hasCode && (
                    <button type="button" className="btn btn-sm btn-danger-ghost" onClick={() => setCodeMode('remove')}>
                      Remove
                    </button>
                  )}
                </div>
              )}
              {codeMode === 'set' && (
                <>
                  <div className="row">
                    <input
                      className="mono"
                      value={codeText}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="At least 8 characters"
                      aria-label="New access code"
                      onChange={(e) => setCodeText(e.target.value)}
                    />
                    <button type="button" className="btn btn-sm" onClick={() => setCodeText(randomCode())}>
                      Generate
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setCodeMode('keep')}>
                      Cancel
                    </button>
                  </div>
                  <span className="field-hint">
                    Share it separately from the URL. It is stored hashed: copy it now, you can&apos;t see it again after saving.
                    {hasCode && ' Everyone who entered the old code will be asked for the new one.'}
                  </span>
                </>
              )}
              {codeMode === 'remove' && (
                <div className="row wrap">
                  <span className="grow small text-warn">The access code is removed when you save: anyone with the URL can chat.</span>
                  <button type="button" className="btn btn-sm" onClick={() => setCodeMode('keep')}>
                    Undo
                  </button>
                </div>
              )}
            </FieldGroup>
            <Field label="Expires" hint="Afterwards the link shows visitors a page saying it has expired. Blank: never.">
              <div className="row gap-sm">
                <input
                  type="datetime-local"
                  style={{ maxWidth: 240 }}
                  value={toLocalInput(s.expires_at)}
                  onChange={(e) => setS('expires_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
                />
                {s.expires_at && (
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setS('expires_at', null)}>
                    Clear
                  </button>
                )}
              </div>
            </Field>
          </section>

          <section className="panel">
            <h2 className="panel-title">Limits</h2>
            <div className="grid-2">
              <Field label="Messages per conversation" hint="1–500. Then the visitor is asked to start a new conversation.">
                <NumberInput integer min={1} max={500} value={s.max_turns} onChange={(n) => setS('max_turns', n ?? 40)} />
              </Field>
              <Field label="Conversations in total" hint="All visitors together; then no new ones (“full”). Blank: no limit.">
                <NumberInput integer min={1} value={s.max_conversations} placeholder="No limit" onChange={(n) => setS('max_conversations', n)} />
              </Field>
              <Field label="Messages per minute" hint="Per visitor, 1–120. Faster senders are asked to wait.">
                <NumberInput integer min={1} max={120} value={s.messages_per_minute} onChange={(n) => setS('messages_per_minute', n ?? 8)} />
              </Field>
              <Field label="Erase unsaved after (minutes idle)" hint="5–1440. Unsaved conversations only.">
                <NumberInput integer min={5} max={1440} value={s.idle_minutes} onChange={(n) => setS('idle_minutes', n ?? 60)} />
              </Field>
            </div>
          </section>
        </div>
      </div>

      {saved && (
        <section className="panel link-conversations">
          <h2 className="panel-title">
            Conversations <span className="muted small">{list.length}</span>
          </h2>
          <p className="muted small">
            Newest first. Saved ones open read-only in the chat view; unsaved ones leave only counts. Visitors are anonymous: the id is a short
            hash of their browser&apos;s cookie.
          </p>
          {convs.loading && !convs.data && <Loading />}
          {convs.error != null && <ErrorBox error={convs.error} onRetry={convs.reload} />}
          {convs.data && list.length === 0 && <EmptyState>No conversations yet.</EmptyState>}
          {list.length > 0 && <ConversationsTable convs={list} />}
        </section>
      )}

      {confirm === 'rotate' && saved && (
        <Modal
          title="Replace this link's URL?"
          size="sm"
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" disabled={busy} onClick={() => void rotate()}>
                Replace URL
              </button>
            </>
          }
        >
          <p>The current URL stops working at once: anyone who opens it sees a “link not found” page.</p>
          <p>
            Visitors who come back through the new URL start afresh, without their earlier conversations or memory. Settings, counts and saved
            transcripts stay here.
          </p>
        </Modal>
      )}
      {confirm === 'delete' && saved && (
        <Modal
          title={`Delete “${saved.label}”?`}
          size="sm"
          onClose={() => setConfirm(null)}
          footer={
            <>
              {saved.active && (
                <button className="btn" disabled={busy} onClick={() => void turnOff()}>
                  Turn off instead
                </button>
              )}
              <span className="grow" />
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger-ghost" disabled={busy || convs.loading} onClick={() => void remove()}>
                Delete link
              </button>
            </>
          }
        >
          <p>This can&apos;t be undone. It permanently deletes:</p>
          <ul>
            <li>the link: its URL stops working;</li>
            <li>{savedConvs ? `${plural(savedConvs, 'saved conversation')}, transcripts included` : 'its saved conversations (none so far)'};</li>
            <li>
              {remembered ? `the memory profiles of ${plural(remembered, 'remembered visitor')}` : 'its visitors’ memory profiles (none so far)'};
            </li>
            {liveUnsaved > 0 && <li>{plural(liveUnsaved, 'unsaved conversation')} open right now.</li>}
          </ul>
          <p className="muted">
            To keep the transcripts, turn the link off instead: visitors see a page saying it&apos;s off, and everything here stays.
          </p>
        </Modal>
      )}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: number | string; title?: string }) {
  return (
    <div className="link-stat" title={title}>
      <strong>{value}</strong>
      <span className="muted small">{label}</span>
    </div>
  );
}

function endedLabel(c: ChatLinkConversation): string {
  if (c.ended_by === 'visitor') return c.saved ? 'ended by visitor' : 'erased by visitor';
  if (c.ended_by === 'idle') return c.saved ? 'ended (idle)' : 'erased (idle or restart)';
  return 'ended';
}

function ConversationsTable({ convs }: { convs: ChatLinkConversation[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Started</th>
            <th>Visitor</th>
            <th className="num">Messages</th>
            <th>Last message</th>
            <th>State</th>
            <th>Transcript</th>
          </tr>
        </thead>
        <tbody>
          {convs.map((c) => (
            <tr key={c.id}>
              <td className="nowrap">{fmtDateTime(c.started_at)}</td>
              <td className="nowrap">
                <code>{c.visitor}</code>{' '}
                {c.remembered && (
                  <Badge tone="observe" title="This visitor has a memory profile">
                    remembered
                  </Badge>
                )}
              </td>
              <td className="num">{c.turns}</td>
              <td className="nowrap small muted">{fmtDateTime(c.last_at)}</td>
              <td>
                {c.ended_at ? (
                  <span className="small" title={fmtDateTime(c.ended_at)}>
                    {endedLabel(c)}
                  </span>
                ) : c.live ? (
                  <Badge tone="ok">open</Badge>
                ) : (
                  <span className="small muted">closed</span>
                )}
                {c.consented_at && (
                  <div className="muted small" title={fmtDateTime(c.consented_at)}>
                    accepted the notice
                  </div>
                )}
              </td>
              <td>
                {!c.saved ? (
                  <span className="muted small" title="Transcripts were off for this conversation: only these counts exist">
                    not saved
                  </span>
                ) : c.system_id ? (
                  <Link to={`/chat/${c.system_id}/${c.id}`}>{c.title || 'Open'}</Link>
                ) : (
                  <span className="muted small">deleted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
