import { describe, expect, it } from 'vitest';
import { validateDestinationSelection } from '../src/services/travelService.js';

describe('validateDestinationSelection #099', () => {
  const base = {
    eligibleLocationIds: ['loc-cloud-lighthouse', 'loc-catpaw-teahouse'],
    hasTravelToday: false,
    selectedOn: null,
    selectedLocationId: null,
    today: '2026-08-26',
  } as const;

  it('accepts only an eligible first choice', () => {
    expect(validateDestinationSelection({ ...base, locationId: 'loc-cloud-lighthouse' }))
      .toEqual({ accepted: true, reason: 'accepted' });
    expect(validateDestinationSelection({ ...base, locationId: 'loc-starlake-shore' }))
      .toEqual({ accepted: false, reason: 'invalid_candidate' });
    expect(validateDestinationSelection({ ...base, locationId: null }))
      .toEqual({ accepted: false, reason: 'invalid_candidate' });
  });

  it('makes the same selection idempotent and rejects same-day replacement', () => {
    const selected = {
      ...base,
      selectedOn: base.today,
      selectedLocationId: 'loc-cloud-lighthouse',
    };
    expect(validateDestinationSelection({ ...selected, locationId: 'loc-cloud-lighthouse' }))
      .toEqual({ accepted: true, reason: 'idempotent' });
    expect(validateDestinationSelection({ ...selected, locationId: 'loc-catpaw-teahouse' }))
      .toEqual({ accepted: false, reason: 'already_selected' });
  });

  it('lets the final travel ledger override every intermediate selection', () => {
    expect(validateDestinationSelection({
      ...base,
      hasTravelToday: true,
      selectedOn: base.today,
      selectedLocationId: 'loc-cloud-lighthouse',
      locationId: 'loc-cloud-lighthouse',
    })).toEqual({ accepted: false, reason: 'travel_completed' });
  });
});
