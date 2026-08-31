import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { db } from '../db/index.js';
import { getRepoRoot } from '../lib/templates.js';

type MapCoordinate = { x: number; y: number };

function isMapCoordinate(value: unknown): value is MapCoordinate {
  if (!value || typeof value !== 'object') return false;
  const coordinate = value as Partial<MapCoordinate>;
  return Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y)
    && coordinate.x! >= 0 && coordinate.x! <= 100
    && coordinate.y! >= 0 && coordinate.y! <= 100;
}

function attrBonusToGene(bonus: Record<string, number>): string | null {
  if (bonus.insight) return 'gene-evt-celestial';
  if (bonus.affinity) return 'gene-evt-gathering';
  if (bonus.curiosity) return 'gene-evt-discovery';
  if (bonus.courage) return 'gene-evt-challenge';
  return null;
}

export async function syncWorldFromRepo(): Promise<{ version: string; locations: number; events: number; chronicle: number }> {
  const root = getRepoRoot();
  const version = new Date().toISOString().slice(0, 10);
  const mapManifest = yaml.load(fs.readFileSync(path.join(root, 'world/atlas/map.yaml'), 'utf8')) as {
    basemap_version: string;
    regions: Array<{ id: string }>;
  };

  const locDir = path.join(root, 'world/atlas/locations');
  const locFiles = fs.readdirSync(locDir).filter((f) => f.endsWith('.md'));
  const locationGenes = yaml.load(fs.readFileSync(path.join(root, 'world/genes/locations.yaml'), 'utf8')) as Record<string, unknown>;
  const knownGenes = new Set<string>();
  for (const value of Object.values(locationGenes)) {
    if (Array.isArray(value)) for (const item of value) if (item && typeof item === 'object' && 'id' in item) knownGenes.add(String(item.id));
  }
  const regionIds = new Set(mapManifest.regions.map((region) => region.id));
  const parsedLocations = locFiles.map((file) => {
    const raw = fs.readFileSync(path.join(locDir, file), 'utf8');
    const parsed = matter(raw);
    const data = parsed.data as Record<string, any>;
    if (!data.id || file !== `${data.id}.md`) throw new Error(`图志文件名与 id 不一致: ${file}`);
    if (!regionIds.has(data.region_id)) throw new Error(`地点 ${data.id} 使用未知区域 ${data.region_id}`);
    if (!isMapCoordinate(data.map)) throw new Error(`地点 ${data.id} 世界地图坐标必须在 0~100`);
    if (!isMapCoordinate(data.region_map)) throw new Error(`地点 ${data.id} 区域图坐标必须在 0~100`);
    for (const gene of data.genes || []) if (!knownGenes.has(gene)) throw new Error(`地点 ${data.id} 使用未知基因 ${gene}`);
    return { file, data, content: parsed.content };
  });
  for (let i = 0; i < parsedLocations.length; i += 1) {
    for (let j = i + 1; j < parsedLocations.length; j += 1) {
      const a = parsedLocations[i].data;
      const b = parsedLocations[j].data;
      if (a.region_id !== b.region_id) continue;
      const distance = Math.hypot(a.region_map.x - b.region_map.x, a.region_map.y - b.region_map.y);
      if (distance < 6) throw new Error(`同区域地点区域图坐标过近: ${a.id} / ${b.id}`);
    }
  }
  const regionMapLocations = Object.fromEntries(parsedLocations
    .filter(({ data }) => data.status !== 'retired')
    .map(({ data }) => [data.id, data.region_map as MapCoordinate]));

  let eventCount = 0;
  const chronicleManifest = yaml.load(fs.readFileSync(path.join(root, 'world/history/chronicle.yaml'), 'utf8')) as {
    entries: Array<{
      id: string; date: string; title: string; summary: string; change_type: string; source_kind?: string;
      proposal_id?: string | null; contributor_cat_name?: string | null; history_file: string;
    }>;
  };
  const chronicleIds = new Set<string>();
  for (const entry of chronicleManifest.entries || []) {
    if (!entry.id || chronicleIds.has(entry.id)) throw new Error(`编年史 id 缺失或重复: ${entry.id || '(empty)'}`);
    chronicleIds.add(entry.id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`编年史日期格式错误: ${entry.id}`);
    if (!entry.history_file.startsWith('world/history/') || !entry.history_file.endsWith('.md') || !fs.existsSync(path.join(root, entry.history_file))) {
      throw new Error(`编年史详细记录不存在: ${entry.id}`);
    }
    if (entry.source_kind === 'proposal' && (!entry.proposal_id || !entry.contributor_cat_name)) {
      throw new Error(`玩家提案编年史缺少 proposal_id 或 contributor_cat_name: ${entry.id}`);
    }
  }

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom('world_events').execute();
    for (const { data, content } of parsedLocations) {
      if (data.status === 'retired') continue;

      const location = {
        id: data.id,
        name: data.name,
        description: content.trim(),
        mood_tags: JSON.stringify(data.mood_tags || []),
        min_attrs: JSON.stringify(data.min_attrs || {}),
        map_x: data.map?.x ?? 50,
        map_y: data.map?.y ?? 50,
        region_id: data.region_id || 'region-heartlands',
        map_priority: data.map?.priority ?? 50,
        status: data.status || 'active',
        synced_at: new Date().toISOString(),
      };
      await trx.insertInto('world_locations').values(location).onConflict((oc) => oc.column('id').doUpdateSet(location)).execute();

      for (const evt of data.events || []) {
        const bonus = evt.attr_bonus || {};
        const event = {
          id: evt.id,
          location_id: data.id,
          name: evt.name,
          description: evt.desc || evt.description || '',
          event_gene: attrBonusToGene(bonus),
          attr_bonus: JSON.stringify(bonus),
          synced_at: new Date().toISOString(),
        };
        await trx.insertInto('world_events').values(event).onConflict((oc) => oc.column('id').doUpdateSet(event)).execute();
        eventCount++;
      }
    }

    const itemsYaml = yaml.load(fs.readFileSync(path.join(root, 'world/genes/items.yaml'), 'utf8')) as {
      items: Array<{ id: string; name: string; kind?: string; slot: string; asset?: string; desc: string; drop: { event_gene: string; chance: number } }>;
    };
    for (const item of itemsYaml.items || []) {
      const row = {
        id: item.id,
        name: item.name,
        slot: item.slot,
        description: item.desc,
        drop_gene: item.drop?.event_gene,
        drop_chance: item.drop?.chance ?? 0,
        kind: item.kind || 'wearable',
        asset_key: item.asset || null,
        synced_at: new Date().toISOString(),
      };
      await trx.insertInto('world_items').values(row).onConflict((oc) => oc.column('id').doUpdateSet(row)).execute();
    }

    const badgesYaml = yaml.load(fs.readFileSync(path.join(root, 'world/genes/badges.yaml'), 'utf8')) as {
      badges: Array<{ id: string; name: string; desc: string; rule: string }>;
    };
    for (const b of badgesYaml.badges || []) {
      const row = { id: b.id, name: b.name, description: b.desc, rule: b.rule, synced_at: new Date().toISOString() };
      await trx.insertInto('world_badges').values(row).onConflict((oc) => oc.column('id').doUpdateSet(row)).execute();
    }
    for (const entry of chronicleManifest.entries || []) {
      const now = new Date().toISOString();
      const row = {
        id: entry.id, date: entry.date, title: entry.title, summary: entry.summary, change_type: entry.change_type,
        source_kind: entry.source_kind || 'seed', proposal_id: entry.proposal_id || null,
        contributor_cat_name: entry.contributor_cat_name || null, history_file: entry.history_file,
        status: 'published', revision: 1, published_at: now, updated_at: now,
      };
      await trx.insertInto('world_chronicle').values(row).onConflict((oc) => oc.column('id').doNothing()).execute();
      await trx.insertInto('world_chronicle_revisions').values({
        id: randomUUID(), chronicle_id: entry.id, revision: 1, snapshot: JSON.stringify(row),
        actor_name: 'repo-sync', change_note: '仓库种子同步',
      }).onConflict((oc) => oc.columns(['chronicle_id', 'revision']).doNothing()).execute();
    }

    await trx.insertInto('world_meta').values({ key: 'world_version', value: version })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: version })).execute();
    await trx.insertInto('world_meta').values({ key: 'map_manifest', value: JSON.stringify(mapManifest) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(mapManifest) })).execute();
    await trx.insertInto('world_meta').values({ key: 'region_map_locations', value: JSON.stringify(regionMapLocations) })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: JSON.stringify(regionMapLocations) })).execute();
  });

  return { version, locations: locFiles.length, events: eventCount, chronicle: chronicleManifest.entries?.length || 0 };
}

export function listWorldChronicle() {
  return db.selectFrom('world_chronicle').select([
    'id', 'date', 'title', 'summary', 'change_type', 'source_kind', 'proposal_id', 'contributor_cat_name', 'history_file',
  ]).where('status', '=', 'published').orderBy('date', 'desc').orderBy('published_at', 'desc').orderBy('id', 'desc').execute();
}

export async function getWorldVersion(): Promise<string> {
  const row = await db.selectFrom('world_meta').select('value').where('key', '=', 'world_version').executeTakeFirst();
  return row?.value || 'seed';
}
