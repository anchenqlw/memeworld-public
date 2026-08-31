import type { CatProfile } from '../api/client';

export type ClientProposalContext = {
  occurred_at: string;
  user_agent: string;
  pathname: string;
  scene: string;
  panel?: string;
  app_build?: string | null;
  viewport?: string;
  last_ui_error?: string;
  cat_snapshot?: {
    id: string;
    appearance_status?: string;
    lifecycle_stage?: string;
    adventure_presence_phase?: string;
  };
  alerts?: {
    image?: { code: string; source: string; message: string };
    qca?: { status?: string; code?: string; message?: string };
  };
};

function readAppBuild(): string | null {
  if (typeof document === 'undefined') return null;
  const script = document.querySelector('script[type="module"][src*="assets/"]') as HTMLScriptElement | null;
  if (!script?.src) return null;
  const match = script.src.match(/assets\/([^/?]+)/);
  return match?.[1] ?? script.src;
}

export function buildClientProposalContext(params: {
  scene: string;
  panel?: string | null;
  cat?: CatProfile | null;
  lastUiError?: string;
}): ClientProposalContext {
  const { cat, panel, scene, lastUiError } = params;
  const ctx: ClientProposalContext = {
    occurred_at: new Date().toISOString(),
    user_agent: navigator.userAgent,
    pathname: window.location.pathname,
    scene,
    panel: panel || undefined,
    app_build: readAppBuild(),
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  };
  if (lastUiError?.trim()) ctx.last_ui_error = lastUiError.trim().slice(0, 300);
  if (cat) {
    ctx.cat_snapshot = {
      id: cat.id,
      appearance_status: cat.appearance_status,
      lifecycle_stage: cat.lifecycle_stage,
      adventure_presence_phase: cat.adventure_presence?.phase,
    };
    const alerts: ClientProposalContext['alerts'] = {};
    if (cat.image_generation_alert) {
      alerts.image = {
        code: cat.image_generation_alert.code,
        source: cat.image_generation_alert.source,
        message: cat.image_generation_alert.message.slice(0, 200),
      };
    }
    if (cat.qca_health?.alert) {
      alerts.qca = {
        status: cat.qca_health.status,
        code: cat.qca_health.alert.code,
        message: cat.qca_health.alert.message.slice(0, 200),
      };
    } else if (cat.qca_health?.status) {
      alerts.qca = { status: cat.qca_health.status };
    }
    if (Object.keys(alerts).length > 0) ctx.alerts = alerts;
  }
  return ctx;
}
