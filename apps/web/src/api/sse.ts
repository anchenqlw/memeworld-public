export type SseEvent = {
  type: string;
  text?: string;
  message?: string;
  code?: string;
  help_url?: string;
};

export async function consumeSseStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeFrames = (flush = false) => {
    if (flush) buffer += decoder.decode();
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? '' : frames.pop() ?? '';
    for (const frame of frames) {
      const payload = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (payload) onEvent(JSON.parse(payload) as SseEvent);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeFrames();
    }
    consumeFrames(true);
  } finally {
    reader.releaseLock();
  }
}
