import { describe, expect, it } from 'vitest';
import type { ChronicleEntry } from '../../api/client';
import { groupChronicleEntries } from './ChroniclePanel';

function entry(id: string, date: string): ChronicleEntry {
  return {
    id, date, title: id, summary: `${id} 摘要`, change_type: '小小变化',
    source_kind: 'owner', history_file: `runtime:chronicle/${id}`,
  };
}

describe('groupChronicleEntries', () => {
  it('keeps several events from the same day together and preserves API order', () => {
    const days = groupChronicleEntries([
      entry('today-3', '2026-07-18'),
      entry('today-2', '2026-07-18'),
      entry('today-1', '2026-07-18'),
      entry('yesterday-1', '2026-07-17'),
    ]);
    expect(days.map((day) => ({ date: day.date, ids: day.entries.map((item) => item.id) }))).toEqual([
      { date: '2026-07-18', ids: ['today-3', 'today-2', 'today-1'] },
      { date: '2026-07-17', ids: ['yesterday-1'] },
    ]);
  });
});
