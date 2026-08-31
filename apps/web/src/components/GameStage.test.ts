import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { wanderingCaption } from './GameStage';

// #056b：流浪形态副标题三档分支
describe('wanderingCaption', () => {
  it('今日有新明信片时引导查看', () => {
    expect(wanderingCaption('星湖岸', true)).toContain('明信片');
  });

  it('有愿望时带方向感', () => {
    expect(wanderingCaption('星湖岸', false)).toBe('它记着你的愿望，正往「星湖岸」的方向流浪');
  });

  it('无愿望时云海漫游', () => {
    expect(wanderingCaption(null, false)).toContain('云海深处流浪');
  });
});

const gameStageSource = readFileSync(new URL('./GameStage.tsx', import.meta.url), 'utf8');
const mapPanelSource = readFileSync(new URL('./panels/MapPanel.tsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../api/client.ts', import.meta.url), 'utf8');

function wiringGuard(sources: { game: string; map: string; client: string }) {
  return sources.game.includes('travelAvailabilityText({ status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at }, availabilityClock)')
    && sources.game.includes('travelAvailability={worldDigest ? { status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at } : null}')
    && sources.game.includes('availabilityNowMs={availabilityClock}')
    && sources.game.includes('const decision = decideTravelAvailabilityRefresh({')
    && sources.game.includes('availabilityRefreshRef.current = decision.refreshedDeadline;')
    && sources.game.includes('if (decision.shouldRefresh) void refresh();')
    && sources.map.includes('travelAvailabilityText(travelAvailability, availabilityNowMs)')
    && sources.map.includes("data-travel-status={travelAvailability?.status ?? 'unknown'}")
    && sources.client.includes('travel_status: TravelAvailabilityStatus')
    && sources.client.includes('next_available_at: string | null')
    && sources.client.includes('err.error?.next_available_at');
}

describe('#126 production wiring', () => {
  const sources = { game: gameStageSource, map: mapPanelSource, client: clientSource };

  it('passes the server digest unchanged to both visible travel surfaces', () => {
    expect(wiringGuard(sources)).toBe(true);
  });

  it('mutation proof: deleting either consumer or the typed server contract reliably fails', () => {
    expect(wiringGuard({ ...sources, game: sources.game.replace('travelAvailabilityText({ status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at }, availabilityClock)', '') })).toBe(false);
    expect(wiringGuard({ ...sources, map: sources.map.replace("data-travel-status={travelAvailability?.status ?? 'unknown'}", '') })).toBe(false);
    expect(wiringGuard({ ...sources, client: sources.client.replace('travel_status: TravelAvailabilityStatus', '') })).toBe(false);
    expect(wiringGuard({ ...sources, game: sources.game.replace(
      'travelAvailability={worldDigest ? { status: worldDigest.travel_status, next_available_at: worldDigest.next_available_at } : null}',
      "travelAvailability={{ status: travels.length ? 'completed_today' : 'available', next_available_at: null }}",
    ) })).toBe(false);
    expect(wiringGuard({ ...sources, game: sources.game.replace('const decision = decideTravelAvailabilityRefresh({', 'const decision = ({') })).toBe(false);
    expect(wiringGuard({ ...sources, game: sources.game.replace('if (decision.shouldRefresh) void refresh();', '') })).toBe(false);
  });
});
