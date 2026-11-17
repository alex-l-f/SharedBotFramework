import { useCallback, useState } from 'react';
import { PageHeader } from '../../components/ui';
import { useUnsavedGuard } from '../../lib/hooks';
import { FragmentsSection } from './FragmentsSection';
import { MemorySchemasSection } from './MemorySchemasSection';
import { RuntimeSettingsSection } from './RuntimeSettingsSection';

type Tab = 'runtime' | 'fragments' | 'schemas';
const TABS: { id: Tab; label: string }[] = [
  { id: 'runtime', label: 'Models & runtime' },
  { id: 'fragments', label: 'Fragments' },
  { id: 'schemas', label: 'Memory schemas' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>(() => {
    const h = window.location.hash.slice(1);
    return TABS.some((t) => t.id === h) ? (h as Tab) : 'runtime';
  });
  const [dirty, setDirty] = useState<Record<Tab, boolean>>({ runtime: false, fragments: false, schemas: false });
  // One guard for the whole page (react-router allows a single blocker).
  useUnsavedGuard(Object.values(dirty).some(Boolean));
  const report = useCallback((t: Tab) => (d: boolean) => setDirty((prev) => (prev[t] === d ? prev : { ...prev, [t]: d })), []);
  const [onRuntime] = useState(() => report('runtime'));
  const [onFragments] = useState(() => report('fragments'));
  const [onSchemas] = useState(() => report('schemas'));

  return (
    <div className="page page-wide">
      <PageHeader title="Settings" subtitle="Workspace settings (settings.yaml), shared prompt fragments and memory schemas." />
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => {
              setTab(t.id);
              window.history.replaceState(null, '', `#${t.id}`);
            }}
          >
            {t.label}
            {dirty[t.id] && <span className="dirty-dot" />}
          </button>
        ))}
      </div>
      <div hidden={tab !== 'runtime'}>
        <RuntimeSettingsSection onDirty={onRuntime} active={tab === 'runtime'} />
      </div>
      <div hidden={tab !== 'fragments'}>
        <FragmentsSection onDirty={onFragments} active={tab === 'fragments'} />
      </div>
      <div hidden={tab !== 'schemas'}>
        <MemorySchemasSection onDirty={onSchemas} active={tab === 'schemas'} />
      </div>
    </div>
  );
}
