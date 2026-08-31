import { describe, expect, it } from 'vitest';
import { createSingleFlight } from './singleFlight';

describe('createSingleFlight', () => {
  it('rejects duplicate work until the active request is released', () => {
    const gate = createSingleFlight();
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    gate.release();
    expect(gate.take()).toBe(true);
  });
});
