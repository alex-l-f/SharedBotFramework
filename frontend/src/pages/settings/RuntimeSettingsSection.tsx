import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useConflicts } from '../../components/Conflict';
import { HistoryButton, useLastChange } from '../../components/History';
import { ModelSpecEditor } from '../../components/ModelSpecEditor';
import { PresenceChips, ReadOnlyNote, SavedBy } from '../../components/team';
import { Badge, ErrorBox, Field, JsonField, Loading, NumberInput, isObject } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useLoad, useSaveShortcut } from '../../lib/hooks';
import { usePresence } from '../../lib/presence';
import { invalidate } from '../../lib/refdata';
import { compactModel, isEqual } from '../../lib/util';
import { EMBEDDER_PROVIDERS, type EmbedderProvider, type EmbedderSpec, type KnowledgeBackend, type ModelSpec, type Settings, type StaticMount } from '../../types';

// Unknown keys are kept: PUT /api/settings replaces the whole object. The
// version (what a save is based on) is kept apart from the draft.
const normalize = ({ version: _v, ...s }: Settings): Settings => ({
  ...s,
  models: Object.fromEntries(Object.entries(s.models).map(([k, v]) => [k, compactModel(v)])),
  embedders: Object.fromEntries(
    Object.entries(s.embedders ?? {}).map(([k, v]) => [k, { ...v, api_base: v.api_base ? v.api_base : null }]),
  ),
});

const PROVIDER_HELP: Record<EmbedderProvider, string> = {
  sentence_transformers: 'A local model (GPU when available), e.g. google/embeddinggemma-300m',
  litellm: 'An embeddings API LiteLLM routes, e.g. openai/text-embedding-3-small',
  hash: 'Hashed bag of words: no model, lexical only (tests, offline)',
};

export function RuntimeSettingsSection({ onDirty, active }: { onDirty: (d: boolean) => void; active: boolean }) {
  const loaded = useLoad(api.settings.get, []);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [newPreset, setNewPreset] = useState('');
  const [newEmbedder, setNewEmbedder] = useState('');
  const canSave = useAuth().can('admin');

  useEffect(() => {
    if (loaded.data) {
      setSaved(normalize(loaded.data));
      setDraft(normalize(loaded.data));
      setVersion(loaded.data.version ?? null);
    }
  }, [loaded.data]);

  const dirty = useMemo(() => !!draft && !!saved && !isEqual(draft, saved), [draft, saved]);
  useEffect(() => onDirty(dirty && canSave), [dirty, canSave, onDirty]);
  const others = usePresence(active ? 'settings/settings' : null, dirty && canSave);
  const last = useLastChange('settings', 'settings', version);

  /** Saves `body` based on `base`; the result becomes the saved state. */
  const persist = async (body: Settings, base: string | null) => {
    const result = await api.settings.put(body, base);
    setSaved(normalize(result));
    setDraft(normalize(result));
    setVersion(result.version ?? null);
    setError(null);
    invalidate('settings');
    setFlash('Saved');
    setTimeout(() => setFlash(null), 2000);
  };
  const conflicts = useConflicts<Settings>({
    what: 'the runtime settings',
    toPayload: (c) => normalize(c as unknown as Settings),
    persist,
    reload: loaded.reload,
  });

  const save = async () => {
    if (!draft || !saved || busy || !canSave) return;
    setBusy(true);
    setError(null);
    const mine = normalize(draft);
    try {
      await persist(mine, version);
    } catch (e) {
      if (!conflicts.catchConflict(e, saved, mine)) setError(e);
    } finally {
      setBusy(false);
    }
  };
  useSaveShortcut(() => void save(), dirty && active && canSave);

  if (loaded.error != null) return <ErrorBox error={loaded.error} onRetry={loaded.reload} />;
  if (!draft) return <Loading />;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft({ ...draft, [k]: v });
  const presetNames = Object.keys(draft.models);

  const setPreset = (name: string, spec: ModelSpec) => set('models', { ...draft.models, [name]: spec });
  const renamePreset = (from: string, to: string) => {
    if (!to || to === from || draft.models[to]) return;
    const models: Record<string, ModelSpec> = {};
    for (const [k, v] of Object.entries(draft.models)) {
      models[k === from ? to : k] = v.preset === from ? { ...v, preset: to } : v;
    }
    setDraft({ ...draft, models, default_model: draft.default_model === from ? to : draft.default_model });
  };
  const embedders = draft.embedders ?? {};
  const embedderNames = Object.keys(embedders);
  const setEmbedder = (name: string, spec: EmbedderSpec) => set('embedders', { ...embedders, [name]: spec });
  const renameEmbedder = (from: string, to: string) => {
    if (!to || to === from || embedders[to]) return;
    const next: Record<string, EmbedderSpec> = {};
    for (const [k, v] of Object.entries(embedders)) next[k === from ? to : k] = v;
    setDraft({ ...draft, embedders: next, default_embedder: draft.default_embedder === from ? to : draft.default_embedder });
  };
  const removeEmbedder = (name: string) => {
    if (!window.confirm(`Remove embedder "${name}"? Retrievers that name it will fail.`)) return;
    const next = { ...embedders };
    delete next[name];
    set('embedders', next);
  };

  const removePreset = (name: string) => {
    if (!window.confirm(`Remove preset "${name}"? Agents or nodes that reference it will fail validation.`)) return;
    const models = { ...draft.models };
    delete models[name];
    set('models', models);
  };

  return (
    <div className="stack">
      <div className="section-toolbar">
        <span className="muted small grow">
          {last && <SavedBy at={last.ts} by={last.actor} prefix="Last saved" />}
          <PresenceChips others={others} />
        </span>
        {flash && <span className="flash">{flash}</span>}
        <HistoryButton
          kind="settings"
          id="settings"
          label="runtime settings"
          current={draft}
          baseVersion={version}
          toPayload={(d) => normalize(d as unknown as Settings)}
          onLoad={canSave ? (p) => setDraft(p) : undefined}
        />
        <button className="btn" disabled={!dirty} onClick={() => setDraft(saved)}>
          Revert
        </button>
        {canSave ? (
          <button className="btn btn-primary" disabled={!dirty || busy} onClick={save} title="Ctrl+S">
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        ) : (
          <ReadOnlyNote need="admin" />
        )}
      </div>
      {error != null && <ErrorBox error={error} title="Not saved" />}
      {conflicts.dialog}

      <section className="panel">
        <h2 className="panel-title">Model presets</h2>
        <p className="muted small">Agents and nodes reference presets by name. A preset can inherit another via its own preset field; blank fields inherit.</p>
        <div className="grid-2">
          <Field label="Default preset" hint="Used when an agent sets no preset">
            <select value={draft.default_model} onChange={(e) => set('default_model', e.target.value)}>
              {!presetNames.includes(draft.default_model) && <option value={draft.default_model}>{draft.default_model} (missing)</option>}
              {presetNames.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="LLM retries" hint="Retries on upstream errors">
            <NumberInput integer min={0} value={draft.llm_retries} onChange={(v) => set('llm_retries', v ?? 0)} />
          </Field>
        </div>
        {presetNames.map((name) => (
          <div key={name} className="preset-card">
            <div className="row gap-sm preset-head">
              <PresetName name={name} taken={presetNames} onRename={(to) => renamePreset(name, to)} />
              {draft.default_model === name && <Badge tone="accent">default</Badge>}
              <span className="grow" />
              <button className="btn btn-ghost btn-sm danger" onClick={() => removePreset(name)}>
                Remove
              </button>
            </div>
            <ModelSpecEditor value={draft.models[name]} onChange={(v) => setPreset(name, v)} presets={presetNames} excludePreset={name} inheritNote="" />
          </div>
        ))}
        <form
          className="row gap-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const n = newPreset.trim();
            if (!n || draft.models[n]) return;
            setPreset(n, {});
            setNewPreset('');
          }}
        >
          <input className="mono" value={newPreset} placeholder="new preset name" onChange={(e) => setNewPreset(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!newPreset.trim() || !!draft.models[newPreset.trim()]}>
            + Add preset
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="panel-title">Knowledge backend</h2>
        <p className="muted small">The service URL, roots and libraries below configure the <code>embedding_service</code> backend.</p>
        <div className="grid-2">
          <Field
            label="Default backend"
            hint="Where the library tools (search_resources, examine_resource, …) find libraries unless a tool binding picks its own backend."
          >
            <select value={draft.knowledge.backend} onChange={(e) => set('knowledge', { ...draft.knowledge, backend: e.target.value as KnowledgeBackend })}>
              <option value="embedding_service">embedding_service — BotBase embedding service</option>
              <option value="datasets">datasets — this framework&apos;s datasets (library id = dataset id)</option>
              {!['embedding_service', 'datasets'].includes(draft.knowledge.backend) && (
                <option value={draft.knowledge.backend}>{draft.knowledge.backend} (unknown)</option>
              )}
            </select>
          </Field>
          <Field label="Service URL">
            <input className="mono" value={draft.knowledge.url} onChange={(e) => set('knowledge', { ...draft.knowledge, url: e.target.value })} />
          </Field>
          <Field label="Processed root" hint="One folder per library with its database.db">
            <input className="mono" value={draft.knowledge.processed_root} onChange={(e) => set('knowledge', { ...draft.knowledge, processed_root: e.target.value })} />
          </Field>
          <Field label="File root" hint="Where resource files (source_path) resolve">
            <input className="mono" value={draft.knowledge.file_root} onChange={(e) => set('knowledge', { ...draft.knowledge, file_root: e.target.value })} />
          </Field>
        </div>
        <Field label="Libraries (JSON)" hint="library id → {label, description, …}">
          <JsonField<Record<string, Record<string, unknown>>>
            value={draft.knowledge.libraries}
            onChange={(v) => set('knowledge', { ...draft.knowledge, libraries: v })}
            emptyValue={{}}
            validate={isObject}
            rows={10}
          />
        </Field>
      </section>

      <section className="panel">
        <h2 className="panel-title">Embedders &amp; data processing</h2>
        <p className="muted small">
          Embedding models the retrievers use (a retriever names one; blank = the default). Renaming an embedder breaks retrievers that name it.
        </p>
        <div className="grid-3">
          <Field label="Default embedder">
            <select value={draft.default_embedder} onChange={(e) => set('default_embedder', e.target.value)}>
              {!embedderNames.includes(draft.default_embedder) && <option value={draft.default_embedder}>{draft.default_embedder} (missing)</option>}
              {embedderNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Processing workers" hint="Dataset files processed at once (applies after a restart).">
            <NumberInput integer min={1} value={draft.processing_workers} onChange={(v) => set('processing_workers', v ?? 3)} />
          </Field>
          <Field label="Processing LLM calls" hint="Vision / extraction LLM calls in flight at once (applies after a restart).">
            <NumberInput integer min={1} value={draft.processing_llm_calls} onChange={(v) => set('processing_llm_calls', v ?? 8)} />
          </Field>
        </div>
        {embedderNames.map((name) => {
          const e = embedders[name];
          return (
            <div key={name} className="preset-card">
              <div className="row gap-sm preset-head">
                <PresetName name={name} taken={embedderNames} onRename={(to) => renameEmbedder(name, to)} />
                {draft.default_embedder === name && <Badge tone="accent">default</Badge>}
                <span className="grow" />
                <button className="btn btn-ghost btn-sm danger" onClick={() => removeEmbedder(name)}>
                  Remove
                </button>
              </div>
              <div className="grid-4">
                <Field label="Provider" hint={PROVIDER_HELP[e.provider]} className="span-2">
                  <select value={e.provider} onChange={(ev) => setEmbedder(name, { ...e, provider: ev.target.value as EmbedderProvider })}>
                    {EMBEDDER_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Model" className="span-2">
                  <input className="mono" value={e.model} disabled={e.provider === 'hash'} onChange={(ev) => setEmbedder(name, { ...e, model: ev.target.value })} />
                </Field>
                <Field label="API base" className="span-2" hint="litellm only; blank = the provider default">
                  <input
                    className="mono"
                    value={e.api_base ?? ''}
                    disabled={e.provider !== 'litellm'}
                    onChange={(ev) => setEmbedder(name, { ...e, api_base: ev.target.value || null })}
                  />
                </Field>
                <Field label="Batch size">
                  <NumberInput integer min={1} value={e.batch_size} onChange={(v) => setEmbedder(name, { ...e, batch_size: v ?? 32 })} />
                </Field>
              </div>
            </div>
          );
        })}
        <form
          className="row gap-sm"
          onSubmit={(ev) => {
            ev.preventDefault();
            const n = newEmbedder.trim();
            if (!n || embedders[n]) return;
            setEmbedder(n, { provider: 'sentence_transformers', model: 'google/embeddinggemma-300m', api_base: null, batch_size: 32 });
            setNewEmbedder('');
          }}
        >
          <input className="mono" value={newEmbedder} placeholder="new embedder name" onChange={(ev) => setNewEmbedder(ev.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={!newEmbedder.trim() || !!embedders[newEmbedder.trim()]}>
            + Add embedder
          </button>
        </form>
      </section>

      <section className="panel">
        <h2 className="panel-title">Static content</h2>
        <Field label="SCORM root" hint="Where open_course_page looks for SCORM packages (served under /scorm/)">
          <input className="mono" value={draft.scorm_root} onChange={(e) => set('scorm_root', e.target.value)} />
        </Field>
        <Field label="Static mounts (JSON)" hint='[{"prefix": "/media", "directory": "D:\\\\media"}]'>
          <JsonField<StaticMount[]>
            value={draft.static_mounts}
            onChange={(v) => set('static_mounts', v)}
            emptyValue={[]}
            validate={(v) => (Array.isArray(v) ? null : 'Must be a JSON array')}
            rows={4}
          />
        </Field>
      </section>
    </div>
  );
}

function PresetName({ name, taken, onRename }: { name: string; taken: string[]; onRename: (to: string) => void }) {
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const commit = () => {
    const t = text.trim();
    if (!t || (t !== name && taken.includes(t))) setText(name);
    else if (t !== name) onRename(t);
  };
  return (
    <input
      className="mono preset-name"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      title="Preset name (rename updates the default and presets that inherit it)"
    />
  );
}
