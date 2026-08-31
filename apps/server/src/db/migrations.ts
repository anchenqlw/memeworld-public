import { sql, type Kysely } from 'kysely';
import type { DatabaseSchema } from './schema.js';

type Db = Kysely<DatabaseSchema>;
type DatabaseDialect = 'sqlite' | 'postgres';

const SERVER_ONLY_TABLES = {
  schema_migrations: true,
  users: true,
  pat_credentials: true,
  pat_replacement_requests: true,
  cat_archives: true,
  cats: true,
  travels: true,
  encounters: true,
  encounter_actions: true,
  encounter_receipts: true,
  cat_relationships: true,
  postcards: true,
  cat_onboarding_answers: true,
  postcard_responses: true,
  bond_state: true,
  cat_items: true,
  cat_badges: true,
  proposals: true,
  proposal_events: true,
  contribution_events: true,
  growth_cards: true,
  interactions: true,
  chat_messages: true,
  chat_turns: true,
  world_meta: true,
  world_locations: true,
  world_events: true,
  world_items: true,
  world_badges: true,
  world_chronicle: true,
  world_chronicle_revisions: true,
  cat_appearances: true,
  image_jobs: true,
  workflow_cursors: true,
  cat_task_reconciliations: true,
  task_reconcile_cursors: true,
  feedback_claims: true,
  feedback_archives: true,
  feedback_clusters: true,
  cluster_memberships: true,
  cluster_membership_events: true,
  evolution_work_items: true,
  evolution_jobs: true,
  evolution_resource_leases: true,
  evolution_job_events: true,
  owner_approvals: true,
  owner_approval_events: true,
  evolution_runtime_state: true,
  evolution_circuit: true,
  evolution_circuit_events: true,
  evolution_incidents: true,
  evolution_metric_samples: true,
} satisfies Record<keyof DatabaseSchema, true>;

async function enforcePostgresServerOnlyAccess(db: Db) {
  const tableNames = Object.keys(SERVER_ONLY_TABLES).map((name) => `'${name}'`).join(', ');
  await sql.raw(`
    DO $meme_rls$
    DECLARE
      table_name text;
      api_role text;
      runtime_exists boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meme_runtime');
    BEGIN
      FOREACH table_name IN ARRAY ARRAY[${tableNames}] LOOP
        IF to_regclass(format('public.%I', table_name)) IS NULL THEN
          CONTINUE;
        END IF;

        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);

        FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
          END IF;
        END LOOP;

        IF runtime_exists THEN
          IF table_name = 'schema_migrations' THEN
            EXECUTE format('REVOKE ALL ON TABLE public.%I FROM meme_runtime', table_name);
          ELSE
            EXECUTE format(
              'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO meme_runtime',
              table_name
            );
            EXECUTE format(
              'DROP POLICY IF EXISTS meme_runtime_server_access ON public.%I',
              table_name
            );
            EXECUTE format(
              'CREATE POLICY meme_runtime_server_access ON public.%I FOR ALL TO meme_runtime USING (true) WITH CHECK (true)',
              table_name
            );
          END IF;
        END IF;
      END LOOP;
    END
    $meme_rls$;
  `).execute(db);
}

async function hasColumn(db: Db, tableName: string, columnName: string) {
  const table = (await db.introspection.getTables()).find((item) => item.name === tableName);
  return table?.columns.some((column) => column.name === columnName) ?? false;
}

async function hasTable(db: Db, tableName: string) {
  return (await db.introspection.getTables()).some((item) => item.name === tableName);
}

async function ensureBondStateTable(db: Db) {
  if (await hasTable(db, 'bond_state')) return;
  await db.schema.createTable('bond_state')
    .addColumn('cat_id', 'text', (c) => c.primaryKey().references('cats.id').onDelete('cascade'))
    .addColumn('stage', 'text', (c) => c.notNull().defaultTo('observing'))
    .addColumn('score_internal', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('last_reason', 'text', (c) => c.notNull().defaultTo('刚刚开始认识彼此'))
    .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)).execute();
}

async function addColumn(
  db: Db,
  table: 'users' | 'cats' | 'cat_appearances' | 'image_jobs' | 'pat_credentials' | 'postcards',
  column: string
) {
  if (await hasColumn(db, table, column)) return;
  let builder = db.schema.alterTable(table);
  switch (column) {
    case 'provider':
      await builder.addColumn('provider', 'text', (col) => col.notNull().defaultTo('mock')).execute();
      break;
    case 'appearance_status':
      await builder.addColumn('appearance_status', 'text', (col) => col.notNull().defaultTo('pending')).execute();
      break;
    case 'lifecycle_stage':
      await builder.addColumn('lifecycle_stage', 'text', (col) => col.notNull().defaultTo('appearance')).execute();
      break;
    case 'travel_schedule_enabled':
      await builder.addColumn('travel_schedule_enabled', 'integer', (col) => col.notNull().defaultTo(0)).execute();
      break;
    case 'selection_status':
      await builder.addColumn('selection_status', 'text', (col) => col.notNull().defaultTo('candidate')).execute();
      break;
    case 'qca_site':
      await builder.addColumn('qca_site', 'text', (col) => col.notNull().defaultTo('global')).execute();
      break;
    case 'photo_status':
      await builder.addColumn('photo_status', 'text', (col) => col.notNull().defaultTo('pending')).execute();
      break;
    case 'qca_image_policy_version':
      await builder.addColumn('qca_image_policy_version', 'integer', (col) => col.notNull().defaultTo(0)).execute();
      break;
    default:
      await builder.addColumn(column as never, 'text').execute();
  }
}

const migrations: Array<(db: Db) => Promise<void>> = [
  async (db) => {
    const now = sql`CURRENT_TIMESTAMP`;
    await db.schema.createTable('users').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('provider', 'text', (c) => c.notNull().defaultTo('mock'))
      .addColumn('provider_user_id', 'text').addColumn('buc_id', 'text', (c) => c.unique())
      .addColumn('display_name', 'text', (c) => c.notNull()).addColumn('email', 'text').addColumn('avatar_url', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(now)).addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('pat_credentials').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().unique().references('users.id').onDelete('cascade'))
      .addColumn('encrypted_pat', 'text', (c) => c.notNull()).addColumn('pat_hint', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('valid')).addColumn('last_verified_at', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(now)).addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('cats').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().unique().references('users.id').onDelete('cascade'))
      .addColumn('name', 'text', (c) => c.notNull()).addColumn('personality', 'text', (c) => c.notNull())
      .addColumn('attr_courage', 'integer', (c) => c.notNull()).addColumn('attr_curiosity', 'integer', (c) => c.notNull())
      .addColumn('attr_affinity', 'integer', (c) => c.notNull()).addColumn('attr_insight', 'integer', (c) => c.notNull())
      .addColumn('qca_env_id', 'text').addColumn('qca_agent_id', 'text').addColumn('qca_memstore_id', 'text').addColumn('qca_deployment_id', 'text')
      .addColumn('qca_image_env_id', 'text').addColumn('qca_image_agent_id', 'text').addColumn('image_identity_anchor', 'text')
      .addColumn('cat_token_hash', 'text', (c) => c.notNull()).addColumn('appearance', 'text', (c) => c.notNull())
      .addColumn('outfit', 'text', (c) => c.notNull().defaultTo('{"head":null,"neck":null,"back":null}'))
      .addColumn('current_image_url', 'text').addColumn('appearance_status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('qca_chat_session_id', 'text').addColumn('meet_enabled', 'integer', (c) => c.notNull().defaultTo(1))
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('active')).addColumn('qca_health_cache', 'text')
      .addColumn('qca_health_checked_at', 'text').addColumn('created_at', 'text', (c) => c.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('travels').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('travel_date', 'text', (c) => c.notNull()).addColumn('location_id', 'text', (c) => c.notNull()).addColumn('event_id', 'text')
      .addColumn('narrative', 'text', (c) => c.notNull()).addColumn('mood', 'text').addColumn('attr_delta', 'text', (c) => c.notNull().defaultTo('{}'))
      .addColumn('memory_digest', 'text').addColumn('reported_at', 'text', (c) => c.notNull().defaultTo(now))
      .addUniqueConstraint('travels_cat_date_unique', ['cat_id', 'travel_date']).execute();
    await db.schema.createTable('postcards').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('travel_id', 'text', (c) => c.notNull().references('travels.id').onDelete('cascade'))
      .addColumn('title', 'text', (c) => c.notNull()).addColumn('content', 'text', (c) => c.notNull()).addColumn('image_url', 'text').execute();
    await db.schema.createTable('cat_items').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('item_id', 'text', (c) => c.notNull()).addColumn('acquired_at', 'text', (c) => c.notNull().defaultTo(now)).addColumn('source', 'text')
      .addUniqueConstraint('cat_items_cat_item_unique', ['cat_id', 'item_id']).execute();
    await db.schema.createTable('cat_badges').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('badge_id', 'text', (c) => c.notNull()).addColumn('earned_at', 'text', (c) => c.notNull().defaultTo(now)).addColumn('reason', 'text')
      .addUniqueConstraint('cat_badges_cat_badge_unique', ['cat_id', 'badge_id']).execute();
    await db.schema.createTable('proposals').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('type', 'text', (c) => c.notNull()).addColumn('content', 'text', (c) => c.notNull()).addColumn('status', 'text', (c) => c.notNull().defaultTo('new'))
      .addColumn('backlog_ref', 'text').addColumn('created_at', 'text', (c) => c.notNull().defaultTo(now)).addColumn('exported_at', 'text').execute();
    await db.schema.createTable('interactions').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('channel', 'text', (c) => c.notNull().defaultTo('web')).addColumn('qca_session_id', 'text')
      .addColumn('turns', 'integer', (c) => c.notNull().defaultTo(0)).addColumn('date', 'text', (c) => c.notNull())
      .addUniqueConstraint('interactions_cat_date_channel_unique', ['cat_id', 'date', 'channel']).execute();
    await db.schema.createTable('world_meta').ifNotExists().addColumn('key', 'text', (c) => c.primaryKey()).addColumn('value', 'text', (c) => c.notNull()).execute();
    await db.schema.createTable('world_locations').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('name', 'text', (c) => c.notNull()).addColumn('description', 'text', (c) => c.notNull())
      .addColumn('mood_tags', 'text', (c) => c.notNull()).addColumn('min_attrs', 'text', (c) => c.notNull().defaultTo('{}'))
      .addColumn('map_x', 'real', (c) => c.notNull()).addColumn('map_y', 'real', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('active')).addColumn('synced_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('world_events').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('location_id', 'text', (c) => c.notNull().references('world_locations.id'))
      .addColumn('name', 'text', (c) => c.notNull()).addColumn('description', 'text', (c) => c.notNull()).addColumn('event_gene', 'text')
      .addColumn('attr_bonus', 'text', (c) => c.notNull().defaultTo('{}')).addColumn('synced_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('world_items').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('name', 'text', (c) => c.notNull()).addColumn('slot', 'text', (c) => c.notNull())
      .addColumn('description', 'text', (c) => c.notNull()).addColumn('drop_gene', 'text').addColumn('drop_chance', 'real', (c) => c.notNull().defaultTo(0))
      .addColumn('synced_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('world_badges').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('name', 'text', (c) => c.notNull()).addColumn('description', 'text', (c) => c.notNull())
      .addColumn('rule', 'text', (c) => c.notNull()).addColumn('synced_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
    await db.schema.createTable('cat_appearances').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('kind', 'text', (c) => c.notNull()).addColumn('image_url', 'text', (c) => c.notNull()).addColumn('local_path', 'text', (c) => c.notNull())
      .addColumn('prompt', 'text', (c) => c.notNull()).addColumn('travel_id', 'text').addColumn('created_at', 'text', (c) => c.notNull().defaultTo(now)).execute();
  },
  async (db) => {
    for (const column of ['current_image_url', 'qca_image_env_id', 'qca_image_agent_id', 'image_identity_anchor']) await addColumn(db, 'cats', column);
    await addColumn(db, 'cats', 'appearance_status');
  },
  async (db) => {
    for (const column of ['provider_user_id', 'avatar_url']) await addColumn(db, 'users', column);
    await addColumn(db, 'users', 'provider');
    await sql`UPDATE users SET provider_user_id = buc_id WHERE provider_user_id IS NULL AND buc_id IS NOT NULL`.execute(db);
  },
  async (db) => {
    await db.schema.createIndex('idx_users_provider_identity').ifNotExists().on('users').columns(['provider', 'provider_user_id']).unique().execute();
    await db.schema.createIndex('idx_cat_appearances_cat').ifNotExists().on('cat_appearances').column('cat_id').execute();
    await db.schema.createIndex('idx_travels_cat').ifNotExists().on('travels').column('cat_id').execute();
    await db.schema.createIndex('idx_travels_location').ifNotExists().on('travels').column('location_id').execute();
    await db.schema.createIndex('idx_proposals_user').ifNotExists().on('proposals').column('user_id').execute();
    await db.schema.createIndex('idx_proposals_created').ifNotExists().on('proposals').column('created_at').execute();
  },
  async (db) => {
    if (!(await hasColumn(db, 'cat_appearances', 'object_key'))) {
      await db.schema.alterTable('cat_appearances').addColumn('object_key', 'text').execute();
      await sql`UPDATE cat_appearances SET object_key = local_path WHERE object_key IS NULL`.execute(db);
    }
    await db.schema.createTable('image_jobs').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('dedupe_key', 'text', (c) => c.notNull().unique())
      .addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('kind', 'text', (c) => c.notNull())
      .addColumn('travel_id', 'text', (c) => c.references('travels.id').onDelete('cascade'))
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('available_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('started_at', 'text')
      .addColumn('finished_at', 'text')
      .addColumn('last_error', 'text')
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createIndex('idx_image_jobs_available').ifNotExists().on('image_jobs')
      .columns(['status', 'available_at']).execute();
    await db.schema.createIndex('idx_image_jobs_cat').ifNotExists().on('image_jobs').column('cat_id').execute();
  },
  async (db) => {
    await addColumn(db, 'cats', 'qca_model');
  },
  async (db) => {
    for (const column of ['lifecycle_stage', 'selected_birth_appearance_id', 'appearance_confirmed_at', 'adventure_started_at', 'travel_schedule_enabled']) {
      await addColumn(db, 'cats', column);
    }
    await addColumn(db, 'cat_appearances', 'selection_status');
    await addColumn(db, 'image_jobs', 'appearance_id');
    await sql`
      UPDATE cats
      SET selected_birth_appearance_id = (
        SELECT id FROM cat_appearances
        WHERE cat_appearances.cat_id = cats.id AND kind = 'birth'
        ORDER BY created_at DESC LIMIT 1
      )
      WHERE selected_birth_appearance_id IS NULL
    `.execute(db);
    await sql`
      UPDATE cats
      SET lifecycle_stage = CASE WHEN selected_birth_appearance_id IS NULL THEN 'appearance' ELSE 'world' END,
          appearance_confirmed_at = CASE
            WHEN selected_birth_appearance_id IS NULL THEN NULL
            ELSE COALESCE(appearance_confirmed_at, created_at)
          END,
          adventure_started_at = NULL,
          travel_schedule_enabled = 0
    `.execute(db);
    await sql`
      UPDATE cat_appearances
      SET selection_status = CASE
        WHEN id IN (SELECT selected_birth_appearance_id FROM cats WHERE selected_birth_appearance_id IS NOT NULL)
          THEN 'selected'
        ELSE 'candidate'
      END
    `.execute(db);
  },
  async (db) => {
    await addColumn(db, 'pat_credentials', 'qca_site');
    await db.schema.createTable('pat_replacement_requests').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('user_id', 'text', (c) => c.notNull().unique().references('users.id').onDelete('cascade'))
      .addColumn('encrypted_new_pat', 'text', (c) => c.notNull())
      .addColumn('pat_hint', 'text', (c) => c.notNull())
      .addColumn('qca_site', 'text', (c) => c.notNull())
      .addColumn('classification', 'text', (c) => c.notNull())
      .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('expires_at', 'text', (c) => c.notNull())
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createTable('cat_archives').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('source_cat_id', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('snapshot', 'text', (c) => c.notNull())
      .addColumn('reason', 'text', (c) => c.notNull())
      .addColumn('orphan_risk', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createIndex('idx_cat_archives_user_created').ifNotExists().on('cat_archives')
      .columns(['user_id', 'created_at']).execute();
  },
  async (db) => {
    await addColumn(db, 'cats', 'qca_travel_session_id');
    await addColumn(db, 'cats', 'qca_travel_session_token_hash');
    await addColumn(db, 'cats', 'last_travel_dispatched_on');
  },
  async (db) => {
    // 兼容曾在本地应用过早期 schema v9（当时仅含两个 Session 字段）的数据库。
    await addColumn(db, 'cats', 'last_travel_dispatched_on');
  },
  async (db) => {
    for (const column of [
      'qca_forward_travel_template_id',
      'qca_forward_identity_id',
      'qca_forward_schedule_id',
      'qca_forward_travel_session_id',
      'qca_forward_travel_session_token_hash',
      'qca_forward_chat_template_id',
      'qca_forward_im_channel_id',
    ]) {
      await addColumn(db, 'cats', column);
    }
  },
  async (db) => {
    for (const column of ['question', 'photo_object_key', 'photo_status', 'photo_prompt', 'cherished_at']) {
      await addColumn(db, 'postcards', column);
    }
    await sql`UPDATE postcards SET photo_status = CASE WHEN image_url IS NULL THEN 'pending' ELSE 'ready' END WHERE photo_status IS NULL`.execute(db);
    await db.schema.createTable('cat_onboarding_answers').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('question_id', 'text', (c) => c.notNull())
      .addColumn('answer_type', 'text', (c) => c.notNull())
      .addColumn('choice_id', 'text')
      .addColumn('answer_text', 'text')
      .addColumn('memory_digest', 'text')
      .addColumn('sync_status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('cat_onboarding_answers_unique', ['cat_id', 'question_id']).execute();
    await db.schema.createTable('postcard_responses').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('postcard_id', 'text', (c) => c.notNull().references('postcards.id').onDelete('cascade'))
      .addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('response_type', 'text', (c) => c.notNull())
      .addColumn('choice_id', 'text').addColumn('content', 'text').addColumn('memory_digest', 'text')
      .addColumn('memory_sync_status', 'text', (c) => c.notNull().defaultTo('not_needed'))
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('postcard_responses_unique', ['postcard_id', 'response_type']).execute();
  },
  async (db) => {
    await ensureBondStateTable(db);
  },
  async (db) => {
    await ensureBondStateTable(db);
    if (!(await hasColumn(db, 'bond_state', 'story_arc_id'))) await db.schema.alterTable('bond_state').addColumn('story_arc_id', 'text').execute();
    if (!(await hasColumn(db, 'bond_state', 'story_step'))) await db.schema.alterTable('bond_state').addColumn('story_step', 'integer', (c) => c.notNull().defaultTo(0)).execute();
  },
  async (db) => {
    if (!(await hasColumn(db, 'travels', 'memory_reference'))) await db.schema.alterTable('travels').addColumn('memory_reference', 'text').execute();
  },
  async (db) => {
    if (!(await hasColumn(db, 'travels', 'encounter_summary'))) await db.schema.alterTable('travels').addColumn('encounter_summary', 'text').execute();
  },
  async (db) => {
    // 修复历史分支曾占用相同整数版本导致 Phase 1.5 migration 被跳过的数据库。
    for (const column of ['question', 'photo_object_key', 'photo_status', 'photo_prompt', 'cherished_at']) await addColumn(db, 'postcards', column);
    await db.schema.createTable('cat_onboarding_answers').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('question_id', 'text', (c) => c.notNull()).addColumn('answer_type', 'text', (c) => c.notNull())
      .addColumn('choice_id', 'text').addColumn('answer_text', 'text').addColumn('memory_digest', 'text')
      .addColumn('sync_status', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('cat_onboarding_answers_unique', ['cat_id', 'question_id']).execute();
    await db.schema.createTable('postcard_responses').ifNotExists()
      .addColumn('id', 'text', (c) => c.primaryKey()).addColumn('postcard_id', 'text', (c) => c.notNull().references('postcards.id').onDelete('cascade'))
      .addColumn('cat_id', 'text', (c) => c.notNull().references('cats.id').onDelete('cascade')).addColumn('response_type', 'text', (c) => c.notNull())
      .addColumn('choice_id', 'text').addColumn('content', 'text').addColumn('memory_digest', 'text')
      .addColumn('memory_sync_status', 'text', (c) => c.notNull().defaultTo('not_needed'))
      .addColumn('created_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('postcard_responses_unique', ['postcard_id', 'response_type']).execute();
    await ensureBondStateTable(db);
    if (!(await hasColumn(db, 'bond_state', 'story_arc_id'))) await db.schema.alterTable('bond_state').addColumn('story_arc_id', 'text').execute();
    if (!(await hasColumn(db, 'bond_state', 'story_step'))) await db.schema.alterTable('bond_state').addColumn('story_step', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    if (!(await hasColumn(db, 'travels', 'memory_reference'))) await db.schema.alterTable('travels').addColumn('memory_reference', 'text').execute();
    if (!(await hasColumn(db, 'travels', 'encounter_summary'))) await db.schema.alterTable('travels').addColumn('encounter_summary', 'text').execute();
  },
  async (db) => {
    if (!(await hasColumn(db, 'proposals', 'context'))) await db.schema.alterTable('proposals').addColumn('context', 'text').execute();
  },
  async (db) => {
    await addColumn(db, 'cats', 'qca_image_policy_version');
  },
  async (db) => {
    await addColumn(db, 'image_jobs', 'qca_session_id');
    await addColumn(db, 'image_jobs', 'cancel_requested_at');
  },
  async (db) => {
    for (const column of ['decision_note', 'public_note', 'accepted_at', 'shipped_at']) {
      if (!(await hasColumn(db, 'proposals', column))) {
        await db.schema.alterTable('proposals').addColumn(column as never, 'text').execute();
      }
    }
    if (!(await hasColumn(db, 'proposals', 'contribution_points'))) {
      await db.schema.alterTable('proposals').addColumn('contribution_points', 'integer', (col) => col.notNull().defaultTo(0)).execute();
    }
    if (!(await hasColumn(db, 'proposals', 'reward_status'))) {
      await db.schema.alterTable('proposals').addColumn('reward_status', 'text', (col) => col.notNull().defaultTo('none')).execute();
    }
    await db.schema.createTable('contribution_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('proposal_id', 'text', (col) => col.notNull().references('proposals.id').onDelete('cascade'))
      .addColumn('event_type', 'text', (col) => col.notNull())
      .addColumn('points', 'integer', (col) => col.notNull())
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('contribution_events_proposal_type_unique', ['proposal_id', 'event_type'])
      .execute();
    await db.schema.createIndex('idx_contribution_events_user').ifNotExists().on('contribution_events')
      .columns(['user_id', 'created_at']).execute();
  },
  async (db) => {
    await db.schema.createTable('growth_cards').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('user_id', 'text', (col) => col.notNull().references('users.id').onDelete('cascade'))
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('type', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('source_url', 'text')
      .addColumn('tags', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('visibility', 'text', (col) => col.notNull().defaultTo('private'))
      .addColumn('sync_status', 'text', (col) => col.notNull().defaultTo('pending'))
      .addColumn('sync_error', 'text')
      .addColumn('deleted_at', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createIndex('idx_growth_cards_user_active').ifNotExists().on('growth_cards')
      .columns(['user_id', 'deleted_at', 'updated_at']).execute();
    await db.schema.createIndex('idx_growth_cards_cat').ifNotExists().on('growth_cards')
      .column('cat_id').execute();
  },
  async (db) => {
    if (!(await hasColumn(db, 'world_items', 'kind'))) {
      await db.schema.alterTable('world_items').addColumn('kind', 'text', (col) => col.notNull().defaultTo('wearable')).execute();
    }
    if (!(await hasColumn(db, 'world_items', 'asset_key'))) {
      await db.schema.alterTable('world_items').addColumn('asset_key', 'text').execute();
    }
    if (!(await hasColumn(db, 'world_locations', 'region_id'))) {
      await db.schema.alterTable('world_locations').addColumn('region_id', 'text', (col) => col.notNull().defaultTo('region-heartlands')).execute();
    }
    if (!(await hasColumn(db, 'world_locations', 'map_priority'))) {
      await db.schema.alterTable('world_locations').addColumn('map_priority', 'integer', (col) => col.notNull().defaultTo(50)).execute();
    }
  },
  async (db) => {
    if (!(await hasColumn(db, 'proposals', 'reporter_display_name'))) {
      await db.schema.alterTable('proposals').addColumn('reporter_display_name', 'text', (col) => col.notNull().defaultTo('历史反馈者')).execute();
    }
    if (!(await hasColumn(db, 'proposals', 'reporter_cat_name'))) {
      await db.schema.alterTable('proposals').addColumn('reporter_cat_name', 'text').execute();
    }
    await sql`UPDATE proposals SET reporter_display_name = COALESCE((SELECT display_name FROM users WHERE users.id = proposals.user_id), '历史反馈者') WHERE reporter_display_name = '历史反馈者'`.execute(db);
    await sql`UPDATE proposals SET reporter_cat_name = (SELECT name FROM cats WHERE cats.user_id = proposals.user_id AND cats.status = 'active' ORDER BY cats.created_at DESC LIMIT 1) WHERE reporter_cat_name IS NULL`.execute(db);
    await db.schema.createTable('proposal_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('proposal_id', 'text', (col) => col.notNull().references('proposals.id').onDelete('cascade'))
      .addColumn('actor_type', 'text', (col) => col.notNull())
      .addColumn('actor_name', 'text', (col) => col.notNull())
      .addColumn('from_status', 'text')
      .addColumn('to_status', 'text', (col) => col.notNull())
      .addColumn('public_note', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('proposal_events_proposal_status_unique', ['proposal_id', 'to_status'])
      .execute();
    await db.schema.createIndex('idx_proposal_events_proposal_created').ifNotExists().on('proposal_events')
      .columns(['proposal_id', 'created_at']).execute();
    await sql`INSERT INTO proposal_events (id, proposal_id, actor_type, actor_name, from_status, to_status, public_note, created_at)
      SELECT 'pe_migrated_' || id, id, 'creator', '皮卡', NULL, status,
      COALESCE(public_note, '这是一封迁移进新时间线的历史反馈。'), created_at FROM proposals
      WHERE NOT EXISTS (SELECT 1 FROM proposal_events pe WHERE pe.proposal_id = proposals.id)`.execute(db);

    await db.schema.createTable('world_chronicle').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('date', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('change_type', 'text', (col) => col.notNull())
      .addColumn('source_kind', 'text', (col) => col.notNull().defaultTo('seed'))
      .addColumn('proposal_id', 'text')
      .addColumn('contributor_cat_name', 'text')
      .addColumn('history_file', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createIndex('idx_world_chronicle_date').ifNotExists().on('world_chronicle').column('date').execute();
  },
  async (db) => {
    await addColumn(db, 'postcards', 'home_messages');
  },
  async (db) => {
    await db.schema.createTable('chat_messages').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('qca_session_id', 'text')
      .addColumn('source_event_id', 'text', (col) => col.unique())
      .addColumn('role', 'text', (col) => col.notNull())
      .addColumn('content', 'text', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await db.schema.createIndex('idx_chat_messages_cat_created').ifNotExists().on('chat_messages')
      .columns(['cat_id', 'created_at']).execute();
  },
  // v27：实际 RLS/权限收敛在版本写入后执行。若收敛失败，部署会失败；重试时仍会再次执行。
  async () => undefined,
  // v28：保留给曾在 staging 执行的长期记忆迁移，避免不同分支复用同一整数版本。
  async () => undefined,
  // v29：匿名猫遇的服务端事实、双边回执与可重建关系投影。
  async (db) => {
    const now = sql`CURRENT_TIMESTAMP`;
    await db.schema.createTable('encounters').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('match_key', 'text', (col) => col.notNull().unique())
      .addColumn('encounter_date', 'text', (col) => col.notNull())
      .addColumn('location_id', 'text', (col) => col.notNull().references('world_locations.id'))
      .addColumn('kind', 'text', (col) => col.notNull().defaultTo('anonymous_passing'))
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('settled'))
      .addColumn('photo_status', 'text', (col) => col.notNull().defaultTo('pending'))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('encounter_actions').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('encounter_id', 'text', (col) => col.notNull().references('encounters.id').onDelete('cascade'))
      .addColumn('actor_cat_id', 'text', (col) => col.references('cats.id').onDelete('set null'))
      .addColumn('action_type', 'text', (col) => col.notNull())
      .addColumn('payload', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('encounter_receipts').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('encounter_id', 'text', (col) => col.notNull().references('encounters.id').onDelete('cascade'))
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('travel_id', 'text', (col) => col.notNull().references('travels.id').onDelete('cascade'))
      .addColumn('encounter_date', 'text', (col) => col.notNull())
      .addColumn('perspective', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('photo_appearance_id', 'text', (col) => col.references('cat_appearances.id').onDelete('set null'))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addUniqueConstraint('encounter_receipts_encounter_cat_unique', ['encounter_id', 'cat_id'])
      .addUniqueConstraint('encounter_receipts_cat_date_unique', ['cat_id', 'encounter_date']).execute();
    await db.schema.createTable('cat_relationships').ifNotExists()
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('other_cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('encounter_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('last_encounter_id', 'text', (col) => col.notNull().references('encounters.id').onDelete('cascade'))
      .addColumn('last_encounter_date', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('stranger'))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addPrimaryKeyConstraint('cat_relationships_pair_pk', ['cat_id', 'other_cat_id']).execute();
    await db.schema.createIndex('idx_encounters_date_location').ifNotExists().on('encounters')
      .columns(['encounter_date', 'location_id']).execute();
    await db.schema.createIndex('idx_encounter_actions_encounter').ifNotExists().on('encounter_actions')
      .columns(['encounter_id', 'created_at']).execute();
    await db.schema.createIndex('idx_encounter_receipts_cat').ifNotExists().on('encounter_receipts')
      .columns(['cat_id', 'encounter_date']).execute();
  },
  // v30：编年史改为可通过受保护接口独立发布，并保留不可变修订账本。
  async (db) => {
    if (!(await hasColumn(db, 'world_chronicle', 'status'))) {
      await db.schema.alterTable('world_chronicle').addColumn('status', 'text', (col) => col.notNull().defaultTo('published')).execute();
    }
    if (!(await hasColumn(db, 'world_chronicle', 'revision'))) {
      await db.schema.alterTable('world_chronicle').addColumn('revision', 'integer', (col) => col.notNull().defaultTo(1)).execute();
    }
    if (!(await hasColumn(db, 'world_chronicle', 'published_at'))) {
      await db.schema.alterTable('world_chronicle').addColumn('published_at', 'text').execute();
    }
    if (!(await hasColumn(db, 'world_chronicle', 'updated_at'))) {
      await db.schema.alterTable('world_chronicle').addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)).execute();
    }
    await sql`UPDATE world_chronicle SET published_at = COALESCE(published_at, created_at), updated_at = COALESCE(updated_at, created_at) WHERE status = 'published'`.execute(db);
    await db.schema.createTable('world_chronicle_revisions').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('chronicle_id', 'text', (col) => col.notNull().references('world_chronicle.id').onDelete('cascade'))
      .addColumn('revision', 'integer', (col) => col.notNull())
      .addColumn('snapshot', 'text', (col) => col.notNull())
      .addColumn('actor_name', 'text', (col) => col.notNull())
      .addColumn('change_note', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .addUniqueConstraint('world_chronicle_revision_unique', ['chronicle_id', 'revision'])
      .execute();
    await db.schema.createIndex('idx_world_chronicle_status_date').ifNotExists().on('world_chronicle')
      .columns(['status', 'date']).execute();
  },
  // v31：proposal_events 改为真正的 append-only 事件流，移除“每状态唯一”限制。
  async (db) => {
    // 旧的自进化分支曾在 schema v28 提前部署过同一份 append-only 结构。
    // 以能力而不是整数版本判断，避免再次重建时抹掉 event_kind、visibility 和 evidence_ref。
    if (await hasColumn(db, 'proposal_events', 'event_kind')) {
      await db.schema.createIndex('idx_proposal_events_proposal_created').ifNotExists().on('proposal_events')
        .columns(['proposal_id', 'created_at']).execute();
      await db.schema.createIndex('idx_proposal_events_kind').ifNotExists().on('proposal_events')
        .columns(['event_kind', 'created_at']).execute();
      return;
    }
    await db.schema.createTable('proposal_events_v2').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('proposal_id', 'text', (col) => col.notNull().references('proposals.id').onDelete('cascade'))
      .addColumn('actor_type', 'text', (col) => col.notNull())
      .addColumn('actor_name', 'text', (col) => col.notNull())
      .addColumn('from_status', 'text')
      .addColumn('to_status', 'text', (col) => col.notNull())
      .addColumn('event_kind', 'text', (col) => col.notNull().defaultTo('status-changed'))
      .addColumn('idempotency_key', 'text', (col) => col.unique())
      .addColumn('visibility', 'text', (col) => col.notNull().defaultTo('public'))
      .addColumn('evidence_ref', 'text')
      .addColumn('public_note', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`))
      .execute();
    await sql`INSERT INTO proposal_events_v2
      (id, proposal_id, actor_type, actor_name, from_status, to_status, event_kind, idempotency_key, visibility, evidence_ref, public_note, created_at)
      SELECT id, proposal_id, actor_type, actor_name, from_status, to_status, to_status, 'legacy:' || id, 'public', NULL, public_note, created_at
      FROM proposal_events`.execute(db);
    await db.schema.dropTable('proposal_events').execute();
    await db.schema.alterTable('proposal_events_v2').renameTo('proposal_events').execute();
    await db.schema.createIndex('idx_proposal_events_proposal_created').ifNotExists().on('proposal_events')
      .columns(['proposal_id', 'created_at']).execute();
    await db.schema.createIndex('idx_proposal_events_kind').ifNotExists().on('proposal_events')
      .columns(['event_kind', 'created_at']).execute();
  },
  // v32：确定性自进化控制面。高频 claim/lease/fencing 状态只存数据库，仓库保留长期证据。
  async (db) => {
    const now = sql`CURRENT_TIMESTAMP`;
    await db.schema.createTable('workflow_cursors').ifNotExists()
      .addColumn('id', 'text', (col) => col.notNull())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('cursor_value', 'text', (col) => col.notNull())
      .addColumn('archive_commit_sha', 'text')
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addPrimaryKeyConstraint('workflow_cursors_pk', ['id', 'environment']).execute();
    await db.schema.createTable('feedback_claims').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('lease_owner', 'text', (col) => col.notNull())
      .addColumn('proposal_ids', 'text', (col) => col.notNull())
      .addColumn('cursor_from', 'text', (col) => col.notNull())
      .addColumn('cursor_to', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('leased'))
      .addColumn('expires_at', 'text', (col) => col.notNull())
      .addColumn('lease_epoch', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(3))
      .addColumn('heartbeat_at', 'text')
      .addColumn('error_code', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    for (const [column, definition] of [
      ['lease_epoch', () => db.schema.alterTable('feedback_claims').addColumn('lease_epoch', 'integer', (col) => col.notNull().defaultTo(1)).execute()],
      ['attempts', () => db.schema.alterTable('feedback_claims').addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(1)).execute()],
      ['max_attempts', () => db.schema.alterTable('feedback_claims').addColumn('max_attempts', 'integer', (col) => col.notNull().defaultTo(3)).execute()],
      ['heartbeat_at', () => db.schema.alterTable('feedback_claims').addColumn('heartbeat_at', 'text').execute()],
      ['error_code', () => db.schema.alterTable('feedback_claims').addColumn('error_code', 'text').execute()],
    ] as const) {
      if (!(await hasColumn(db, 'feedback_claims', column))) await definition();
    }
    await db.schema.createIndex('idx_feedback_claims_environment').ifNotExists().on('feedback_claims')
      .columns(['environment', 'status', 'expires_at']).execute();
    await db.schema.createTable('feedback_archives').ifNotExists()
      .addColumn('proposal_id', 'text', (col) => col.primaryKey().references('proposals.id').onDelete('cascade'))
      .addColumn('claim_id', 'text', (col) => col.notNull().references('feedback_claims.id'))
      .addColumn('event_id', 'text', (col) => col.notNull().unique())
      .addColumn('archive_commit_sha', 'text', (col) => col.notNull())
      .addColumn('idempotency_key', 'text', (col) => col.notNull().unique())
      .addColumn('sanitized_ref', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('sanitized_sha256', 'text', (col) => col.notNull().defaultTo(''))
      .addColumn('archived_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    if (!(await hasColumn(db, 'feedback_archives', 'sanitized_ref'))) {
      await db.schema.alterTable('feedback_archives').addColumn('sanitized_ref', 'text', (col) => col.notNull().defaultTo('')).execute();
    }
    if (!(await hasColumn(db, 'feedback_archives', 'sanitized_sha256'))) {
      await db.schema.alterTable('feedback_archives').addColumn('sanitized_sha256', 'text', (col) => col.notNull().defaultTo('')).execute();
    }

    await db.schema.createTable('feedback_clusters').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('fingerprint', 'text', (col) => col.notNull())
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('classification', 'text', (col) => col.notNull())
      .addColumn('confidence', 'real', (col) => col.notNull())
      .addColumn('policy_version', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('candidate'))
      .addColumn('sample_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addUniqueConstraint('feedback_clusters_environment_fingerprint_unique', ['environment', 'fingerprint']).execute();
    await db.schema.createTable('cluster_memberships').ifNotExists()
      .addColumn('cluster_id', 'text', (col) => col.notNull().references('feedback_clusters.id').onDelete('cascade'))
      .addColumn('proposal_id', 'text', (col) => col.notNull().references('proposals.id').onDelete('cascade'))
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('confidence', 'real', (col) => col.notNull())
      .addColumn('algorithm_version', 'text', (col) => col.notNull())
      .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addPrimaryKeyConstraint('cluster_memberships_pk', ['cluster_id', 'proposal_id']).execute();
    await db.schema.createTable('evolution_work_items').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('backlog_ref', 'text', (col) => col.notNull())
      .addColumn('cluster_id', 'text', (col) => col.references('feedback_clusters.id').onDelete('set null'))
      .addColumn('title', 'text', (col) => col.notNull())
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('risk_level', 'text', (col) => col.notNull())
      .addColumn('allowed_paths', 'text', (col) => col.notNull())
      .addColumn('lock_domains', 'text', (col) => col.notNull())
      .addColumn('acceptance', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('candidate'))
      .addColumn('authorization_source', 'text')
      .addColumn('policy_version', 'text')
      .addColumn('implementation_job_id', 'text')
      .addColumn('branch_name', 'text')
      .addColumn('draft_pr_number', 'integer')
      .addColumn('draft_pr_url', 'text')
      .addColumn('head_sha', 'text')
      .addColumn('version', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addUniqueConstraint('evolution_work_items_environment_backlog_unique', ['environment', 'backlog_ref']).execute();

    await db.schema.createTable('evolution_jobs').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('task_id', 'text', (col) => col.notNull())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('input_hash', 'text', (col) => col.notNull())
      .addColumn('payload', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('queued'))
      .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(100))
      .addColumn('attempts', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('max_attempts', 'integer', (col) => col.notNull())
      .addColumn('budget_limit', 'integer', (col) => col.notNull().defaultTo(100000))
      .addColumn('budget_used', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('lease_owner', 'text')
      .addColumn('lease_epoch', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('lease_expires_at', 'text')
      .addColumn('heartbeat_at', 'text')
      .addColumn('lock_domains', 'text', (col) => col.notNull().defaultTo('[]'))
      .addColumn('idempotency_key', 'text', (col) => col.notNull().unique())
      .addColumn('approval_action', 'text')
      .addColumn('approval_subject', 'text')
      .addColumn('approval_scope_hash', 'text')
      .addColumn('result', 'text')
      .addColumn('error_code', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    // 旧自进化分支曾以 v29 建过本表；v32 必须前向补列，不能依赖 CREATE IF NOT EXISTS。
    if (!(await hasColumn(db, 'evolution_jobs', 'lease_epoch'))) {
      await db.schema.alterTable('evolution_jobs').addColumn('lease_epoch', 'integer', (col) => col.notNull().defaultTo(0)).execute();
    }
    if (!(await hasColumn(db, 'evolution_jobs', 'lock_domains'))) {
      await db.schema.alterTable('evolution_jobs').addColumn('lock_domains', 'text', (col) => col.notNull().defaultTo('[]')).execute();
    }
    if (!(await hasColumn(db, 'evolution_jobs', 'approval_scope_hash'))) {
      await db.schema.alterTable('evolution_jobs').addColumn('approval_scope_hash', 'text').execute();
    }
    if (!(await hasColumn(db, 'evolution_jobs', 'budget_limit'))) {
      await db.schema.alterTable('evolution_jobs').addColumn('budget_limit', 'integer', (col) => col.notNull().defaultTo(100000)).execute();
    }
    if (!(await hasColumn(db, 'evolution_jobs', 'budget_used'))) {
      await db.schema.alterTable('evolution_jobs').addColumn('budget_used', 'integer', (col) => col.notNull().defaultTo(0)).execute();
    }
    await db.schema.createIndex('idx_evolution_jobs_claim').ifNotExists().on('evolution_jobs')
      .columns(['environment', 'status', 'priority', 'created_at']).execute();
    await db.schema.createTable('cluster_membership_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('cluster_id', 'text', (col) => col.notNull().references('feedback_clusters.id').onDelete('cascade'))
      .addColumn('proposal_id', 'text', (col) => col.notNull().references('proposals.id').onDelete('cascade'))
      .addColumn('event_kind', 'text', (col) => col.notNull())
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('confidence', 'real', (col) => col.notNull())
      .addColumn('algorithm_version', 'text', (col) => col.notNull())
      .addColumn('job_id', 'text', (col) => col.notNull().references('evolution_jobs.id').onDelete('cascade'))
      .addColumn('lease_epoch', 'integer', (col) => col.notNull())
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('evolution_resource_leases').ifNotExists()
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('domain', 'text', (col) => col.notNull())
      .addColumn('job_id', 'text', (col) => col.notNull().references('evolution_jobs.id').onDelete('cascade'))
      .addColumn('lease_owner', 'text', (col) => col.notNull())
      .addColumn('lease_epoch', 'integer', (col) => col.notNull())
      .addColumn('expires_at', 'text', (col) => col.notNull())
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addPrimaryKeyConstraint('evolution_resource_leases_pk', ['environment', 'domain']).execute();
    await db.schema.createTable('evolution_job_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('job_id', 'text', (col) => col.notNull().references('evolution_jobs.id').onDelete('cascade'))
      .addColumn('event_kind', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('detail', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createIndex('idx_evolution_job_events_job').ifNotExists().on('evolution_job_events')
      .columns(['job_id', 'created_at']).execute();
    await db.schema.createTable('owner_approvals').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('action', 'text', (col) => col.notNull())
      .addColumn('subject', 'text', (col) => col.notNull())
      .addColumn('scope_hash', 'text', (col) => col.notNull())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('expires_at', 'text', (col) => col.notNull())
      .addColumn('revoked_at', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addUniqueConstraint('owner_approvals_binding_unique', ['action', 'subject', 'scope_hash', 'environment']).execute();
    if (!(await hasColumn(db, 'owner_approvals', 'updated_at'))) {
      await db.schema.alterTable('owner_approvals').addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    }
    await db.schema.createTable('owner_approval_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('approval_id', 'text', (col) => col.notNull().references('owner_approvals.id').onDelete('cascade'))
      .addColumn('event_kind', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('detail', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('evolution_runtime_state').ifNotExists()
      .addColumn('environment', 'text', (col) => col.primaryKey())
      .addColumn('environment_ready', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('identities_ready', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('owner_activated', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('development_max_concurrency', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('evidence_ref', 'text')
      .addColumn('updated_by', 'text', (col) => col.notNull().defaultTo('migration'))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('evolution_circuit').ifNotExists()
      .addColumn('environment', 'text', (col) => col.primaryKey())
      .addColumn('state', 'text', (col) => col.notNull().defaultTo('FROZEN'))
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('evidence_ref', 'text')
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createTable('evolution_circuit_events').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('from_state', 'text', (col) => col.notNull())
      .addColumn('to_state', 'text', (col) => col.notNull())
      .addColumn('actor', 'text', (col) => col.notNull())
      .addColumn('reason', 'text', (col) => col.notNull())
      .addColumn('evidence_ref', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    for (const environment of ['staging', 'production']) {
      await db.insertInto('evolution_circuit').values({ environment, reason: 'control-plane-default-frozen' })
        .onConflict((oc) => oc.column('environment').doNothing()).execute();
      await db.insertInto('evolution_runtime_state').values({ environment, updated_by: 'migration' })
        .onConflict((oc) => oc.column('environment').doNothing()).execute();
    }
    await db.schema.createTable('evolution_incidents').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('fingerprint', 'text', (col) => col.notNull())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('service', 'text', (col) => col.notNull())
      .addColumn('severity', 'text', (col) => col.notNull())
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('open'))
      .addColumn('occurrence_count', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('summary', 'text', (col) => col.notNull())
      .addColumn('first_seen_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('last_seen_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('resolved_at', 'text')
      .addUniqueConstraint('evolution_incidents_fingerprint_unique', ['fingerprint', 'environment']).execute();
    await db.schema.createTable('evolution_metric_samples').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('environment', 'text', (col) => col.notNull())
      .addColumn('metric', 'text', (col) => col.notNull())
      .addColumn('value', 'real', (col) => col.notNull())
      .addColumn('unit', 'text', (col) => col.notNull())
      .addColumn('dimensions', 'text', (col) => col.notNull().defaultTo('{}'))
      .addColumn('observed_at', 'text', (col) => col.notNull().defaultTo(now)).execute();
    await db.schema.createIndex('idx_evolution_metric_samples_window').ifNotExists().on('evolution_metric_samples')
      .columns(['environment', 'metric', 'observed_at']).execute();
  },
  // v33：Web Chat 持久 turn 队列。浏览器生命周期不再拥有 QCA turn，按猫唯一 active_key 串行。
  async (db) => {
    const now = sql`CURRENT_TIMESTAMP`;
    await db.schema.createTable('chat_turns').ifNotExists()
      .addColumn('id', 'text', (col) => col.primaryKey())
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('user_message_id', 'text', (col) => col.notNull().references('chat_messages.id').onDelete('cascade'))
      .addColumn('reply_message_id', 'text', (col) => col.references('chat_messages.id').onDelete('set null'))
      .addColumn('qca_session_id', 'text')
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('queued'))
      .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('active_key', 'text', (col) => col.unique())
      .addColumn('last_event_id', 'text')
      .addColumn('delivery_started_at', 'text')
      .addColumn('cancel_requested_at', 'text')
      .addColumn('lease_owner', 'text')
      .addColumn('lease_expires_at', 'text')
      .addColumn('error_code', 'text')
      .addColumn('started_at', 'text')
      .addColumn('completed_at', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .execute();
    await db.schema.createIndex('idx_chat_turns_cat_queue').ifNotExists().on('chat_turns')
      .columns(['cat_id', 'status', 'priority', 'created_at']).execute();
    await db.schema.createIndex('idx_chat_turns_recovery').ifNotExists().on('chat_turns')
      .columns(['status', 'lease_expires_at']).execute();
  },
  // v34：backlog #056——主人许愿目的地（一次性，命中清除）+ 流浪模式（纯视觉状态）。
  async (db) => {
    if (!(await hasColumn(db, 'cats', 'travel_wish_location_id'))) {
      await db.schema.alterTable('cats').addColumn('travel_wish_location_id', 'text').execute();
    }
    if (!(await hasColumn(db, 'cats', 'wandering_mode'))) {
      await db.schema.alterTable('cats').addColumn('wandering_mode', 'integer', (c) => c.notNull().defaultTo(0)).execute();
    }
  },
  // v35：backlog #107——自定义外貌描述的专属载体（ISSUES #208 出口 B）。
  //
  // 为什么必须是独立列，而不是塞进 appearanceId 或 qca_session_id：
  // PR #87 曾把用户自由文本 Base64URL 编码进 `appearanceId`，而那个 ID 会流向客户端响应、
  // image_jobs.appearance_id、cat_appearances.id、去重键、图片 URL 与**错误日志**
  // ⇒ 用户内容长期扩散到标识符与诊断面（[[ISSUES #208]]）。PR #88 第 3 轮复核又发现
  // 同类问题的变体：描述随 session 载荷被无条件写回同一行，终态（canceled/failed）行仍残留。
  //
  // 出口 B：给它一个**语义明确、可机械断言生命周期**的独立列。
  //   · 只在入队时写入，随任务终态（succeeded/failed/canceled）在**同一条 UPDATE 里**清空；
  //   · 标识符（appearance_id / qca_session_id）一律不含用户内容，仍然不透明；
  //   · 因此「哪些行可能含用户描述」= 「status 仍是非终态的 image_jobs 行」，一句 SQL 可核。
  //
  // 刻意不加 NOT NULL / 不设默认值：NULL 就是「此任务无自定义描述」，也是清理后的终态，
  // 两者语义同一，避免再引入「空字符串 vs NULL」的二义。
  async (db) => {
    if (!(await hasColumn(db, 'image_jobs', 'custom_description'))) {
      await db.schema.alterTable('image_jobs').addColumn('custom_description', 'text').execute();
    }
  },
  // v36：backlog #099——猫在旅行运行中选定、服务端校验后的今日目的地。
  // 独立业务列避免把玩家可见事实塞进 qca_health_cache 诊断快照；日期让跨日陈旧值天然失效，
  // selected_at 只用于审计/展示新鲜度。最终 travels/report 在同一事务内清空三列。
  async (db) => {
    if (!(await hasColumn(db, 'cats', 'current_destination_location_id'))) {
      await db.schema.alterTable('cats').addColumn('current_destination_location_id', 'text').execute();
    }
    if (!(await hasColumn(db, 'cats', 'current_destination_selected_on'))) {
      await db.schema.alterTable('cats').addColumn('current_destination_selected_on', 'text').execute();
    }
    if (!(await hasColumn(db, 'cats', 'current_destination_selected_at'))) {
      await db.schema.alterTable('cats').addColumn('current_destination_selected_at', 'text').execute();
    }
  },
  // v37：backlog #092——私有阅读明信片的稳定来源快照。
  // 来源正文不落库；type/id 可追溯，title 快照保证成长卡撤回后历史私有手账仍可读。
  async (db) => {
    if (!(await hasColumn(db, 'postcards', 'reading_source_type'))) {
      await db.schema.alterTable('postcards').addColumn('reading_source_type', 'text').execute();
    }
    if (!(await hasColumn(db, 'postcards', 'reading_source_id'))) {
      await db.schema.alterTable('postcards').addColumn('reading_source_id', 'text').execute();
    }
    if (!(await hasColumn(db, 'postcards', 'reading_source_title'))) {
      await db.schema.alterTable('postcards').addColumn('reading_source_title', 'text').execute();
    }
  },
  // v38：backlog #134——活跃猫的仓库任务版本/内容哈希对账。
  // PAT、CAT_TOKEN 与 QCA 原始错误不进入表；provider_started_at + lease_epoch
  // 让崩溃接管先回读远端再决定是否重写，旧 worker 不能越过 fencing 收口。
  async (db) => {
    const now = sql`CURRENT_TIMESTAMP`;
    await db.schema.createTable('cat_task_reconciliations').ifNotExists()
      .addColumn('cat_id', 'text', (col) => col.notNull().references('cats.id').onDelete('cascade'))
      .addColumn('task_id', 'text', (col) => col.notNull())
      .addColumn('branch', 'text', (col) => col.notNull())
      .addColumn('target_resource_id', 'text', (col) => col.notNull())
      .addColumn('desired_version', 'integer', (col) => col.notNull())
      .addColumn('desired_hash', 'text', (col) => col.notNull())
      .addColumn('desired_instruction_hash', 'text', (col) => col.notNull())
      .addColumn('applied_branch', 'text')
      .addColumn('applied_resource_id', 'text')
      .addColumn('applied_version', 'integer')
      .addColumn('applied_hash', 'text')
      .addColumn('applied_instruction_hash', 'text')
      .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
      .addColumn('attempt_count', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('error_code', 'text')
      .addColumn('lease_owner', 'text')
      .addColumn('lease_epoch', 'integer', (col) => col.notNull().defaultTo(0))
      .addColumn('lease_expires_at', 'text')
      .addColumn('provider_started_at', 'text')
      .addColumn('applied_at', 'text')
      .addColumn('next_attempt_at', 'text')
      .addColumn('created_at', 'text', (col) => col.notNull().defaultTo(now))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .addPrimaryKeyConstraint('cat_task_reconciliations_pk', ['cat_id', 'task_id'])
      .execute();
    await db.schema.createIndex('idx_cat_task_reconcile_claim').ifNotExists()
      .on('cat_task_reconciliations')
      .columns(['task_id', 'status', 'next_attempt_at', 'lease_expires_at'])
      .execute();
    await db.schema.createTable('task_reconcile_cursors').ifNotExists()
      .addColumn('task_id', 'text', (col) => col.primaryKey())
      .addColumn('desired_version', 'integer', (col) => col.notNull())
      .addColumn('desired_hash', 'text', (col) => col.notNull())
      .addColumn('cursor_cat_id', 'text')
      .addColumn('scan_epoch', 'integer', (col) => col.notNull().defaultTo(1))
      .addColumn('updated_at', 'text', (col) => col.notNull().defaultTo(now))
      .execute();
  },
];

// 单一事实来源：测试与发布工具需要断言最新 schema 时必须引用迁移表长度，
// 禁止在调用方复制一个会随新增 migration 漂移的版本号。
export const LATEST_SCHEMA_VERSION = migrations.length;

export async function migrateToLatest(db: Db, dialect: DatabaseDialect) {
  await db.schema.createTable('schema_migrations').ifNotExists()
    .addColumn('version', 'integer', (c) => c.primaryKey())
    .addColumn('applied_at', 'text', (c) => c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)).execute();
  // 旧自进化分支曾把控制面写进整数 v29，导致主线 v29 猫遇能力被错误视为已执行。
  // 版本号不能回退；每次启动先做 additive capability repair，保留旧 marker 与全部数据。
  const recordedBeforeRepair = await db.selectFrom('schema_migrations')
    .select(({ fn }) => fn.max<number>('version').as('version')).executeTakeFirst();
  if (Number(recordedBeforeRepair?.version ?? 0) >= 29 && !(await hasTable(db, 'encounters'))) {
    await db.transaction().execute((trx) => migrations[28](trx));
  }
  const current = await db.selectFrom('schema_migrations').select(({ fn }) => fn.max<number>('version').as('version')).executeTakeFirst();
  for (let index = current?.version ?? 0; index < LATEST_SCHEMA_VERSION; index += 1) {
    await db.transaction().execute(async (trx) => {
      await migrations[index](trx);
      await trx.insertInto('schema_migrations').values({ version: index + 1 }).onConflict((oc) => oc.column('version').doNothing()).execute();
    });
  }
  if (dialect === 'postgres') await enforcePostgresServerOnlyAccess(db);
}
