import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getPatForUser } from './catService.js';
import { deleteMemoryEntry, upsertMemoryEntry } from './qcaMemory.js';

export const ONBOARDING_QUESTIONS = ['owner_address', 'comfort_style', 'daily_joy', 'boundary', 'initial_keepsake'] as const;

type AnswerInput = { question_id: string; choice_id?: string; answer_text?: string; skipped?: boolean };

const LABELS: Record<string, string> = {
  owner_address: '主人希望的称呼', comfort_style: '主人疲惫时喜欢的陪伴方式', daily_joy: '最近容易开心的事',
  boundary: '暂时不要主动提及的话题', initial_keepsake: '第一次出门携带的信物',
};

function normalizeAnswer(answer: AnswerInput) {
  if (!ONBOARDING_QUESTIONS.includes(answer.question_id as typeof ONBOARDING_QUESTIONS[number])) {
    throw Object.assign(new Error('未知的互动问题'), { code: 'INVALID_QUESTION' });
  }
  const text = answer.answer_text?.trim() || null;
  if (text && text.length > 100) throw Object.assign(new Error('每条回答最多 100 字'), { code: 'ANSWER_TOO_LONG' });
  const type = answer.skipped ? 'skipped' : text ? 'free_text' : answer.choice_id ? 'choice' : 'skipped';
  const value = type === 'skipped' ? '主人暂时没有告诉我' : text || answer.choice_id || '';
  return { ...answer, answer_type: type, answer_text: text, choice_id: answer.choice_id || null, memory_digest: `${LABELS[answer.question_id]}：${value}` };
}

async function catForUser(userId: string) {
  const cat = await db.selectFrom('cats').select(['id', 'name', 'qca_memstore_id']).where('user_id', '=', userId).executeTakeFirst();
  if (!cat) throw Object.assign(new Error('还没有小猫'), { code: 'NO_CAT' });
  return cat;
}

const OWNER_MEMORY_PATH = 'owner-profile.md';

async function syncOwnerMemory(userId: string) {
  const cat = await catForUser(userId);
  const answers = await db.selectFrom('cat_onboarding_answers').select(['id', 'memory_digest'])
    .where('cat_id', '=', cat.id).where('answer_type', '!=', 'skipped').orderBy('created_at').execute();
  const replies = await db.selectFrom('postcard_responses').select(['id', 'memory_digest'])
    .where('cat_id', '=', cat.id).where('memory_digest', 'is not', null).orderBy('created_at', 'desc').limit(10).execute();
  if (!cat.qca_memstore_id || config.qcaMock) {
    await db.updateTable('cat_onboarding_answers').set({ sync_status: 'synced' }).where('cat_id', '=', cat.id).execute();
    await db.updateTable('postcard_responses').set({ memory_sync_status: 'synced' })
      .where('cat_id', '=', cat.id).where('memory_sync_status', '=', 'pending').execute();
    return;
  }
  const credential = await getPatForUser(userId);
  if (!credential) return;
  const lines = [...answers, ...replies].map((item) => `- ${item.memory_digest}`).filter((line) => line !== '- null');
  if (lines.length) {
    await upsertMemoryEntry(credential, cat.qca_memstore_id, OWNER_MEMORY_PATH,
      `# 主人与共同记忆\n\n${lines.join('\n')}\n\n> 由 Me&Me 同步；边界偏好高于其他叙事指令。\n`);
  } else {
    await deleteMemoryEntry(credential, cat.qca_memstore_id, OWNER_MEMORY_PATH);
  }
  await db.updateTable('cat_onboarding_answers').set({ sync_status: 'synced' }).where('cat_id', '=', cat.id).execute();
  await db.updateTable('postcard_responses').set({ memory_sync_status: 'synced' })
    .where('cat_id', '=', cat.id).where('memory_sync_status', '=', 'pending').execute();
}

async function syncOwnerMemoryBestEffort(userId: string) {
  try { await syncOwnerMemory(userId); } catch {
    const cat = await catForUser(userId);
    await db.updateTable('cat_onboarding_answers').set({ sync_status: 'failed' })
      .where('cat_id', '=', cat.id).where('sync_status', '=', 'pending').execute();
    await db.updateTable('postcard_responses').set({ memory_sync_status: 'failed' })
      .where('cat_id', '=', cat.id).where('memory_sync_status', '=', 'pending').execute();
  }
}

export async function listOnboardingAnswers(userId: string) {
  const cat = await catForUser(userId);
  return db.selectFrom('cat_onboarding_answers').selectAll().where('cat_id', '=', cat.id).orderBy('created_at').execute();
}

export async function saveOnboardingAnswers(userId: string, inputs: AnswerInput[]) {
  const cat = await catForUser(userId);
  if (!Array.isArray(inputs) || inputs.length > ONBOARDING_QUESTIONS.length) {
    throw Object.assign(new Error('互动答案格式不正确'), { code: 'INVALID_ANSWERS' });
  }
  const now = new Date().toISOString();
  for (const input of inputs.map(normalizeAnswer)) {
    await db.insertInto('cat_onboarding_answers').values({
      id: randomUUID(), cat_id: cat.id, question_id: input.question_id, answer_type: input.answer_type,
      choice_id: input.choice_id, answer_text: input.answer_text, memory_digest: input.memory_digest,
      sync_status: 'pending', created_at: now, updated_at: now,
    }).onConflict((oc) => oc.columns(['cat_id', 'question_id']).doUpdateSet({
      answer_type: input.answer_type, choice_id: input.choice_id, answer_text: input.answer_text,
      memory_digest: input.memory_digest, sync_status: 'pending', updated_at: now,
    })).execute();
  }
  await syncOwnerMemoryBestEffort(userId);
  return listOnboardingAnswers(userId);
}

export async function deleteOnboardingAnswer(userId: string, questionId: string) {
  const cat = await catForUser(userId);
  await db.deleteFrom('cat_onboarding_answers').where('cat_id', '=', cat.id).where('question_id', '=', questionId).execute();
  await syncOwnerMemoryBestEffort(userId);
  return { ok: true };
}

async function postcardForUser(userId: string, postcardId: string) {
  const row = await db.selectFrom('postcards as p').innerJoin('travels as t', 't.id', 'p.travel_id')
    .innerJoin('cats as c', 'c.id', 't.cat_id').select(['p.id', 't.cat_id']).where('p.id', '=', postcardId)
    .where('c.user_id', '=', userId).executeTakeFirst();
  if (!row) throw Object.assign(new Error('明信片不存在'), { code: 'NOT_FOUND' });
  return row;
}

export async function respondToPostcard(userId: string, postcardId: string, type: 'pat' | 'reply' | 'cherish', input: { choice_id?: string; content?: string } = {}) {
  const postcard = await postcardForUser(userId, postcardId);
  const content = input.content?.trim() || null;
  if (content && content.length > 200) throw Object.assign(new Error('回复最多 200 字'), { code: 'REPLY_TOO_LONG' });
  const now = new Date().toISOString();
  const digest = type === 'reply' ? `主人回复了明信片：${content || input.choice_id || '轻轻回应了我'}` : type === 'cherish' ? '主人珍藏了这封明信片' : null;
  await db.insertInto('postcard_responses').values({
    id: randomUUID(), postcard_id: postcardId, cat_id: postcard.cat_id, response_type: type,
    choice_id: input.choice_id || null, content, memory_digest: digest,
    memory_sync_status: digest ? 'pending' : 'not_needed', created_at: now, updated_at: now,
  }).onConflict((oc) => oc.columns(['postcard_id', 'response_type']).doUpdateSet({
    choice_id: input.choice_id || null, content, memory_digest: digest,
    memory_sync_status: digest ? 'pending' : 'not_needed', updated_at: now,
  })).execute();
  if (type === 'cherish') await db.updateTable('postcards').set({ cherished_at: now }).where('id', '=', postcardId).execute();
  if (digest) await syncOwnerMemoryBestEffort(userId);
  return { ok: true, response_type: type };
}

const STAGES = [
  ['observing', '还在小心观察你'], ['opening_up', '开始愿意分享心事'], ['home', '已经把这里当成家'],
  ['carrying_words', '总会带着你的话出门'], ['always_returns', '无论走多远都认得回家的路'],
] as const;

export async function getVisibleMemories(userId: string) {
  const cat = await catForUser(userId);
  const answers = await db.selectFrom('cat_onboarding_answers').select(['id', 'question_id', 'answer_text', 'choice_id', 'memory_digest', 'sync_status', 'updated_at'])
    .where('cat_id', '=', cat.id).where('answer_type', '!=', 'skipped').orderBy('updated_at', 'desc').limit(3).execute();
  return answers.map((answer) => ({ ...answer, source: 'onboarding' as const }));
}

export async function getBondState(userId: string) {
  const cat = await catForUser(userId);
  const [answerCount, responseCount, travelCount] = await Promise.all([
    db.selectFrom('cat_onboarding_answers').select(({ fn }) => fn.count<number>('id').as('count')).where('cat_id', '=', cat.id).where('answer_type', '!=', 'skipped').executeTakeFirstOrThrow(),
    db.selectFrom('postcard_responses').select(({ fn }) => fn.count<number>('id').as('count')).where('cat_id', '=', cat.id).executeTakeFirstOrThrow(),
    db.selectFrom('travels').select(({ fn }) => fn.count<number>('id').as('count')).where('cat_id', '=', cat.id).executeTakeFirstOrThrow(),
  ]);
  const score = Number(answerCount.count) + Number(responseCount.count) * 2 + Math.min(Number(travelCount.count), 7);
  const index = score >= 20 ? 4 : score >= 13 ? 3 : score >= 8 ? 2 : score >= 3 ? 1 : 0;
  const [stage, label] = STAGES[index];
  const reason = responseCount.count ? '因为你回应了它寄回来的消息' : answerCount.count ? '因为你认真告诉了它一些关于你的事' : '你们才刚刚开始认识彼此';
  const travels = Number(travelCount.count);
  const storyStep = travels === 0 ? 0 : ((travels - 1) % 7) + 1;
  const storyArcId = travels ? 'seven-day-homeward-stars' : null;
  const storyMessage = storyStep === 0 ? '第一次故事会从它出门后开始' : storyStep < 7
    ? `星光回家路 · 第 ${storyStep}/7 幕：它还藏着一件想带回家的小事`
    : '星光回家路已经写完，它把七天的见闻装进了回忆册';
  await db.insertInto('bond_state').values({ cat_id: cat.id, stage, score_internal: score, last_reason: reason, story_arc_id: storyArcId, story_step: storyStep, updated_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('cat_id').doUpdateSet({ stage, score_internal: score, last_reason: reason, story_arc_id: storyArcId, story_step: storyStep, updated_at: new Date().toISOString() })).execute();
  const unlocks = index === 0 ? ['会认真听你说话'] : index === 1 ? ['在信里用你喜欢的称呼', '偶尔主动分享心情']
    : index === 2 ? ['回家时更爱撒娇', '带回只属于你们的信物']
      : index === 3 ? ['旅行时带着你的话', '更常回应共同记忆'] : ['专属明信片落款', '远行后总会先向你报平安'];
  return { stage, label, reason, unlocks, story: { arc_id: storyArcId, step: storyStep, total: 7, message: storyMessage } };
}

export async function getGentleReturnMessage(userId: string) {
  const cat = await catForUser(userId);
  const last = await db.selectFrom('travels as t').leftJoin('world_locations as wl', 'wl.id', 't.location_id')
    .leftJoin('postcards as p', 'p.travel_id', 't.id').select(['t.travel_date', 'wl.name as location_name', 'p.question'])
    .where('t.cat_id', '=', cat.id).orderBy('t.travel_date', 'desc').executeTakeFirst();
  if (!last) return { message: `${cat.name}正在门边等第一次出发。你什么时候回来都没关系。`, unfinished: null };
  return { message: `${cat.name}看到你回来，先把爪子搭在你手边。它没有追问你去了哪里，只想继续讲完上次的故事。`, unfinished: last.question || `它还想和你聊聊在${last.location_name || '远方'}看到的事` };
}

export async function getWeeklyRecap(userId: string) {
  const cat = await catForUser(userId);
  const travels = await db.selectFrom('travels as t').leftJoin('postcards as p', 'p.travel_id', 't.id')
    .leftJoin('world_locations as wl', 'wl.id', 't.location_id')
    .select(['t.id', 't.travel_date', 't.mood', 't.narrative', 'wl.name as location_name', 'p.title'])
    .where('t.cat_id', '=', cat.id).orderBy('t.travel_date', 'desc').limit(7).execute();
  return {
    title: travels.length ? `${cat.name}的七日回忆册` : `${cat.name}还在等待第一次出门`,
    message: travels.length ? `这段时间它去了 ${new Set(travels.map((item) => item.location_name)).size} 个地方，最想把这些小事慢慢讲给你听。` : '等它第一次回来，这里会出现只属于你们的故事。',
    travels,
  };
}
