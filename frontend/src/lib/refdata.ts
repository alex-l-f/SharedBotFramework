// Cached reference data shared by many pages (tool catalog, presets, …).

import { api } from '../api';
import type {
  AgentSummary,
  ClassifierSummary,
  DatasetSummary,
  Library,
  MemorySchemaSummary,
  RagMeta,
  RetrieverSummary,
  SafetyMeta,
  Settings,
  ToolInfo,
} from '../types';
import { useLoad, type Loaded } from './hooks';

const cache = new Map<string, Promise<unknown>>();

export function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fn();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function invalidate(...keys: string[]): void {
  for (const k of keys) cache.delete(k);
}

/** Forgets everything (another user signs in). */
export function invalidateAll(): void {
  cache.clear();
}

export const getTools = () => cached<ToolInfo[]>('tools', api.tools);
export const getSettings = () => cached<Settings>('settings', api.settings.get);
export const getAgents = () => cached<AgentSummary[]>('agents', api.agents.list);
export const getMemorySchemas = () => cached<MemorySchemaSummary[]>('memory-schemas', api.memorySchemas.list);
export const getLibraries = () => cached<Library[]>('libraries', () => api.libraries());
export const getDatasets = () => cached<DatasetSummary[]>('datasets', api.datasets.list);
export const getRetrievers = () => cached<RetrieverSummary[]>('retrievers', api.retrievers.list);
export const getRagMeta = () => cached<RagMeta>('rag-meta', api.rag.meta);
export const getSafetyMeta = () => cached<SafetyMeta>('safety-meta', api.safety.meta);
export const getClassifiers = () => cached<ClassifierSummary[]>('classifiers', api.classifiers.list);

/**
 * Retriever ids known from the datasets' `used_by` — a fallback for when
 * GET /api/retrievers fails (it lists only retrievers with sources).
 */
export const getKnownRetrieverIds = () =>
  cached<string[]>('retriever-ids', async () => {
    const ds = await api.datasets.list();
    return Array.from(new Set(ds.flatMap((d) => d.used_by))).sort();
  });

export const useTools = (): Loaded<ToolInfo[]> => useLoad(getTools, []);
export const useSettings = (): Loaded<Settings> => useLoad(getSettings, []);
export const useAgents = (): Loaded<AgentSummary[]> => useLoad(getAgents, []);
export const useMemorySchemas = (): Loaded<MemorySchemaSummary[]> => useLoad(getMemorySchemas, []);
export const useLibraries = (): Loaded<Library[]> => useLoad(getLibraries, []);
export const useDatasets = (): Loaded<DatasetSummary[]> => useLoad(getDatasets, []);
export const useRetrievers = (): Loaded<RetrieverSummary[]> => useLoad(getRetrievers, []);
export const useRagMeta = (): Loaded<RagMeta> => useLoad(getRagMeta, []);
export const useSafetyMeta = (): Loaded<SafetyMeta> => useLoad(getSafetyMeta, []);
export const useClassifiers = (): Loaded<ClassifierSummary[]> => useLoad(getClassifiers, []);

/** Known retriever ids, loaded only when `enabled` (the full list failed). */
export const useKnownRetrieverIds = (enabled: boolean): Loaded<string[]> =>
  useLoad(() => (enabled ? getKnownRetrieverIds() : Promise.resolve([])), [enabled]);
