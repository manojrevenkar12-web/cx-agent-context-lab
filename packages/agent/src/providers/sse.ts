export interface SseEvent {
  event: string;
  data: string;
}

/** Server-sent events from a fetch body, as the Anthropic and OpenAI streaming APIs send them. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut = buf.search(/\r?\n\r?\n/);
      while (cut >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^\r?\n\r?\n/, "");
        const ev = parseEvent(raw);
        if (ev) yield ev;
        cut = buf.search(/\r?\n\r?\n/);
      }
    }
    const tail = parseEvent(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`provider returned ${status}: ${body.slice(0, 300)}`);
  }
  get retryable(): boolean {
    return this.status === 429 || this.status === 529 || this.status >= 500;
  }
}
