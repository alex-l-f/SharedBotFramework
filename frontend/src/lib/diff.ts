// Comparing definitions: field-level three-way comparison (conflicting
// saves), and a line diff of their text form (history, import compare).

import { isEqual } from './util';

export type Path = string[];

/** Bookkeeping fields that never count as a change. */
export const STAMPS = new Set(['updated_at', 'updated_by', 'version', 'used_by']);

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function getPath(value: unknown, path: Path): unknown {
  let cur = value;
  for (const key of path) {
    if (!isPlain(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Sets (undefined: removes) the value at `path` in place, creating objects on the way. */
export function setPath(target: Record<string, unknown>, path: Path, value: unknown): void {
  let cur = target;
  for (const key of path.slice(0, -1)) {
    if (!isPlain(cur[key])) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = structuredClone(value);
}

/**
 * Where `b` differs from `a`: objects are compared key by key, anything else
 * (arrays included) as a whole value. No path is a prefix of another.
 */
export function changedPaths(a: unknown, b: unknown, path: Path = []): Path[] {
  if (isPlain(a) && isPlain(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out: Path[] = [];
    for (const key of keys) {
      if (path.length === 0 && STAMPS.has(key)) continue;
      out.push(...changedPaths(a[key], b[key], [...path, key]));
    }
    return out;
  }
  return isEqual(a ?? null, b ?? null) ? [] : [path];
}

const isPrefix = (p: Path, q: Path) => p.length <= q.length && p.every((k, i) => q[i] === k);
const overlaps = (p: Path, q: Path) => isPrefix(p, q) || isPrefix(q, p);

export interface FieldChange {
  path: Path;
  base: unknown;
  mine: unknown;
  theirs: unknown;
}

export interface ThreeWay {
  /** Changed only in my draft. */
  mine: FieldChange[];
  /** Changed only by the other save. */
  theirs: FieldChange[];
  /** Changed on both sides to different values. */
  conflicts: FieldChange[];
  /** Changed on both sides to the same value. */
  same: FieldChange[];
}

/** Compares my draft and their stored version with the version both started from. */
export function threeWay(base: unknown, mine: unknown, theirs: unknown): ThreeWay {
  const minePaths = changedPaths(base, mine);
  const theirPaths = changedPaths(base, theirs);
  const at = (path: Path): FieldChange => ({ path, base: getPath(base, path), mine: getPath(mine, path), theirs: getPath(theirs, path) });
  const out: ThreeWay = { mine: [], theirs: [], conflicts: [], same: [] };
  const seen = new Set<string>();
  for (const p of minePaths) {
    const hits = theirPaths.filter((q) => overlaps(p, q));
    if (!hits.length) {
      out.mine.push(at(p));
      continue;
    }
    // Compare the overlapping region as a whole (the shorter path covers both).
    for (const q of hits) {
      const region = p.length <= q.length ? p : q;
      const key = JSON.stringify(region);
      if (seen.has(key)) continue;
      seen.add(key);
      const change = at(region);
      (isEqual(change.mine ?? null, change.theirs ?? null) ? out.same : out.conflicts).push(change);
    }
  }
  for (const q of theirPaths) if (!minePaths.some((p) => overlaps(p, q))) out.theirs.push(at(q));
  return out;
}

/** Their version with my changes applied (only meaningful without conflicts). */
export function mergeMine<T>(theirs: T, changes: FieldChange[]): T {
  const merged = structuredClone(theirs) as Record<string, unknown>;
  for (const c of changes) setPath(merged, c.path, c.mine);
  return merged as T;
}

export function pathLabel(path: Path): string {
  return path.length ? path.map((k) => (/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k))).join('.') : '(everything)';
}

/** One short line for a value. */
export function preview(value: unknown, max = 90): string {
  if (value === undefined) return '(none)';
  if (value === null) return 'null';
  const text = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Like `preview`, but a long string starts near where it differs from `other`. */
export function excerpt(value: unknown, other: unknown, max = 90): string {
  if (typeof value !== 'string' || typeof other !== 'string' || value === other) return preview(value, max);
  let i = 0;
  while (i < value.length && i < other.length && value[i] === other[i]) i++;
  const start = Math.max(0, i - 30);
  if (start === 0) return preview(value, max);
  const text = JSON.stringify(value.slice(start)).slice(1);
  return `"…${text.length > max ? `${text.slice(0, max)}…` : text}`;
}

// ------------------------------------------------------------------- text form

/**
 * A definition as readable, diff-friendly text: YAML-like, keys sorted,
 * multi-line strings (prompts) one line per line, stamps left out.
 */
export function toDiffText(value: unknown): string {
  const lines: string[] = [];
  const scalar = (v: unknown) => (v === undefined ? 'null' : JSON.stringify(v));
  const emit = (v: unknown, indent: string, head: string) => {
    if (typeof v === 'string' && v.includes('\n')) {
      lines.push(`${head}|`);
      for (const l of v.split('\n')) lines.push(`${indent}  ${l}`);
    } else if (Array.isArray(v)) {
      if (!v.length) lines.push(`${head}[]`);
      else {
        lines.push(head.trimEnd());
        for (const item of v) emit(item, `${indent}  `, `${indent}- `);
      }
    } else if (isPlain(v)) {
      const keys = Object.keys(v).sort();
      if (!keys.length) lines.push(`${head}{}`);
      else {
        if (head.trim()) lines.push(head.trimEnd());
        for (const k of keys) emit(v[k], `${indent}  `, `${indent}  ${k}: `);
      }
    } else lines.push(`${head}${scalar(v)}`);
  };
  const top = isPlain(value) ? Object.fromEntries(Object.entries(value).filter(([k]) => !STAMPS.has(k))) : value;
  if (isPlain(top)) for (const k of Object.keys(top).sort()) emit(top[k], '', `${k}: `);
  else emit(top, '', '');
  return lines.join('\n');
}

export type DiffLine = { op: ' ' | '-' | '+'; text: string };

/** Line diff of a → b (common prefix/suffix trimmed, LCS on the rest). */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) {
    endX--;
    endY--;
  }
  const out: DiffLine[] = x.slice(0, start).map((text) => ({ op: ' ', text }));
  const xs = x.slice(start, endX);
  const ys = y.slice(start, endY);
  const n = xs.length;
  const m = ys.length;
  if (n * m > 4_000_000) {
    // Too big to align line by line: everything in between counts as replaced.
    out.push(...xs.map((text) => ({ op: '-' as const, text })), ...ys.map((text) => ({ op: '+' as const, text })));
  } else {
    // lcs[i][j] = longest common subsequence of xs[i..] and ys[j..]
    const lcs = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * (m + 1) + j] = xs[i] === ys[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (xs[i] === ys[j]) {
        out.push({ op: ' ', text: xs[i] });
        i++;
        j++;
      } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) out.push({ op: '-', text: xs[i++] });
      else out.push({ op: '+', text: ys[j++] });
    }
    while (i < n) out.push({ op: '-', text: xs[i++] });
    while (j < m) out.push({ op: '+', text: ys[j++] });
  }
  out.push(...x.slice(endX).map((text) => ({ op: ' ' as const, text })));
  return out;
}
