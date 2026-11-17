// Server-sent events over fetch (POST bodies are not possible with EventSource).

export async function readSSE<T>(res: Response, onEvent: (event: T) => void): Promise<void> {
  if (!res.body) throw new Error('The response has no body to stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const flush = (block: string) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return;
    let parsed: T;
    try {
      parsed = JSON.parse(data) as T;
    } catch (err) {
      console.warn('Unparseable SSE event', data, err);
      return;
    }
    onEvent(parsed);
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      flush(block);
      idx = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) flush(buffer.replace(/\r\n?/g, '\n'));
}
