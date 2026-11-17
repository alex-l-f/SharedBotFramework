// Pure updates of a SystemDef draft.

import type { GuardDef, GuardRule, LinkDef, LinkType, NodeDef, SystemDef } from '../../types';
import { newLink, uniqueId } from '../../lib/util';

export type Selection = { kind: 'node'; id: string } | { kind: 'link'; id: string } | { kind: 'guard'; id: string } | null;

export const LINK_HELP: Record<LinkType, string> = {
  delegate:
    "The source gets a tool that runs the target in an isolated session and returns the target's terminal-tool result (agent-as-tool).",
  handoff:
    'The source can transfer the conversation with the user to the target (ADK transfer_to_agent); the target becomes user-facing.',
  observe:
    "The target runs after every completed turn of the source, on that turn's transcript (e.g. memory extraction).",
};

export const PROMPT_VARS_HELP =
  'Jinja variables: agent_prompt, mode {id,label,description,prompt}, modes, state, vars, fragments.<id>, system, node, agent, turn.user_message, now, context.<name> (retrieval contexts).';

export function updateNode(s: SystemDef, id: string, patch: Partial<NodeDef>): SystemDef {
  return { ...s, nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

export function updateLink(s: SystemDef, id: string, patch: Partial<LinkDef>): SystemDef {
  return { ...s, links: s.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function addNode(s: SystemDef, node: NodeDef): SystemDef {
  return { ...s, nodes: [...s.nodes, node], entry: s.entry || node.id };
}

export function removeNode(s: SystemDef, id: string): SystemDef {
  return {
    ...s,
    nodes: s.nodes.filter((n) => n.id !== id),
    links: s.links.filter((l) => l.source !== id && l.target !== id),
    guards: (s.guards ?? []).filter((g) => g.node !== id),
    entry: s.entry === id ? '' : s.entry,
  };
}

export function renameNode(s: SystemDef, from: string, to: string): SystemDef {
  if (from === to) return s;
  return {
    ...s,
    entry: s.entry === from ? to : s.entry,
    nodes: s.nodes.map((n) => (n.id === from ? { ...n, id: to } : n)),
    links: s.links.map((l) => ({
      ...l,
      source: l.source === from ? to : l.source,
      target: l.target === from ? to : l.target,
    })),
    guards: (s.guards ?? []).map((g) => (g.node === from ? { ...g, node: to } : g)),
  };
}

// ------------------------------------------------------------------ guards

/** The node a guard checks ('' means the entry node). */
export const guardedNode = (s: SystemDef, g: GuardDef): string => g.node || s.entry;

export function updateGuard(s: SystemDef, id: string, patch: Partial<GuardDef>): SystemDef {
  return { ...s, guards: s.guards.map((g) => (g.id === id ? { ...g, ...patch } : g)) };
}

export function removeGuard(s: SystemDef, id: string): SystemDef {
  return { ...s, guards: s.guards.filter((g) => g.id !== id) };
}

/** Categories that mean "the user may be at risk" (the crisis-message rule). */
export const CRISIS_CATEGORIES = ['self-harm', 'suicide', 'self harm'];

export const DEFAULT_CRISIS_MESSAGE = `It sounds like you're going through something really hard. You don't have to face it alone.

- If you are in immediate danger, call your local emergency number.
- In the US, call or text **988** (Suicide & Crisis Lifeline). In Canada, call or text **9-8-8**. In the UK and Ireland, call Samaritans on **116 123**.
- Elsewhere, [findahelpline.com](https://findahelpline.com) lists free, confidential services.`;

export const DEFAULT_BLOCK_MESSAGE = "I can't help with that here. If something is worrying you, I'm happy to talk about it another way.";

export const DEFAULT_SAFE_REPLY = "I'm sorry — I can't give a good answer to that. Could you tell me a bit more about what you need?";

export type GuardPreset = 'mira' | 'strict';

export const GUARD_PRESETS: Record<GuardPreset, { label: string; help: string }> = {
  mira: {
    label: 'MIRA-style',
    help: "Input: self-harm adds crisis resources, then the agent is told to take care; other risks only inform. Output: a flagged reply is regenerated (checked with the user's message).",
  },
  strict: {
    label: 'Strict',
    help: 'Input: anything flagged is blocked with a fixed reply. Output: a flagged reply is replaced with a fixed message.',
  },
};

/** The rules (and scope / retries) a preset gives a guard of `check`. */
export function presetFor(preset: GuardPreset, check: GuardDef['check']): Pick<GuardDef, 'rules' | 'scope' | 'max_retries'> {
  if (check === 'input') {
    const rules: GuardRule[] =
      preset === 'mira'
        ? [
            { categories: [...CRISIS_CATEGORIES], action: 'add_message', message: DEFAULT_CRISIS_MESSAGE },
            { categories: [], action: 'inform', message: '' },
          ]
        : [{ categories: [], action: 'block', message: DEFAULT_BLOCK_MESSAGE }];
    return { rules, scope: 'message', max_retries: 2 };
  }
  return preset === 'mira'
    ? { rules: [{ categories: [], action: 'regenerate', message: DEFAULT_SAFE_REPLY }], scope: 'exchange', max_retries: 2 }
    : { rules: [{ categories: [], action: 'replace', message: DEFAULT_SAFE_REPLY }], scope: 'exchange', max_retries: 0 };
}

/** A new guard on `node` (positioned to its left: input above, output below). */
export function newGuard(s: SystemDef, classifier: string, node: string, check: GuardDef['check'], preset: GuardPreset | null): GuardDef {
  const target = s.nodes.find((n) => n.id === (node || s.entry));
  const base = target?.position ?? { x: 120, y: 120 };
  const taken = (s.guards ?? []).map((g) => g.id);
  const stem = `${check}_${classifier.replace(/[^A-Za-z0-9_]+/g, '_')}`.replace(/^([^A-Za-z_])/, '_$1');
  const sameSpot = (s.guards ?? []).filter((g) => (g.node || s.entry) === (node || s.entry) && g.check === check).length;
  return {
    id: uniqueId(stem, taken),
    classifier,
    node,
    check,
    scope: check === 'output' ? 'exchange' : 'message',
    rules: [],
    max_retries: 2,
    enabled: true,
    position: { x: Math.round(base.x - 250), y: Math.round(base.y + (check === 'input' ? -110 : 110) + sameSpot * 70) },
    ...(preset ? presetFor(preset, check) : {}),
  };
}

export function linkIdFor(s: SystemDef, type: LinkType, source: string, target: string, except?: string): string {
  return uniqueId(
    `${type}_${source}_${target}`,
    s.links.filter((l) => l.id !== except).map((l) => l.id),
  );
}

export function addLink(s: SystemDef, type: LinkType, source: string, target: string): { system: SystemDef; link: LinkDef } {
  const link = newLink(linkIdFor(s, type, source, target), type, source, target);
  if (type === 'delegate') {
    const taken = s.links.filter((l) => l.source === source && l.tool_name).map((l) => l.tool_name as string);
    link.tool_name = uniqueId(`ask_${target}`, taken);
  }
  return { system: { ...s, links: [...s.links, link] }, link };
}

export function removeLink(s: SystemDef, id: string): SystemDef {
  return { ...s, links: s.links.filter((l) => l.id !== id) };
}

/** Free position to the right of the existing nodes. */
export function nextPosition(s: SystemDef): { x: number; y: number } {
  if (!s.nodes.length) return { x: 120, y: 120 };
  const maxX = Math.max(...s.nodes.map((n) => n.position.x));
  const avgY = s.nodes.reduce((acc, n) => acc + n.position.y, 0) / s.nodes.length;
  return { x: Math.round(maxX + 300), y: Math.round(avgY) };
}
