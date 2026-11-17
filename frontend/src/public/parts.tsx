// Building blocks of the standalone chat page: icons, screens, the header
// menu, dialogs, messages and cards, the composer and the course viewer.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Markdown } from '../components/Markdown';
import { mediaKind, type MediaKind } from '../lib/media';
import type { PublicFileOutput, PublicViewerOutput } from '../types';
import type { Item } from './useConversation';

export const MAX_MESSAGE = 4000;

const ICONS: Record<string, ReactNode> = {
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  back: <path d="M19 12H5M12 19l-7-7 7-7" />,
  external: (
    <>
      <path d="M14 3h7v7M10 14 21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="2" />
      <path d="m16 10 5-3v10l-5-3z" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-5-5L5 21" />
    </>
  ),
  course: (
    <>
      <path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2z" />
      <path d="M22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      className="pc-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}

/** A centred card for everything that isn't the chat: loading, problems, the access code. */
export function Screen({ icon, title, children }: { icon?: keyof typeof ICONS; title?: ReactNode; children?: ReactNode }) {
  return (
    <main className="pc-screen">
      <div className={title ? 'pc-screen-card' : 'pc-screen-plain'}>
        {icon && (
          <div className="pc-screen-icon">
            <Icon name={icon} size={26} />
          </div>
        )}
        {title && <h1>{title}</h1>}
        {children}
      </div>
    </main>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="pc-loading" role="status">
      <span className="pc-spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** The header's "⋯" menu (Escape closes it, arrow keys move between items). */
export function Menu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (e: MouseEvent) => wrap.current && !wrap.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const all = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="pc-menu-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="pc-icon-btn"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="pc-menu" role="menu" id={id} ref={menu}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`pc-menu-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false);
                button.current?.focus();
                it.onSelect();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** A modal dialog: Escape or the backdrop closes it; focus moves in and back. */
export function Dialog({ title, children, actions, onClose }: { title: ReactNode; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>('[data-autofocus]') ?? box.current?.querySelector<HTMLElement>('button, a[href], input');
    first?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      before?.focus?.();
    };
  }, []);
  return (
    <div className="pc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} ref={box}>
        <div className="pc-dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="pc-icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="pc-dialog-body">{children}</div>
        {actions && <div className="pc-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<MediaKind, string> = { video: 'Video', audio: 'Audio', image: 'Image', pdf: 'PDF document', other: 'File' };
const KIND_ICON: Record<MediaKind, keyof typeof ICONS> = { video: 'video', audio: 'audio', image: 'image', pdf: 'file', other: 'file' };

function FileCard({ o }: { o: PublicFileOutput }) {
  const kind = mediaKind(o);
  const name = o.source_file ? o.source_file.split(/[\\/]/).pop() : '';
  return (
    <div className="pc-card">
      <div className="pc-card-head">
        <span className="pc-card-icon">
          <Icon name={KIND_ICON[kind]} />
        </span>
        <div className="pc-card-text">
          <div className="pc-card-title">{o.title || name || 'File'}</div>
          <div className="pc-card-sub">
            {KIND_LABEL[kind]}
            {name && name !== o.title && <> · {name}</>}
          </div>
        </div>
      </div>
      {o.note && <p className="pc-card-note">{o.note}</p>}
      {kind === 'video' && <video className="pc-media" controls preload="metadata" src={o.url} />}
      {kind === 'audio' && <audio className="pc-audio" controls preload="metadata" src={o.url} />}
      {kind === 'image' && (
        <a href={o.url} target="_blank" rel="noreferrer">
          <img className="pc-media" src={o.url} alt={o.title || name || ''} loading="lazy" />
        </a>
      )}
      {o.summary && <p className="pc-card-summary">{o.summary}</p>}
      <div className="pc-card-actions">
        <a className="pc-btn" href={o.url} target="_blank" rel="noreferrer">
          Open <Icon name="external" size={15} />
        </a>
        <a className="pc-btn pc-btn-quiet" href={o.url} download={name || true}>
          Download
        </a>
      </div>
    </div>
  );
}

function CourseCard({ o, onOpen }: { o: PublicViewerOutput; onOpen?: (o: PublicViewerOutput) => void }) {
  return (
    <div className="pc-card">
      <div className="pc-card-head">
        <span className="pc-card-icon">
          <Icon name="course" />
        </span>
        <div className="pc-card-text">
          <div className="pc-card-title">{o.title || 'Course page'}</div>
          <div className="pc-card-sub">Course page{o.section && <> · {o.section}</>}</div>
        </div>
      </div>
      {o.note && <p className="pc-card-note">{o.note}</p>}
      {o.summary && <p className="pc-card-summary">{o.summary}</p>}
      <div className="pc-card-actions">
        {onOpen && (
          <button type="button" className="pc-btn pc-btn-primary" onClick={() => onOpen(o)}>
            Open
          </button>
        )}
        <a className={`pc-btn${onOpen ? ' pc-btn-quiet' : ''}`} href={o.url} target="_blank" rel="noreferrer">
          {onOpen ? 'New tab' : 'Open'} <Icon name="external" size={15} />
        </a>
      </div>
    </div>
  );
}

export function MessageView({
  item,
  onOpenCourse,
  onRetry,
}: {
  item: Item;
  onOpenCourse?: (o: PublicViewerOutput) => void;
  onRetry?: (text: string, key: string) => void;
}) {
  if (item.kind === 'error') {
    return (
      <div className="pc-line pc-line-error" role="alert">
        {item.message}
      </div>
    );
  }
  const o = item.output;
  switch (o.type) {
    case 'user':
      return (
        <div className={`pc-msg pc-msg-user${item.pending ? ' pending' : ''}${item.failed ? ' failed' : ''}`}>
          <div className="pc-bubble">{o.content}</div>
          {item.failed && (
            <div className="pc-msg-meta" role="alert">
              <span className="pc-danger">{item.failed}</span>
              {onRetry && (
                <>
                  {' '}
                  <button type="button" className="pc-link" onClick={() => onRetry(o.content, item.key)}>
                    Try again
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      );
    case 'message':
      return (
        <div className="pc-msg pc-msg-bot">
          <div className="pc-bubble">
            <Markdown>{o.content}</Markdown>
          </div>
        </div>
      );
    case 'file':
      return (
        <div className="pc-msg pc-msg-bot pc-msg-card">
          <FileCard o={o} />
        </div>
      );
    case 'viewer':
      return (
        <div className="pc-msg pc-msg-bot pc-msg-card">
          <CourseCard o={o} onOpen={onOpenCourse} />
        </div>
      );
    default:
      return null;
  }
}

export function Typing() {
  return (
    <div className="pc-msg pc-msg-bot" role="status" aria-label="Replying">
      <div className="pc-bubble pc-typing" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

/** The message box: Enter sends, Shift+Enter adds a line. */
export function Composer({
  disabled,
  canSend,
  placeholder,
  onSend,
  focusKey,
}: {
  /** The box itself is off (not just sending). */
  disabled: boolean;
  canSend: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  /** Focus moves to the box whenever this changes. */
  focusKey?: unknown;
}) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to about six lines.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text]);

  // Only with a mouse (an on-screen keyboard popping up is in the way), and not when merely enabled.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    if (!disabledRef.current && window.matchMedia('(pointer: fine)').matches) box.current?.focus();
  }, [focusKey]);

  const submit = () => {
    if (!canSend || !text.trim()) return;
    onSend(text);
    setText('');
  };

  const left = MAX_MESSAGE - text.length;
  return (
    <form
      className="pc-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="pc-sr" htmlFor="pc-message">
        Message
      </label>
      <textarea
        id="pc-message"
        ref={box}
        rows={1}
        value={text}
        maxLength={MAX_MESSAGE}
        placeholder={placeholder}
        disabled={disabled}
        enterKeyHint="send"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {left < 300 && <span className="pc-count">{left}</span>}
      <button type="submit" className="pc-send" disabled={disabled || !canSend || !text.trim()} aria-label="Send">
        <Icon name="send" />
      </button>
    </form>
  );
}

/** A course page beside the chat (wide screens) or over it (phones). Same origin: the SCORM shim is on window.top. */
export function CourseViewer({ url, title, full, onClose }: { url: string; title: string; full: boolean; onClose: () => void }) {
  // Course pages may set the top window's title; restore ours afterwards.
  useEffect(() => {
    const original = document.title;
    return () => {
      document.title = original;
    };
  }, []);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onClose]);
  return (
    <aside className={`pc-viewer${full ? ' full' : ''}`} aria-label="Course page">
      <div className="pc-viewer-head">
        {full && (
          <button type="button" className="pc-btn pc-btn-quiet" onClick={onClose}>
            <Icon name="back" size={16} /> Chat
          </button>
        )}
        <strong className="pc-viewer-title" title={title}>
          {title || 'Course page'}
        </strong>
        <a className="pc-icon-btn" href={url} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open in a new tab">
          <Icon name="external" size={18} />
        </a>
        {!full && (
          <button type="button" className="pc-icon-btn" aria-label="Close the course page" onClick={onClose}>
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <iframe key={url} className="pc-viewer-frame" src={url} title={title || 'Course page'} allow="autoplay; fullscreen" />
    </aside>
  );
}

/** Tracks a media query (e.g. wide enough for a side viewer). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}

export function fmtWhen(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
