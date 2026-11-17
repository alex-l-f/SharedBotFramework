// Shared parts of the Safety section: the classifier definition kind,
// plain-language help per provider, verdicts, the service status dot and the
// "Try it" panel (also used by the setup wizard).

import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Badge, ErrorBox, Field, Spinner } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { classifierPayload, fmtMs, newClassifier, toDisplay } from '../../lib/util';
import type {
  ClassifierDef,
  ClassifierStatus,
  ClassifierSummary,
  GuardAction,
  SafetyMeta,
  SafetyProvider,
  Verdict,
} from '../../types';
import type { DefKind } from '../sim/defs';

export const CLASSIFIER_KIND: DefKind<ClassifierDef, ClassifierSummary> = {
  label: 'classifier',
  path: '/safety',
  kind: 'classifiers',
  get: api.classifiers.get,
  create: api.classifiers.create,
  update: api.classifiers.update,
  remove: api.classifiers.remove,
  payload: classifierPayload,
  blank: (id, name) => newClassifier(id, name),
};

/** What each provider is, in a sentence or two. */
export const PROVIDER_HELP: Record<SafetyProvider, string> = {
  safer:
    "MIRA's SAFER model: a small, fast classifier that runs on this machine's GPU and scores 13 harm categories. Needs its service running; free per check.",
  qwen3guard:
    'Qwen3Guard: an open safety model you serve yourself (vLLM or llama.cpp). Labels messages safe, unsafe or controversial with a category.',
  nemoguard: "NVIDIA's NemoGuard content-safety model (NIM, hosted or self-hosted): an LLM fine-tuned to rate messages against a 23-category policy.",
  nemo_guardrails:
    "NVIDIA NeMo Guardrails: an LLM checks each message against a written policy (the prompts below). Runs on a separate guardrails server; each check is one or two model calls.",
  llm: 'An LLM judge: any model from your presets reads the message and says which of your categories apply. Flexible, but each check is a model call.',
  keywords: 'Keyword rules: regular expressions. Instant and free, but only catches the wording you list.',
};

/** Short provider names for badges. */
export const PROVIDER_SHORT: Record<SafetyProvider, string> = {
  safer: 'SAFER',
  qwen3guard: 'Qwen3Guard',
  nemoguard: 'NemoGuard',
  nemo_guardrails: 'NeMo Guardrails',
  llm: 'LLM judge',
  keywords: 'Keywords',
};

/** Providers with a service whose status can be checked. */
export const HAS_STATUS: SafetyProvider[] = ['safer', 'nemo_guardrails'];

export const ACTION_LABEL: Record<GuardAction, string> = {
  block: 'Block — reply with a fixed message instead',
  inform: 'Inform — tell the agent to take care',
  add_message: 'Add a message — show it, then answer as usual',
  flag: 'Flag — record it only',
  regenerate: 'Regenerate — ask for a different reply',
  replace: 'Replace — send a fixed message instead',
};

export const ACTION_SHORT: Record<GuardAction, string> = {
  block: 'block',
  inform: 'inform',
  add_message: 'add message',
  flag: 'flag',
  regenerate: 'regenerate',
  replace: 'replace',
};

/** The categories a classifier can report (for guard rules). */
export function classifierCategories(c: ClassifierDef | undefined, meta: SafetyMeta | undefined): string[] {
  if (!c) return [];
  if (c.provider === 'llm') return c.categories.length ? c.categories : (meta?.providers.llm.categories ?? []);
  if (c.provider === 'keywords') return [...new Set(c.keywords.map((k) => k.category).filter(Boolean))];
  return meta?.providers[c.provider]?.categories ?? [];
}

/** A new classifier of `provider`, prefilled with that provider's defaults. */
export function prefilledClassifier(id: string, name: string, provider: SafetyProvider, meta: SafetyMeta | undefined): ClassifierDef {
  const c = newClassifier(id, name, provider);
  const p = meta?.providers[provider];
  if (provider === 'nemo_guardrails') {
    c.rails_config = p?.rails_config ?? '';
    c.rails_prompts = p?.rails_prompts ?? '';
  }
  if ((provider === 'nemoguard' || provider === 'qwen3guard' || provider === 'llm') && p?.model) c.model = { ...p.model };
  if (provider === 'llm') c.categories = [...(p?.categories ?? [])];
  if (provider === 'nemo_guardrails' || provider === 'llm' || provider === 'nemoguard') c.timeout = 30;
  if (provider === 'keywords')
    c.keywords = [{ category: 'Self-harm', pattern: '\\b(kill(ing)? myself|end(ing)? my life|suicid\\w*|self[- ]?harm\\w*)\\b' }];
  return c;
}

export function ProviderBadge({ provider }: { provider: SafetyProvider }) {
  return (
    <Badge tone={provider === 'keywords' ? 'muted' : provider === 'llm' || provider === 'nemo_guardrails' ? 'observe' : 'accent'} title={PROVIDER_HELP[provider]}>
      {PROVIDER_SHORT[provider] ?? provider}
    </Badge>
  );
}

/** A dot for whether the classifier's service answers (safer / nemo_guardrails); `tick` re-checks. */
export function StatusDot({ id, tick = 0, showText }: { id: string; tick?: number; showText?: boolean }) {
  const [status, setStatus] = useState<ClassifierStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError(null);
    api.classifiers
      .status(id)
      .then((s) => alive && setStatus(s))
      .catch((e: unknown) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [id, tick]);
  if (error != null)
    return (
      <span className="status-dot bad" title="Could not check">
        {showText && 'unknown'}
      </span>
    );
  if (!status)
    return (
      <span className="status-dot pending" title="Checking…">
        {showText && 'checking…'}
      </span>
    );
  if (!status.checked) return showText ? <span className="muted small">{status.detail}</span> : null;
  const title = `${status.ok ? 'Service answers' : 'Not reachable'}${status.url ? ` (${status.url})` : ''}\n${status.detail}`;
  return (
    <span className={`status-dot ${status.ok ? 'ok' : 'bad'}`} title={title}>
      {showText && (status.ok ? 'service answers' : 'service not reachable')}
    </span>
  );
}

/** A verdict: safe/unsafe, categories, scores as bars, latency, error. */
export function VerdictView({ verdict }: { verdict: Verdict }) {
  const tone = verdict.label === 'error' ? 'warn' : verdict.safe ? 'ok' : 'danger';
  const scores = Object.entries(verdict.scores ?? {}).sort((a, b) => b[1] - a[1]);
  const detail = verdict.detail == null || verdict.detail === '' ? '' : toDisplay(verdict.detail);
  return (
    <div className={`verdict verdict-${tone}`}>
      <div className="row gap-sm wrap">
        <span className={`verdict-label ${tone}`}>{verdict.label === 'error' ? 'Error' : verdict.safe ? 'Safe' : 'Unsafe'}</span>
        {verdict.label !== 'safe' && verdict.label !== 'unsafe' && verdict.label !== 'error' && <Badge tone="warn">{verdict.label}</Badge>}
        {verdict.categories.map((c) => (
          <Badge key={c} tone="danger">
            {c}
          </Badge>
        ))}
        <span className="grow" />
        <span className="muted small">{fmtMs(Math.round(verdict.latency_ms))}</span>
      </div>
      {verdict.error && <div className="text-danger small pre-line">{verdict.error}</div>}
      {scores.length > 0 && (
        <div className="score-bars">
          {scores.map(([k, v]) => (
            <div key={k} className="score-bar" title={`${k}: ${v.toFixed(3)}`}>
              <span className="score-name small">{k}</span>
              <span className="score-track">
                <span className={`score-fill${verdict.categories.includes(k) ? ' hit' : ''}`} style={{ width: `${Math.max(0, Math.min(1, v)) * 100}%` }} />
              </span>
              <span className="score-value small mono">{v.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}
      {detail && (
        <details className="trace-details">
          <summary className="small">details</summary>
          <pre className="trace-pre mono">{detail}</pre>
        </details>
      )}
    </div>
  );
}

const SAMPLES = {
  risky: "I can't do this anymore. I've been thinking about ending my life.",
  benign: 'Any tips for sleeping better before a big exam?',
};

/**
 * Runs the classifier (a draft, or a saved id) on a user message, or on a
 * reply to it ("check the reply"), and shows the verdict.
 */
export function TryItPanel({ draft, savedId, note }: { draft?: ClassifierDef; savedId?: string; note?: string }) {
  const canRun = useAuth().can('editor');
  const [user, setUser] = useState('');
  const [reply, setReply] = useState('');
  const [checkReply, setCheckReply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async () => {
    if (busy || !user.trim() || (checkReply && !reply.trim())) return;
    setBusy(true);
    setError(null);
    try {
      const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: user }];
      if (checkReply) messages.push({ role: 'assistant', content: reply });
      setVerdict(await api.classifiers.test({ classifier: savedId, draft: draft ? classifierPayload(draft) : undefined, messages }));
    } catch (e) {
      setVerdict(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="try-it">
      <div className="seg seg-sm" role="group" aria-label="What to check">
        <button type="button" className={!checkReply ? 'active' : ''} onClick={() => setCheckReply(false)}>
          Check a user message
        </button>
        <button type="button" className={checkReply ? 'active' : ''} onClick={() => setCheckReply(true)}>
          Check a reply
        </button>
      </div>
      <Field
        label="User message"
        hint={
          <span className="row gap-sm wrap">
            Examples:
            <button type="button" className="link-btn small" onClick={() => setUser(SAMPLES.risky)}>
              self-harm
            </button>
            <button type="button" className="link-btn small" onClick={() => setUser(SAMPLES.benign)}>
              harmless
            </button>
          </span>
        }
      >
        <textarea
          rows={3}
          value={user}
          placeholder="What a user might write…"
          onChange={(e) => setUser(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void run();
          }}
        />
      </Field>
      {checkReply && (
        <Field label="Assistant reply" hint="The reply is what gets classified; the user message gives it context.">
          <textarea rows={3} value={reply} placeholder="What the bot answered…" onChange={(e) => setReply(e.target.value)} />
        </Field>
      )}
      {note && <div className="field-hint">{note}</div>}
      <div className="row gap-sm">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canRun || busy || !user.trim() || (checkReply && !reply.trim())}
          onClick={() => void run()}
          title={canRun ? 'Ctrl+Enter' : 'Trying a classifier needs the editor role'}
        >
          {busy ? (
            <>
              <Spinner /> Checking…
            </>
          ) : checkReply ? (
            'Check the reply'
          ) : (
            'Check the message'
          )}
        </button>
        {!canRun && <span className="muted small">Trying a classifier needs the editor role.</span>}
      </div>
      {error != null && <ErrorBox error={error} title="Check failed" />}
      {verdict && <VerdictView verdict={verdict} />}
    </div>
  );
}
