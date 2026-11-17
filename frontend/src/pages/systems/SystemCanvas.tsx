import { useEffect, useMemo, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import type { AgentSummary, ClassifierSummary, SystemDef } from '../../types';
import { userFacingNodes } from '../../lib/util';
import { ACTION_SHORT } from '../safety/safetyUi';
import type { Selection } from './systemOps';

export const USER_NODE = '__user';
const ENTRY_EDGE = '__entry';

type AgentNodeData = {
  id: string;
  label: string;
  agentId: string;
  agentName: string | null;
  isEntry: boolean;
  userFacing: boolean;
  modes: number;
  injectMemory: boolean;
  extraTools: number;
};
type GuardNodeData = {
  id: string;
  classifierName: string | null;
  classifierId: string;
  check: 'input' | 'output';
  enabled: boolean;
  rules: number;
  actions: string;
};
type AgentFlowNode = Node<AgentNodeData, 'agent'>;
type UserFlowNode = Node<Record<string, never>, 'user'>;
type GuardFlowNode = Node<GuardNodeData, 'guard'>;
type FlowNode = AgentFlowNode | UserFlowNode | GuardFlowNode;

/** Flow ids of guard nodes (guard ids may equal node ids). */
const GUARD_PREFIX = '__guard:';
const isGuard = (flowId: string) => flowId.startsWith(GUARD_PREFIX);

function GuardNodeView({ data, selected }: NodeProps<GuardFlowNode>) {
  return (
    <div className={`flow-node flow-guard guard-${data.check}${selected ? ' selected' : ''}${data.enabled ? '' : ' disabled'}`}>
      <div className="flow-guard-head">
        <span className="flow-guard-shield" aria-hidden>
          ⛨
        </span>
        <div className="flow-node-title">{data.classifierName ?? <span className="text-danger">missing {data.classifierId}</span>}</div>
      </div>
      <div className="flow-node-sub">
        <code>{data.id}</code>
      </div>
      <div className="flow-node-badges">
        <span className={`badge ${data.check === 'input' ? 'badge-accent' : 'badge-observe'}`}>{data.check === 'input' ? 'checks input' : 'checks reply'}</span>
        <span className="badge badge-muted" title="What happens when it flags something">
          {data.actions}
        </span>
        {!data.enabled && <span className="badge badge-warn">off</span>}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

function AgentNodeView({ data, selected }: NodeProps<AgentFlowNode>) {
  return (
    <div className={`flow-node${selected ? ' selected' : ''}${data.userFacing ? ' user-facing' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="flow-node-title">{data.label || data.id}</div>
      <div className="flow-node-sub">
        <code>{data.id}</code>
        <span className="sep">·</span>
        {data.agentName ? <span>{data.agentName}</span> : <span className="text-danger">missing agent {data.agentId}</span>}
      </div>
      <div className="flow-node-badges">
        {data.isEntry && <span className="badge badge-accent">entry</span>}
        {data.userFacing && <span className="badge badge-ok">user-facing</span>}
        {data.modes > 0 && <span className="badge badge-neutral">{data.modes} modes</span>}
        {data.injectMemory && <span className="badge badge-observe">memory</span>}
        {data.extraTools > 0 && <span className="badge badge-muted">+{data.extraTools} tools</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function UserNodeView() {
  return (
    <div className="flow-node flow-user">
      <div className="flow-user-icon">👤</div>
      <div className="flow-node-title">User</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { agent: AgentNodeView, user: UserNodeView, guard: GuardNodeView };

const EDGE_COLORS = { delegate: '#4f7cff', handoff: '#d9822b', observe: '#8b6cc9', entry: '#7a8599', guard: '#1d9a8a' };

function initialUserPosition(s: SystemDef): { x: number; y: number } {
  if (!s.nodes.length) return { x: -120, y: 120 };
  const minX = Math.min(...s.nodes.map((n) => n.position.x));
  const entry = s.nodes.find((n) => n.id === s.entry) ?? s.nodes[0];
  return { x: minX - 240, y: entry.position.y + 8 };
}

type Move = { id: string; position: { x: number; y: number } };

export function SystemCanvas({
  system,
  agents,
  classifiers,
  selection,
  onSelect,
  onMoveNodes,
  onMoveGuards,
  onConnect,
}: {
  system: SystemDef;
  agents: AgentSummary[];
  /** null while loading (names are not checked yet). */
  classifiers: ClassifierSummary[] | null;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onMoveNodes: (moves: Move[]) => void;
  onMoveGuards: (moves: Move[]) => void;
  onConnect: (source: string, target: string) => void;
}) {
  const [userPos, setUserPos] = useState(() => initialUserPosition(system));
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);

  const agentNames = useMemo(() => new Map(agents.map((a) => [a.id, a.name || a.id])), [agents]);
  const classifierNames = useMemo(() => new Map((classifiers ?? []).map((c) => [c.id, c.name || c.id])), [classifiers]);
  const facing = useMemo(() => userFacingNodes(system), [system]);
  const guards = useMemo(() => system.guards ?? [], [system.guards]);

  useEffect(() => {
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      const out: FlowNode[] = [
        {
          id: USER_NODE,
          type: 'user',
          position: userPos,
          data: {},
          deletable: false,
          selectable: false,
          measured: prevById.get(USER_NODE)?.measured,
        },
      ];
      for (const n of system.nodes) {
        out.push({
          id: n.id,
          type: 'agent',
          position: n.position,
          deletable: false,
          selected: selection?.kind === 'node' && selection.id === n.id,
          measured: prevById.get(n.id)?.measured,
          data: {
            id: n.id,
            label: n.label,
            agentId: n.agent,
            agentName: agents.length ? (agentNames.get(n.agent) ?? null) : n.agent,
            isEntry: system.entry === n.id,
            userFacing: facing.has(n.id),
            modes: n.modes.length,
            injectMemory: n.inject_memory,
            extraTools: n.tools.length,
          },
        });
      }
      for (const g of guards) {
        const flowId = GUARD_PREFIX + g.id;
        const actions = g.rules.length ? [...new Set(g.rules.map((r) => ACTION_SHORT[r.action] ?? r.action))].join(' → ') : g.check === 'input' ? 'block' : 'regenerate';
        out.push({
          id: flowId,
          type: 'guard',
          position: g.position,
          deletable: false,
          connectable: false,
          selected: selection?.kind === 'guard' && selection.id === g.id,
          measured: prevById.get(flowId)?.measured,
          data: {
            id: g.id,
            classifierId: g.classifier,
            classifierName: classifiers ? (classifierNames.get(g.classifier) ?? null) : g.classifier,
            check: g.check,
            enabled: g.enabled,
            rules: g.rules.length,
            actions,
          },
        });
      }
      return out;
    });
  }, [system.nodes, system.entry, guards, facing, agentNames, agents.length, classifiers, classifierNames, selection, userPos, setNodes]);

  const edges = useMemo<Edge[]>(() => {
    const out: Edge[] = [];
    if (system.entry && system.nodes.some((n) => n.id === system.entry)) {
      out.push({
        id: ENTRY_EDGE,
        source: USER_NODE,
        target: system.entry,
        selectable: false,
        deletable: false,
        animated: true,
        style: { stroke: EDGE_COLORS.entry, strokeDasharray: '6 4', strokeWidth: 1.5 },
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.entry },
      });
    }
    for (const l of system.links) {
      const color = EDGE_COLORS[l.type];
      const selected = selection?.kind === 'link' && selection.id === l.id;
      const width = l.type === 'handoff' ? 3.5 : 1.75;
      out.push({
        id: l.id,
        source: l.source,
        target: l.target,
        selected,
        deletable: false,
        label: l.type === 'delegate' ? l.tool_name || 'delegate' : l.type,
        className: `edge-${l.type}`,
        style: {
          stroke: color,
          strokeWidth: selected ? width + 1.5 : width,
          strokeDasharray: l.type === 'observe' ? '2 5' : undefined,
          strokeLinecap: 'round',
        },
        labelStyle: { fill: color, fontWeight: 600, fontSize: 11, fontFamily: 'var(--font-mono)' },
        labelBgStyle: { fill: 'var(--bg-elev)', fillOpacity: 0.92 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
        interactionWidth: 16,
      });
    }
    // A dashed edge from each guard to the node it checks (none when that node doesn't exist).
    for (const g of guards) {
      const target = g.node || system.entry;
      if (!system.nodes.some((n) => n.id === target)) continue;
      const selected = selection?.kind === 'guard' && selection.id === g.id;
      out.push({
        id: `${GUARD_PREFIX}${g.id}`,
        source: GUARD_PREFIX + g.id,
        target,
        selected,
        deletable: false,
        className: 'edge-guard',
        label: g.check === 'input' ? 'checks input' : 'checks reply',
        style: {
          stroke: EDGE_COLORS.guard,
          strokeWidth: selected ? 2.5 : 1.5,
          strokeDasharray: '5 4',
          opacity: g.enabled ? 1 : 0.45,
        },
        labelStyle: { fill: EDGE_COLORS.guard, fontWeight: 600, fontSize: 10.5 },
        labelBgStyle: { fill: 'var(--bg-elev)', fillOpacity: 0.92 },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 3,
        markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_COLORS.guard, width: 14, height: 14 },
        interactionWidth: 12,
      });
    }
    return out;
  }, [system.entry, system.nodes, system.links, guards, selection]);

  const isValidConnection = (c: Connection | Edge) =>
    !!c.source && !!c.target && c.source !== c.target && c.target !== USER_NODE && !isGuard(c.source) && !isGuard(c.target);

  return (
    <ReactFlow<FlowNode, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={(_, n) => {
        if (n.id === USER_NODE) return;
        onSelect(isGuard(n.id) ? { kind: 'guard', id: n.id.slice(GUARD_PREFIX.length) } : { kind: 'node', id: n.id });
      }}
      onEdgeClick={(_, e) => {
        if (e.id === ENTRY_EDGE) return;
        onSelect(isGuard(e.id) ? { kind: 'guard', id: e.id.slice(GUARD_PREFIX.length) } : { kind: 'link', id: e.id });
      }}
      onPaneClick={() => onSelect(null)}
      onNodeDragStop={(_, _node, dragged) => {
        const at = (n: FlowNode) => ({ x: Math.round(n.position.x), y: Math.round(n.position.y) });
        const moves = dragged.filter((n) => n.id !== USER_NODE && !isGuard(n.id)).map((n) => ({ id: n.id, position: at(n) }));
        const guardMoves = dragged.filter((n) => isGuard(n.id)).map((n) => ({ id: n.id.slice(GUARD_PREFIX.length), position: at(n) }));
        const user = dragged.find((n) => n.id === USER_NODE);
        if (user) setUserPos(user.position);
        if (moves.length) onMoveNodes(moves);
        if (guardMoves.length) onMoveGuards(guardMoves);
      }}
      onConnect={(c) => c.source && c.target && onConnect(c.source, c.target)}
      isValidConnection={isValidConnection}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }}
      minZoom={0.2}
      colorMode="system"
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <MiniMap pannable zoomable className="minimap" />
    </ReactFlow>
  );
}

export function EdgeLegend() {
  return (
    <div className="edge-legend">
      <span>
        <svg width="28" height="8">
          <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_COLORS.entry} strokeWidth="1.5" strokeDasharray="6 4" />
        </svg>
        entry
      </span>
      <span>
        <svg width="28" height="8">
          <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_COLORS.delegate} strokeWidth="2" />
        </svg>
        delegate
      </span>
      <span>
        <svg width="28" height="8">
          <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_COLORS.handoff} strokeWidth="4" />
        </svg>
        handoff
      </span>
      <span>
        <svg width="28" height="8">
          <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_COLORS.observe} strokeWidth="2" strokeDasharray="2 5" strokeLinecap="round" />
        </svg>
        observe
      </span>
      <span>
        <svg width="28" height="8">
          <line x1="0" y1="4" x2="28" y2="4" stroke={EDGE_COLORS.guard} strokeWidth="1.5" strokeDasharray="5 4" />
        </svg>
        guard
      </span>
    </div>
  );
}
