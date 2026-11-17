import { useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { mediaKind } from '../../lib/media';
import { toInline } from '../../lib/util';
import type { ChatOutput, FileOutput, ViewerOutput } from '../../types';
import type { ChatItem } from './useChat';

function FileCard({ o }: { o: FileOutput }) {
  const kind = mediaKind(o);
  const [showPdf, setShowPdf] = useState(false);
  const name = o.source_file ? o.source_file.split(/[\\/]/).pop() : '';
  return (
    <div className="card output-card">
      <div className="output-card-head">
        <span className="output-card-icon" aria-hidden>
          {kind === 'video' ? '🎬' : kind === 'audio' ? '🎧' : kind === 'image' ? '🖼' : kind === 'pdf' ? '📄' : '📎'}
        </span>
        <div>
          <div className="output-card-title">{o.title || name || o.resource_id}</div>
          <div className="muted small">
            {o.source_type}
            {name && <> · {name}</>}
            {o.resource_id && <> · {o.resource_id}</>}
          </div>
        </div>
      </div>
      {o.note && <div className="output-note">{o.note}</div>}
      {kind === 'video' && <video className="output-media" controls preload="metadata" src={o.url} />}
      {kind === 'audio' && <audio className="output-audio" controls preload="metadata" src={o.url} />}
      {kind === 'image' && (
        <a href={o.url} target="_blank" rel="noreferrer">
          <img className="output-media" src={o.url} alt={o.title} />
        </a>
      )}
      {kind === 'pdf' && showPdf && <iframe className="output-pdf" src={o.url} title={o.title} />}
      {o.summary && <div className="muted small output-summary">{o.summary}</div>}
      <div className="output-actions">
        {kind === 'pdf' && (
          <button type="button" className="btn btn-sm" onClick={() => setShowPdf(!showPdf)}>
            {showPdf ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <a className="btn btn-sm" href={o.url} target="_blank" rel="noreferrer">
          Open
        </a>
        <a className="btn btn-sm btn-ghost" href={o.url} download={name || true}>
          Download
        </a>
      </div>
    </div>
  );
}

function ViewerCard({ o, onOpen }: { o: ViewerOutput; onOpen?: (o: ViewerOutput) => void }) {
  return (
    <div className="card output-card">
      <div className="output-card-head">
        <span className="output-card-icon" aria-hidden>
          🎓
        </span>
        <div>
          <div className="output-card-title">{o.title || o.resource_id}</div>
          <div className="muted small">
            course page{o.section && <> · {o.section}</>}
          </div>
        </div>
      </div>
      {o.note && <div className="output-note">{o.note}</div>}
      {o.summary && <div className="muted small output-summary">{o.summary}</div>}
      <div className="output-actions">
        {onOpen && (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen(o)}>
            Open in viewer
          </button>
        )}
        <a className="btn btn-sm" href={o.url} target="_blank" rel="noreferrer">
          New tab
        </a>
      </div>
    </div>
  );
}

export function OutputView({
  item,
  nodeLabel,
  showNode,
  onOpenViewer,
  onRetry,
}: {
  item: ChatItem;
  nodeLabel: (id: string | null) => string;
  showNode: boolean;
  onOpenViewer?: (o: ViewerOutput) => void;
  onRetry?: (text: string) => void;
}) {
  if (item.kind === 'error') {
    return <div className="sys-line sys-error pre-line">⚠ {item.message}</div>;
  }
  const o: ChatOutput = item.output;
  switch (o.type) {
    case 'user':
      return (
        <div className={`msg msg-user${item.pending ? ' pending' : ''}${item.failed ? ' failed' : ''}`}>
          <div className="bubble">{o.content}</div>
          {item.failed && onRetry && (
            <div className="msg-meta">
              <span className="text-danger">Not sent.</span>{' '}
              <button type="button" className="link-btn" onClick={() => onRetry(o.content)}>
                Retry
              </button>
            </div>
          )}
        </div>
      );
    case 'message':
      return (
        <div className={`msg msg-assistant${o.safety ? ' msg-safety' : ''}`}>
          {(showNode || o.safety) && (
            <div className="msg-node">
              {showNode && nodeLabel(o.node)}
              {o.safety && (
                <span className="safety-mark" title="Sent by a safety guard, not written by the agent">
                  {showNode && ' · '}⛨ safety message
                </span>
              )}
            </div>
          )}
          <div className="bubble">
            <Markdown>{o.content}</Markdown>
          </div>
        </div>
      );
    case 'file':
      return (
        <div className="msg msg-assistant">
          {showNode && <div className="msg-node">{nodeLabel(o.node)}</div>}
          <FileCard o={o} />
        </div>
      );
    case 'viewer':
      return (
        <div className="msg msg-assistant">
          {showNode && <div className="msg-node">{nodeLabel(o.node)}</div>}
          <ViewerCard o={o} onOpen={onOpenViewer} />
        </div>
      );
    case 'mode':
      return <div className="sys-line">Switched to {o.label || o.mode}</div>;
    case 'handoff':
      return (
        <div className="sys-line">
          Handed off from {nodeLabel(o.from)} to {nodeLabel(o.to)}
        </div>
      );
    default: {
      const unknown = o as { type?: string };
      return (
        <div className="sys-line">
          {unknown.type ?? 'output'}: <code>{toInline(o)}</code>
        </div>
      );
    }
  }
}
