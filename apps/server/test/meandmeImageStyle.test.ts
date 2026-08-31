import { describe, expect, it } from 'vitest';
import {
  ANATOMY_GUARD,
  buildBirthPrompt,
  buildEncounterPhotoPrompt,
  buildTravelPrompt,
  CUTE_BACKGROUNDS,
  CUTE_POSES,
  NO_TEXT_GUARD,
  STYLE_ANCHOR,
  TRAVEL_LIMB_GUARD,
  TRAVEL_SCENE_COMPOSITION,
  ENCOUNTER_ANATOMY_GUARD,
} from '../src/lib/meandmeImageStyle.js';

const appearance = { breed: 'british', baseColor: 'orange', pattern: 'tabby', eyes: 'hetero' } as const;
const attrs = { courage: 5, curiosity: 7, affinity: 6, insight: 5 };

describe('Me&Me production image prompts', () => {
  it('removes the cover signal and applies the strong no-text guard to both templates', () => {
    const birth = buildBirthPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
    });
    const travel = buildTravelPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
      identityAnchor: birth.identityAnchor,
      locationName: '星湖绿境', mood: '安静而好奇',
      narrative: '在湖边发现一片发光的叶子，伸出右前爪轻轻碰了碰',
      hasRef: false,
    });

    expect(STYLE_ANCHOR).not.toContain('封面');
    expect(birth.prompt).toContain(NO_TEXT_GUARD);
    expect(travel).toContain(NO_TEXT_GUARD);
    expect(birth.prompt).not.toContain('儿童绘本封面');
    expect(travel).not.toContain('儿童绘本封面');
    expect(NO_TEXT_GUARD).not.toContain('零符号');
    expect(NO_TEXT_GUARD).not.toContain('完全空白');
    expect(NO_TEXT_GUARD).toContain('地图可保留路线、罗盘、星图等非文字旅行图形');
  });

  it('requires exactly four legs and prevents travel props from duplicating paws', () => {
    const birth = buildBirthPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
    });
    const travel = buildTravelPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
      identityAnchor: birth.identityAnchor,
      locationName: '云港集市', mood: '兴奋',
      narrative: '背着旅行包站在码头，双爪捧着地图观察航线',
      hasRef: false,
    });

    expect(birth.prompt).toContain(ANATOMY_GUARD);
    expect(travel).toContain(ANATOMY_GUARD);
    expect(travel).toContain(TRAVEL_LIMB_GUARD);
    expect(travel).toContain('恰好四条腿');
    expect(travel).toContain('持地图或其他道具时，只能使用上述已有的两只前爪');
    expect(travel).toContain('被道具、身体或背包遮挡的腿保持被遮挡');
  });

  it('keeps birth portrait and travel scene as independent composition templates', () => {
    const birth = buildBirthPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
    });
    const narrative = '在湖边发现一片发光的叶子，伸出右前爪轻轻碰了碰';
    const travel = buildTravelPrompt({
      name: '小云', personality: '温柔、好奇', appearance, attrs,
      identityAnchor: birth.identityAnchor,
      locationName: '星湖绿境', mood: '安静而好奇', narrative, hasRef: false,
    });

    expect(birth.prompt).toContain('标准角色定妆构图');
    expect(birth.prompt).not.toContain(TRAVEL_SCENE_COMPOSITION);
    expect(travel).toContain(TRAVEL_SCENE_COMPOSITION);
    expect(travel).toContain(`旅行现场：${narrative}`);
    expect(travel).not.toContain('标准角色定妆构图');
    for (const generic of [...CUTE_POSES, ...CUTE_BACKGROUNDS]) {
      expect(travel).not.toContain(generic);
    }
  });

  it('builds an anonymous two-cat encounter photo without names or extra animals', () => {
    const prompt = buildEncounterPhotoPrompt({
      leftAppearance: appearance,
      rightAppearance: { breed: 'ragdoll', baseColor: 'cream', pattern: 'solid', eyes: 'blue' },
      locationName: '云港集市',
      encounterSummary: '两只旅行猫在路口安静地点头，留下了一张合照。',
    });
    expect(prompt).toContain(ENCOUNTER_ANATOMY_GUARD);
    expect(prompt).toContain('恰好两只猫');
    expect(prompt).toContain('猫A视觉DNA');
    expect(prompt).toContain('猫B视觉DNA');
    expect(prompt).toContain('同一连续场景');
    expect(prompt).not.toContain('小云');
    expect(prompt).not.toContain('主人');
  });
});
