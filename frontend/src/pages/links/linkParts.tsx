// Small pieces of the chat links pages: the full URL, status, privacy badges
// and a copy button.

import { useEffect, useState } from 'react';
import { Badge, type Tone } from '../../components/ui';
import type { ChatLink, ChatLinkSettings, ChatLinkStatus } from '../../types';

/** A new link's settings (the server's defaults). */
export const DEFAULT_LINK_SETTINGS: ChatLinkSettings = {
  save_transcripts: true,
  remember_visitors: false,
  title: '',
  welcome: null,
  starters: null,
  notice: '',
  require_consent: false,
  expires_at: null,
  max_turns: 40,
  max_conversations: null,
  messages_per_minute: 8,
  idle_minutes: 60,
};

/** The address visitors open. */
export const linkUrl = (l: Pick<ChatLink, 'path'>) => window.location.origin + l.path;

const STATUS: Record<ChatLinkStatus, { tone: Tone; label: string; title: string }> = {
  active: { tone: 'ok', label: 'active', title: 'Visitors can chat' },
  disabled: { tone: 'muted', label: 'off', title: 'Turned off: visitors see a page saying so' },
  expired: { tone: 'warn', label: 'expired', title: 'Past its expiry: visitors see a page saying so' },
  full: { tone: 'warn', label: 'full', title: 'Reached its conversation limit: no new conversations' },
};

export function LinkStatusBadge({ status }: { status: ChatLinkStatus }) {
  const s = STATUS[status] ?? { tone: 'neutral' as Tone, label: status, title: '' };
  return (
    <Badge tone={s.tone} title={s.title}>
      {s.label}
    </Badge>
  );
}

/** Saved / not saved, remembers, access code: what a visitor's privacy looks like at a glance. */
export function PrivacyBadges({ link }: { link: ChatLink }) {
  const s = link.settings;
  return (
    <span className="badges">
      {s.save_transcripts ? (
        <Badge tone="neutral" title="Transcripts are saved; editors can read them">
          saved
        </Badge>
      ) : (
        <Badge tone="accent" title="Transcripts are not saved: conversations exist only in server memory while open">
          not saved
        </Badge>
      )}
      {s.remember_visitors && (
        <Badge tone="observe" title="Each visitor has a memory profile, tied to a cookie in their browser">
          remembers visitors
        </Badge>
      )}
      {link.has_access_code && (
        <Badge tone="muted" title="Visitors need an access code">
          code
        </Badge>
      )}
    </span>
  );
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Plain http on another host: no Clipboard API.
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

export function CopyButton({ text, label = 'Copy URL', className = 'btn btn-sm' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      className={className}
      title={state === 'failed' ? 'Could not copy: select the address and copy it yourself' : 'Copy the address visitors open'}
      onClick={() =>
        copyText(text).then(
          () => setState('copied'),
          () => setState('failed'),
        )
      }
    >
      {state === 'copied' ? 'Copied ✓' : state === 'failed' ? 'Copy failed' : label}
    </button>
  );
}
