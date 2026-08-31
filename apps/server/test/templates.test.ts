import { describe, expect, it } from 'vitest';
import { renderDailyTravelTask } from '../src/lib/templates.js';

describe('#099 daily travel destination handshake', () => {
  it('reports a selected eligible destination before the final travel report', () => {
    const task = renderDailyTravelTask('布丁', 'https://api.example.test');
    const worldIndex = task.indexOf('/api/v1/world/today');
    const destinationIndex = task.indexOf('/api/v1/travels/destination');
    const reportIndex = task.indexOf('/api/v1/travels/report');
    expect(worldIndex).toBeGreaterThanOrEqual(0);
    expect(destinationIndex).toBeGreaterThan(worldIndex);
    expect(reportIndex).toBeGreaterThan(destinationIndex);
    expect(task).toContain('只有服务端返回 accepted:true 才把它当作今日目的地');
    expect(task).toContain('不得在同一天改报另一个地点');
    expect(task).toContain('只允许调用 context 中给出的三个 API');
  });
});

describe('#092 daily travel reading branch', () => {
  it('uses only the server-selected source in the same travel report', () => {
    const task = renderDailyTravelTask('布丁', 'https://api.example.test');
    expect(task).toContain('reading_source');
    expect(task).toContain('只能使用 world/today 返回的 reading_source');
    expect(task).toContain('source_type');
    expect(task).toContain('source_id');
    expect(task).toContain('不得把阅读内容写入 impressions、猫遇、串门、编年史或任何公开摘要');
    expect(task.match(/\/api\/v1\/(world\/today|travels\/destination|travels\/report)/g)).toHaveLength(3);
    expect(task).toContain('只允许调用 context 中给出的三个 API');
  });
});
