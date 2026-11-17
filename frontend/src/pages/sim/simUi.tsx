// Small pieces shared by the Simulations pages (runs, personas, scenarios, rubrics).

import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Spinner, type Tone } from '../../components/ui';
import type { Stats } from '../../types';

const TABS: { to: string; label: string; match: (path: string) => boolean }[] = [
  {
    to: '/simulations',
    label: 'Runs',
    match: (p) => p === '/simulations' || /^\/simulations\/(runs|new|conversations)(\/|$)/.test(p),
  },
  { to: '/simulations/personas', label: 'Personas', match: (p) => p.startsWith('/simulations/personas') },
  { to: '/simulations/scenarios', label: 'Scenarios', match: (p) => p.startsWith('/simulations/scenarios') },
  { to: '/simulations/rubrics', label: 'Rubrics', match: (p) => p.startsWith('/simulations/rubrics') },
];

/** Sub-navigation of the Simulations section. */
export function SimTabs() {
  const { pathname } = useLocation();
  return (
    <div className="tabs">
      {TABS.map((t) => (
        <Link key={t.to} to={t.to} className={`tab${t.match(pathname) ? ' active' : ''}`}>
          {t.label}
        </Link>
      ))}
    </div>
  );
}

/** One-paragraph explanations shown as page subtitles. */
export const SIM_HELP: Record<'runs' | 'personas' | 'scenarios' | 'rubrics', ReactNode> = {
  runs: (
    <>
      A <strong>run</strong> plays every <em>system × scenario × persona × repetition</em>: an LLM plays the user (persona) in a scenario,
      turn by turn, against each system (compiled once and pinned to a snapshot). Every conversation is an ordinary chat — watch it live
      in the chat view — and is checked (expectation patterns) and, with a rubric, graded by an LLM judge.
    </>
  ),
  personas: (
    <>
      A <strong>persona</strong> is a simulated user: who they are and how they type (background, tone, message length, quirks), plus the
      model playing them. Thinking is turned off for the persona model unless its spec sets a reasoning effort.
    </>
  ),
  scenarios: (
    <>
      A <strong>scenario</strong> is what the simulated user is dealing with and wants: the opening message, the situation, facts they
      reveal only when asked, the goal, a default persona and the <em>expectations</em> a good conversation covers (graded by the judge,
      and checked by regex against what the assistant said).
    </>
  ),
  rubrics: (
    <>
      A <strong>rubric</strong> is an LLM judge: instructions and weighted criteria (score = weighted criteria mean, normalized to 0–100),
      plus optionally a 0–3 grade for every scenario expectation (absent / named / explained / applied). Prefer a judge model from another
      family than the bots.
    </>
  ),
};

// -------------------------------------------------------------------- status

export const STATUS_TONE: Record<string, Tone> = {
  queued: 'muted',
  running: 'accent',
  judging: 'observe',
  completed: 'ok',
  cancelled: 'warn',
  failed: 'danger',
};

export function SimStatusBadge({ status, title }: { status: string; title?: string }) {
  const busy = status === 'running' || status === 'judging';
  return (
    <Badge tone={STATUS_TONE[status] ?? 'neutral'} title={title}>
      {busy && <Spinner />}
      {status}
    </Badge>
  );
}

export function isActiveRun(r: { status: string; active?: boolean; judging?: boolean }): boolean {
  return !!r.active || !!r.judging || r.status === 'queued' || r.status === 'running';
}

export function isBusyConv(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'judging';
}

const SEGMENTS: { status: string; cls: string }[] = [
  { status: 'completed', cls: 'seg-ok' },
  { status: 'failed', cls: 'seg-danger' },
  { status: 'cancelled', cls: 'seg-warn' },
  { status: 'judging', cls: 'seg-observe' },
  { status: 'running', cls: 'seg-accent' },
];

/** Conversation counts as a stacked bar (queued = empty part). */
export function ProgressBar({ counts, large }: { counts: Record<string, number>; large?: boolean }) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const title = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ');
  return (
    <div className={`progress${large ? ' progress-lg' : ''}`} title={title}>
      {total > 0 &&
        SEGMENTS.map(({ status, cls }) =>
          counts[status] ? <span key={status} className={cls} style={{ width: `${(100 * counts[status]) / total}%` }} /> : null,
        )}
    </div>
  );
}

/** "12 / 20 done · 2 failed" */
export function progressText(counts: Record<string, number>): { done: number; total: number; failed: number } {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const done = (counts.completed ?? 0) + (counts.failed ?? 0) + (counts.cancelled ?? 0);
  return { done, total, failed: counts.failed ?? 0 };
}

// --------------------------------------------------------------------- stats

/** Half-width of the 95% CI. */
export function ciHalf(s: Stats): number {
  return (s.ci95[1] - s.ci95[0]) / 2;
}

export function statTitle(s: Stats | null | undefined, scale = 1, digits = 2): string | undefined {
  if (!s) return undefined;
  const f = (v: number) => (v * scale).toFixed(digits);
  return `n=${s.n} · mean ${f(s.mean)} · sd ${f(s.sd)} · 95% CI [${f(s.ci95[0])}, ${f(s.ci95[1])}]`;
}

/** "72.4 ± 5.1" (± = half the 95% CI). */
export function StatValue({
  s,
  digits = 1,
  scale = 1,
  suffix = '',
  noCi,
}: {
  s: Stats | null | undefined;
  digits?: number;
  scale?: number;
  suffix?: string;
  noCi?: boolean;
}) {
  if (!s) return <span className="muted">—</span>;
  const half = ciHalf(s) * scale;
  return (
    <span title={statTitle(s, scale, digits + 1)}>
      {(s.mean * scale).toFixed(digits)}
      {suffix}
      {!noCi && s.n > 1 && half > 0 && <span className="muted small"> ±{half.toFixed(digits)}</span>}
    </span>
  );
}

export function fmtScore(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1);
}

export function fmtPct(v: number | null | undefined, digits = 0): string {
  return v == null ? '—' : `${(v * 100).toFixed(digits)}%`;
}

export const LEVEL_LABELS = ['absent', 'named', 'explained', 'applied'];
const LEVEL_TONE: Tone[] = ['danger', 'warn', 'accent', 'ok'];

export function LevelBadge({ level }: { level: number }) {
  const l = Math.max(0, Math.min(3, Math.round(level)));
  return (
    <Badge tone={LEVEL_TONE[l]} title={`${l} = ${LEVEL_LABELS[l]}`}>
      {l} {LEVEL_LABELS[l]}
    </Badge>
  );
}

/** A 0–1 fraction as a thin bar. */
export function MeterBar({ value, title }: { value: number | null | undefined; title?: string }) {
  const v = value == null ? 0 : Math.max(0, Math.min(1, value));
  const tone = v >= 0.75 ? 'seg-ok' : v >= 0.5 ? 'seg-accent' : v >= 0.25 ? 'seg-warn' : 'seg-danger';
  return (
    <div className="meter" title={title}>
      {value != null && <span className={tone} style={{ width: `${v * 100}%` }} />}
    </div>
  );
}

/** ✓ / ✗ chips for deterministic expectation checks. */
export function ChecksChips({ checks, compact }: { checks: Record<string, boolean> | null | undefined; compact?: boolean }) {
  if (!checks || !Object.keys(checks).length) return <span className="muted small">—</span>;
  const entries = Object.entries(checks);
  if (compact) {
    const hits = entries.filter(([, v]) => v).length;
    return (
      <span className="check-chips" title={entries.map(([k, v]) => `${v ? '✓' : '✗'} ${k}`).join('\n')}>
        {entries.map(([k, v]) => (
          <span key={k} className={`check-dot ${v ? 'hit' : 'miss'}`}>
            {v ? '✓' : '✗'}
          </span>
        ))}
        <span className="muted small">
          {' '}
          {hits}/{entries.length}
        </span>
      </span>
    );
  }
  return (
    <div className="badges">
      {entries.map(([k, v]) => (
        <Badge key={k} tone={v ? 'ok' : 'danger'} title={v ? 'The pattern matched what the assistant said' : 'No match in what the assistant said'}>
          {v ? '✓' : '✗'} {k}
        </Badge>
      ))}
    </div>
  );
}

/** Background for a 0–100 score cell (red → green). */
export function heatStyle(score: number | null | undefined): React.CSSProperties | undefined {
  if (score == null) return undefined;
  const v = Math.max(0, Math.min(100, score));
  return { background: `color-mix(in srgb, color-mix(in srgb, var(--ok) ${v}%, var(--danger)) 22%, transparent)` };
}

export const ENDED_BY_HELP: Record<string, string> = {
  persona: 'The simulated user ended the conversation ([END]).',
  max_turns: 'Stopped at the turn limit.',
  empty_message: 'The simulator produced no message.',
  cancelled: 'The run was cancelled.',
};

/**
 * Python `re` → JS RegExp for the live pattern test: leading inline flags
 * like (?i) become JS flags. Returns null + an error for invalid patterns.
 */
export function toJsRegex(pattern: string): { re: RegExp | null; error: string | null } {
  let flags = '';
  let body = pattern;
  const m = /^\(\?([aiLmsux]+)\)/.exec(body);
  if (m) {
    body = body.slice(m[0].length);
    if (m[1].includes('i')) flags += 'i';
    if (m[1].includes('m')) flags += 'm';
    if (m[1].includes('s')) flags += 's';
    if (m[1].includes('x')) return { re: null, error: 'Verbose (?x) patterns cannot be tested here (the server accepts them).' };
  }
  try {
    return { re: new RegExp(body, flags), error: null };
  } catch (e) {
    return { re: null, error: e instanceof Error ? e.message : String(e) };
  }
}
