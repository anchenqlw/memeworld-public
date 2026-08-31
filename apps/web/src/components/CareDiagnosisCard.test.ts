import { describe, expect, it } from 'vitest';
import type { QcaDiagnosis } from '../api/client';
import fs from 'node:fs';
import { CARE_REPAIR_SUCCESS_NOTICE, careDiagnosisFor, completeCareRepair } from './CareDiagnosisCard';

// backlog #072：红点语义与档案内容一致——broken 显示诊断，非 broken 不显示
const diagnosis: QcaDiagnosis = {
  summary: '小猫的云端资源检查没通过，需要你照看一下。',
  causes: ['旅行代理检查没通过'],
  actions: [
    { id: 'check_pat', label: '检查 / 更换 PAT' },
    { id: 'check_credits', label: '查看 Credits 余额', href: 'https://qoder.com/pricing' },
    { id: 'repair', label: '一键修复' },
  ],
  checked_at: '2026-07-30T01:00:00.000Z',
};

describe('careDiagnosisFor', () => {
  it('connects a successful production repair action to the completed notice and profile refresh', async () => {
    const events: string[] = [];
    await completeCareRepair({
      repairAdventure: async () => { events.push('repair'); },
      setNotice: (notice) => { events.push(`notice:${notice}`); },
      onChanged: () => { events.push('refresh'); },
    });
    expect(CARE_REPAIR_SUCCESS_NOTICE).toBe('修复已完成，小猫的云端行囊已经恢复。');
    expect(CARE_REPAIR_SUCCESS_NOTICE).not.toContain('请求已发出');
    expect(CARE_REPAIR_SUCCESS_NOTICE).not.toContain('稍后');
    expect(events).toEqual([
      'repair',
      `notice:${CARE_REPAIR_SUCCESS_NOTICE}`,
      'refresh',
    ]);
    const source = fs.readFileSync(new URL('./CareDiagnosisCard.tsx', import.meta.url), 'utf8');
    expect(source).toContain('await completeCareRepair({ repairAdventure: () => api.repairAdventure(), setNotice, onChanged });');
  });

  it('status=broken 且服务端下发诊断时显示', () => {
    expect(careDiagnosisFor({ status: 'broken', qca_health: { status: 'broken' }, qca_diagnosis: diagnosis }))
      .toEqual(diagnosis);
  });

  it('健康检查 broken 但 cat.status 未同步时同样显示（红点必有出口）', () => {
    expect(careDiagnosisFor({ status: 'active', qca_health: { status: 'broken' }, qca_diagnosis: diagnosis }))
      .toEqual(diagnosis);
  });

  it('healthy 时不显示诊断区', () => {
    expect(careDiagnosisFor({ status: 'active', qca_health: { status: 'healthy' }, qca_diagnosis: undefined }))
      .toBeNull();
    expect(careDiagnosisFor({ status: 'active', qca_health: { status: 'healthy' }, qca_diagnosis: diagnosis }))
      .toBeNull();
  });

  it('broken 但服务端未下发诊断时不渲染空卡片', () => {
    expect(careDiagnosisFor({ status: 'broken', qca_health: { status: 'broken' }, qca_diagnosis: undefined }))
      .toBeNull();
  });
});
