import { describe, expect, it } from 'vitest';
import { consumeSseStream, type SseEvent } from './sse';

function fragmentedStream(parts: string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe('consumeSseStream', () => {
  it('parses JSON split across arbitrary chunks and flushes UTF-8 safely', async () => {
    const events: SseEvent[] = [];
    await consumeSseStream(fragmentedStream([
      'data: {"type":"del',
      'ta","text":"你',
      '好"}\n\ndata: {"type":"done"}\n',
      '\n',
    ]), (event) => events.push(event));
    expect(events).toEqual([{ type: 'delta', text: '你好' }, { type: 'done' }]);
  });

  it('accepts a final event without a trailing blank line', async () => {
    const events: SseEvent[] = [];
    await consumeSseStream(fragmentedStream(['data: {"type":"done"}']), (event) => events.push(event));
    expect(events).toEqual([{ type: 'done' }]);
  });
});
