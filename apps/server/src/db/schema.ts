import type { ColumnType, Generated } from 'kysely';

export type Timestamp = ColumnType<string, string | undefined, string>;

export interface DatabaseSchema {
  schema_migrations: { version: number; applied_at: Timestamp };
  users: {
    id: string; provider: Generated<string>; provider_user_id: string | null; buc_id: string | null;
    display_name: string; email: string | null; avatar_url: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
  pat_credentials: {
    id: string; user_id: string; encrypted_pat: string; pat_hint: string; status: Generated<string>;
    qca_site: Generated<string>; last_verified_at: string | null; created_at: Timestamp; updated_at: Timestamp;
  };
  pat_replacement_requests: {
    id: string; user_id: string; encrypted_new_pat: string; pat_hint: string; qca_site: string;
    classification: string; status: Generated<string>; expires_at: string; created_at: Timestamp; updated_at: Timestamp;
  };
  cat_archives: {
    id: string; user_id: string; source_cat_id: string; name: string; snapshot: string;
    reason: string; orphan_risk: Generated<number>; created_at: Timestamp;
  };
  cats: {
    id: string; user_id: string; name: string; personality: string;
    attr_courage: number; attr_curiosity: number; attr_affinity: number; attr_insight: number;
    qca_model: string | null;
    qca_env_id: string | null; qca_agent_id: string | null; qca_memstore_id: string | null;
    qca_deployment_id: string | null; qca_image_env_id: string | null; qca_image_agent_id: string | null;
    qca_image_policy_version: Generated<number>;
    image_identity_anchor: string | null; cat_token_hash: string; appearance: string; outfit: Generated<string>;
    current_image_url: string | null; appearance_status: Generated<string>; qca_chat_session_id: string | null;
    lifecycle_stage: Generated<string>; selected_birth_appearance_id: string | null;
    appearance_confirmed_at: string | null; adventure_started_at: string | null;
    travel_schedule_enabled: Generated<number>;
    meet_enabled: Generated<number>; status: Generated<string>; qca_health_cache: string | null;
    qca_health_checked_at: string | null;     qca_travel_session_id: string | null;
    qca_travel_session_token_hash: string | null;
    last_travel_dispatched_on: string | null;
    qca_forward_travel_template_id: string | null;
    qca_forward_identity_id: string | null;
    qca_forward_schedule_id: string | null;
    qca_forward_travel_session_id: string | null;
    qca_forward_travel_session_token_hash: string | null;
    qca_forward_chat_template_id: string | null;
    qca_forward_im_channel_id: string | null;
    travel_wish_location_id: string | null;
    current_destination_location_id: string | null;
    current_destination_selected_on: string | null;
    current_destination_selected_at: string | null;
    wandering_mode: Generated<number>;
    created_at: Timestamp; updated_at: Timestamp;
  };
  travels: {
    id: string; cat_id: string; travel_date: string; location_id: string; event_id: string | null;
    narrative: string; mood: string | null; attr_delta: Generated<string>; memory_digest: string | null;
    memory_reference: string | null; encounter_summary: string | null; reported_at: Timestamp;
  };
  encounters: {
    id: string; match_key: string; encounter_date: string; location_id: string;
    kind: Generated<string>; status: Generated<string>; photo_status: Generated<string>; created_at: Timestamp;
  };
  encounter_actions: {
    id: string; encounter_id: string; actor_cat_id: string | null; action_type: string;
    payload: Generated<string>; created_at: Timestamp;
  };
  encounter_receipts: {
    id: string; encounter_id: string; cat_id: string; travel_id: string; encounter_date: string;
    perspective: string; summary: string; photo_appearance_id: string | null; created_at: Timestamp;
  };
  cat_relationships: {
    cat_id: string; other_cat_id: string; encounter_count: Generated<number>;
    last_encounter_id: string; last_encounter_date: string; status: Generated<string>; updated_at: Timestamp;
  };
  postcards: {
    id: string; travel_id: string; title: string; content: string; question: string | null; image_url: string | null;
    home_messages: string | null; photo_object_key: string | null; photo_status: Generated<string>; photo_prompt: string | null; cherished_at: string | null;
    reading_source_type: string | null; reading_source_id: string | null; reading_source_title: string | null;
  };
  cat_onboarding_answers: {
    id: string; cat_id: string; question_id: string; answer_type: string; choice_id: string | null;
    answer_text: string | null; memory_digest: string | null; sync_status: Generated<string>;
    created_at: Timestamp; updated_at: Timestamp;
  };
  postcard_responses: {
    id: string; postcard_id: string; cat_id: string; response_type: string; choice_id: string | null;
    content: string | null; memory_digest: string | null; memory_sync_status: Generated<string>; created_at: Timestamp; updated_at: Timestamp;
  };
  bond_state: { cat_id: string; stage: Generated<string>; score_internal: Generated<number>; last_reason: string; story_arc_id: string | null; story_step: Generated<number>; updated_at: Timestamp };
  cat_items: {
    id: string; cat_id: string; item_id: string; acquired_at: Timestamp; source: string | null;
  };
  cat_badges: {
    id: string; cat_id: string; badge_id: string; earned_at: Timestamp; reason: string | null;
  };
  proposals: {
    id: string; user_id: string; type: string; content: string; status: Generated<string>;
    backlog_ref: string | null; context: string | null; decision_note: string | null; public_note: string | null;
    reporter_display_name: Generated<string>; reporter_cat_name: string | null;
    contribution_points: Generated<number>; reward_status: Generated<string>;
    accepted_at: string | null; shipped_at: string | null; created_at: Timestamp; exported_at: string | null;
  };
  proposal_events: {
    id: string; proposal_id: string; actor_type: string; actor_name: string;
    from_status: string | null; to_status: string; event_kind: Generated<string>;
    idempotency_key: Generated<string | null>; visibility: Generated<string>;
    evidence_ref: Generated<string | null>; public_note: string | null; created_at: Timestamp;
  };
  workflow_cursors: {
    id: string; environment: string; cursor_value: string; archive_commit_sha: string | null;
    updated_at: Timestamp;
  };
  cat_task_reconciliations: {
    cat_id: string; task_id: string; branch: string; target_resource_id: string;
    desired_version: number; desired_hash: string; desired_instruction_hash: string;
    applied_branch: string | null; applied_resource_id: string | null;
    applied_version: number | null; applied_hash: string | null; applied_instruction_hash: string | null;
    status: Generated<string>; attempt_count: Generated<number>; error_code: string | null;
    lease_owner: string | null; lease_epoch: Generated<number>; lease_expires_at: string | null;
    provider_started_at: string | null; applied_at: string | null; next_attempt_at: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
  task_reconcile_cursors: {
    task_id: string; desired_version: number; desired_hash: string;
    cursor_cat_id: string | null; scan_epoch: Generated<number>; updated_at: Timestamp;
  };
  feedback_claims: {
    id: string; environment: string; lease_owner: string; proposal_ids: string;
    cursor_from: string; cursor_to: string; status: Generated<string>; expires_at: string;
    lease_epoch: Generated<number>; attempts: Generated<number>; max_attempts: Generated<number>;
    heartbeat_at: string | null; error_code: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
  feedback_archives: {
    proposal_id: string; claim_id: string; event_id: string; archive_commit_sha: string;
    idempotency_key: string; sanitized_ref: string; sanitized_sha256: string; archived_at: Timestamp;
  };
  feedback_clusters: {
    id: string; environment: string; fingerprint: string; title: string; summary: string; classification: string;
    confidence: number; policy_version: string; status: Generated<string>; sample_count: Generated<number>;
    created_at: Timestamp; updated_at: Timestamp;
  };
  cluster_memberships: {
    cluster_id: string; proposal_id: string; reason: string; confidence: number;
    algorithm_version: string; active: Generated<number>; created_at: Timestamp; updated_at: Timestamp;
  };
  cluster_membership_events: {
    id: string; cluster_id: string; proposal_id: string; event_kind: string; reason: string;
    confidence: number; algorithm_version: string; job_id: string; lease_epoch: number; created_at: Timestamp;
  };
  evolution_work_items: {
    id: string; environment: string; backlog_ref: string; cluster_id: string | null; title: string; summary: string;
    risk_level: string; allowed_paths: string; lock_domains: string; acceptance: string;
    status: Generated<string>; authorization_source: string | null; policy_version: string | null;
    implementation_job_id: string | null; branch_name: string | null; draft_pr_number: number | null;
    draft_pr_url: string | null; head_sha: string | null;
    version: Generated<number>; created_at: Timestamp; updated_at: Timestamp;
  };
  evolution_jobs: {
    id: string; task_id: string; environment: string; input_hash: string; payload: Generated<string>;
    status: Generated<string>; priority: Generated<number>; attempts: Generated<number>; max_attempts: number;
    budget_limit: number; budget_used: Generated<number>;
    lease_owner: string | null; lease_epoch: Generated<number>; lease_expires_at: string | null; heartbeat_at: string | null;
    lock_domains: Generated<string>;
    idempotency_key: string; approval_action: string | null; approval_subject: string | null;
    approval_scope_hash: string | null;
    result: string | null; error_code: string | null; created_at: Timestamp; updated_at: Timestamp;
  };
  evolution_resource_leases: {
    environment: string; domain: string; job_id: string; lease_owner: string;
    lease_epoch: number; expires_at: string; updated_at: Timestamp;
  };
  evolution_job_events: {
    id: string; job_id: string; event_kind: string; actor: string; detail: Generated<string>;
    created_at: Timestamp;
  };
  owner_approvals: {
    id: string; action: string; subject: string; scope_hash: string; environment: string;
    actor: string; expires_at: string; revoked_at: string | null; created_at: Timestamp; updated_at: Timestamp;
  };
  owner_approval_events: {
    id: string; approval_id: string; event_kind: string; actor: string; detail: Generated<string>; created_at: Timestamp;
  };
  evolution_runtime_state: {
    environment: string; environment_ready: Generated<number>; identities_ready: Generated<number>;
    owner_activated: Generated<number>; development_max_concurrency: Generated<number>;
    evidence_ref: string | null; updated_by: string; updated_at: Timestamp;
  };
  evolution_circuit: {
    environment: string; state: Generated<string>; reason: string; evidence_ref: string | null;
    updated_at: Timestamp;
  };
  evolution_circuit_events: {
    id: string; environment: string; from_state: string; to_state: string; actor: string;
    reason: string; evidence_ref: string | null; created_at: Timestamp;
  };
  evolution_incidents: {
    id: string; fingerprint: string; environment: string; service: string; severity: string;
    status: Generated<string>; occurrence_count: Generated<number>; summary: string;
    first_seen_at: Timestamp; last_seen_at: Timestamp; resolved_at: string | null;
  };
  evolution_metric_samples: {
    id: string; environment: string; metric: string; value: number; unit: string;
    dimensions: Generated<string>; observed_at: Timestamp;
  };
  contribution_events: {
    id: string; user_id: string; proposal_id: string; event_type: string; points: number;
    reason: string; created_at: Timestamp;
  };
  growth_cards: {
    id: string; user_id: string; cat_id: string; type: string; title: string; summary: string;
    source_url: string | null; tags: Generated<string>; visibility: Generated<string>;
    sync_status: Generated<string>; sync_error: string | null; deleted_at: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
  interactions: {
    id: string; cat_id: string; channel: Generated<string>; qca_session_id: string | null;
    turns: Generated<number>; date: string;
  };
  chat_messages: {
    id: string; cat_id: string; qca_session_id: string | null; source_event_id: string | null;
    role: string; content: string; created_at: Timestamp;
  };
  chat_turns: {
    id: string; cat_id: string; user_message_id: string; reply_message_id: string | null;
    qca_session_id: string | null; status: Generated<string>; priority: Generated<number>;
    active_key: string | null; last_event_id: string | null; delivery_started_at: string | null;
    cancel_requested_at: string | null; lease_owner: string | null; lease_expires_at: string | null;
    error_code: string | null; started_at: string | null; completed_at: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
  world_meta: { key: string; value: string };
  world_locations: {
    id: string; name: string; description: string; mood_tags: string; min_attrs: Generated<string>;
    map_x: number; map_y: number; region_id: Generated<string>; map_priority: Generated<number>;
    status: Generated<string>; synced_at: Timestamp;
  };
  world_events: {
    id: string; location_id: string; name: string; description: string; event_gene: string | null;
    attr_bonus: Generated<string>; synced_at: Timestamp;
  };
  world_items: {
    id: string; name: string; slot: string; description: string; drop_gene: string | null;
    drop_chance: Generated<number>; kind: Generated<string>; asset_key: string | null; synced_at: Timestamp;
  };
  world_badges: {
    id: string; name: string; description: string; rule: string; synced_at: Timestamp;
  };
  world_chronicle: {
    id: string; date: string; title: string; summary: string; change_type: string;
    source_kind: string; proposal_id: string | null; contributor_cat_name: string | null;
    history_file: string; status: Generated<string>; revision: Generated<number>;
    published_at: string | null; created_at: Timestamp; updated_at: Timestamp;
  };
  world_chronicle_revisions: {
    id: string; chronicle_id: string; revision: number; snapshot: string;
    actor_name: string; change_note: string | null; created_at: Timestamp;
  };
  cat_appearances: {
    id: string; cat_id: string; kind: string; image_url: string; local_path: string; object_key: string | null; prompt: string;
    travel_id: string | null; selection_status: Generated<string>; created_at: Timestamp;
  };
  image_jobs: {
    id: string; dedupe_key: string; cat_id: string; kind: string; travel_id: string | null; appearance_id: string | null;
    status: Generated<string>; attempts: Generated<number>; available_at: Timestamp;
    started_at: string | null; finished_at: string | null; last_error: string | null;
    qca_session_id: string | null; cancel_requested_at: string | null;
    // backlog #107 / ISSUES #208 出口 B：自定义外貌描述的专属载体。
    // 生命周期：入队时写入，随任务终态在同一条 UPDATE 里清空为 NULL。
    // 标识符（appearance_id / qca_session_id）不得携带用户内容。
    custom_description: string | null;
    created_at: Timestamp; updated_at: Timestamp;
  };
}

export type CatRow = {
  [K in keyof DatabaseSchema['cats']]: DatabaseSchema['cats'][K] extends ColumnType<infer S, unknown, unknown> ? S : DatabaseSchema['cats'][K]
};
