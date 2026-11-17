import type { TraceEvent } from '../../types';

const TOOL_STATUS: Record<string, string> = {
  search_resources: 'Searching the library…',
  examine_resource: 'Reading a resource…',
  memory_search: 'Checking past sessions…',
  provide_file: 'Preparing a file…',
  open_course_page: 'Opening a course page…',
  switch_mode: 'Switching topic…',
  send_message: 'Writing a reply…',
  finish_turn: 'Wrapping up…',
  record_memories: 'Saving notes…',
  return_summary: 'Summarizing findings…',
  return_result: 'Returning a result…',
  transfer_to_agent: 'Handing off…',
};

/** A human status line from the latest trace event of a running turn. */
export function statusFromTrace(
  trace: TraceEvent | undefined,
  opts: { entry: string; label: (nodeId: string) => string; delegates: Map<string, string> },
): string {
  if (!trace) return 'Thinking…';
  const d = (trace.data && typeof trace.data === 'object' ? trace.data : {}) as Record<string, unknown>;
  let text: string;
  switch (trace.event) {
    case 'tool_call': {
      const name = typeof d.name === 'string' ? d.name : '';
      const target = opts.delegates.get(name);
      text = target ? `Consulting ${opts.label(target)}…` : (TOOL_STATUS[name] ?? `Using ${name}…`);
      break;
    }
    case 'spawn':
      return d.observe ? `${opts.label(trace.agent)} is reviewing the turn…` : `Consulting ${opts.label(trace.agent)}…`;
    case 'inject':
      return 'Recalling past sessions…';
    case 'search':
      return 'Checking past sessions…';
    case 'llm_output':
      text = 'Writing…';
      break;
    case 'reply_recovery':
      text = 'Retrying the reply…';
      break;
    case 'nudge':
      text = 'Finishing up…';
      break;
    default:
      text = 'Thinking…';
  }
  return trace.agent && trace.agent !== opts.entry && trace.agent !== 'memory' ? `${opts.label(trace.agent)}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text;
}
