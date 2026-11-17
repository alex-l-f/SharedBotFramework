// Who else has the same definition open: a heartbeat every 15 s while an
// editor is mounted (and right away when its unsaved state changes), and a
// "leaving" call on unmount. Nothing is sent with accounts off.

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PresenceEntry } from '../types';
import { useAuth } from './auth';

const HEARTBEAT_MS = 15000;

/** `resource`: "<kind>/<id>" (revision kinds), or "items/<dataset>:<item>"; null = not open. */
export function usePresence(resource: string | null, editing: boolean): PresenceEntry[] {
  const { authOn } = useAuth();
  const [others, setOthers] = useState<PresenceEntry[]>([]);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const sent = useRef<boolean | null>(null);
  const active = authOn && !!resource;

  const beat = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (!active || !resource) {
      setOthers([]);
      return;
    }
    let alive = true;
    beat.current = () => {
      sent.current = editingRef.current;
      api
        .presence(resource, editingRef.current)
        .then((r) => alive && setOthers(r.others))
        .catch(() => undefined);
    };
    beat.current();
    const t = setInterval(() => beat.current(), HEARTBEAT_MS);
    return () => {
      alive = false;
      clearInterval(t);
      beat.current = () => undefined;
      void api.presence(resource, false, true).catch(() => undefined);
    };
  }, [active, resource]);

  // Tell the others right away when unsaved changes start or end.
  useEffect(() => {
    if (sent.current !== null && sent.current !== editing) beat.current();
  }, [editing]);

  return others;
}
