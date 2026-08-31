import { describe, expect, it } from 'vitest';
import {
  loadWorldBooks,
  selectReadingSource,
  type OwnerBookSource,
} from '../src/services/readingSourceService.js';

const ownerBooks: OwnerBookSource[] = [
  { id: 'card-new', title: '主人最近在读', brief: '从主人主动保留的读书卡片出发。' },
  { id: 'card-old', title: '主人先前在读', brief: '仍然有效的较早读书卡片。' },
];

describe('#092 reading source selection', () => {
  it('opens exactly one reading branch in each completed-seven-travel window', () => {
    for (let completedTravelCount = 0; completedTravelCount < 14; completedTravelCount += 1) {
      const source = selectReadingSource({ completedTravelCount, ownerBooks, worldBooks: [] });
      expect(Boolean(source), `completed=${completedTravelCount}`).toBe(
        completedTravelCount === 6 || completedTravelCount === 13,
      );
    }
  });

  it('prefers active owner books and rotates deterministically by reading cycle', () => {
    expect(selectReadingSource({ completedTravelCount: 6, ownerBooks, worldBooks: [] })).toMatchObject({
      source_type: 'growth_card', source_id: 'card-new', title: '主人最近在读',
    });
    expect(selectReadingSource({ completedTravelCount: 13, ownerBooks, worldBooks: [] })).toMatchObject({
      source_type: 'growth_card', source_id: 'card-old', title: '主人先前在读',
    });
  });

  it('uses only approved original world books when no active owner book exists', () => {
    const worldBooks = loadWorldBooks();
    expect(worldBooks.length).toBeGreaterThanOrEqual(2);
    expect(worldBooks.every((book) => book.rights === 'original' && /^book-cloud-/.test(book.id))).toBe(true);
    expect(selectReadingSource({ completedTravelCount: 6, ownerBooks: [], worldBooks })).toMatchObject({
      source_type: 'world_book', source_id: worldBooks[0].id,
    });
  });

  it('does not select a withdrawn card that is absent from the active input', () => {
    const source = selectReadingSource({
      completedTravelCount: 6,
      ownerBooks: ownerBooks.filter((book) => book.id !== 'card-new'),
      worldBooks: [],
    });
    expect(source).toMatchObject({ source_type: 'growth_card', source_id: 'card-old' });
    expect(source?.source_id).not.toBe('card-new');
  });
});
