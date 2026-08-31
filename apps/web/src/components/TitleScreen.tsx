import { Sky } from './ui/Sky';
import { Icon } from './ui/Icon';
import { assetUrl } from '../game/assets';

function ProviderMark({ provider }: { provider: 'google' | 'github' }) {
  if (provider === 'google') {
    return <span className="auth-provider-mark auth-provider-mark--google" aria-hidden="true">G</span>;
  }

  return (
    <svg className="auth-provider-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.92.83.09-.65.35-1.09.64-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82a9.6 9.6 0 0 1 2.5.34c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
      />
    </svg>
  );
}

/** 标题屏：进入游戏前的第一眼 */
/** OAuth 回调错误码 → 玩家可读文案（backlog #055：服务端 302 带 auth_error 回标题屏） */
const AUTH_ERROR_TEXT: Record<string, string> = {
  OAUTH_DENIED: '登录没有完成——如果是不小心取消的，再试一次就好。',
  INVALID_OAUTH_STATE: '这次登录等待太久已过期，请重新发起登录。',
  OAUTH_FAILED: '登录服务暂时不稳定，请稍后再试一次。',
};

export function TitleScreen({ onGoogleLogin, onGitHubLogin, onStartFresh, devMode, authError }: {
  onGoogleLogin: () => void;
  onGitHubLogin: () => void;
  /** dev：以全新账号进入，重走建猫流程 */
  onStartFresh?: () => void;
  devMode?: boolean;
  /** OAuth 回调失败时的错误码（来自 ?auth_error=） */
  authError?: string | null;
}) {
  const logo = assetUrl('logo');
  const titleCat = assetUrl('titleCat');

  return (
    <Sky>
      <main className="title-screen">
        {/* 主视觉：AI 素材就绪前用云朵+猫爪占位 */}
        <div className="title-visual">
          {titleCat ? (
            <img
              src={titleCat}
              alt=""
              draggable={false}
              className="title-cat-art"
            />
          ) : (
            <div
              style={{
                width: 190,
                height: 190,
                margin: '0 auto',
                borderRadius: '50%',
                background: 'radial-gradient(circle at 38% 32%, #ffffff 0%, #eaf5fb 55%, #cfe8f4 100%)',
                border: '3px solid rgba(255,255,255,0.9)',
                boxShadow: '0 24px 60px rgba(61,64,91,0.25), inset 0 -14px 28px rgba(142,202,230,0.35)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name="paw" size={96} color="var(--sky-deep)" strokeWidth={1.4} filled={false} />
            </div>
          )}
        </div>

        <div className="title-brand">
          {logo ? (
            <img src={logo} alt="Me&Me 我&猫" style={{ width: 320, maxWidth: '80vw' }} />
          ) : (
            <h1
              style={{
                fontSize: 'clamp(2.4rem, 7vw, 4rem)',
                letterSpacing: '0.12em',
                color: '#fff',
                textShadow: '0 3px 0 rgba(95,168,211,0.9), 0 10px 30px rgba(61,64,91,0.35)',
              }}
            >
              Me&Me · 我&猫
            </h1>
          )}
          <p className="title-tagline">
            从今天起，远方也有一个小小的你
          </p>
        </div>

        <div className="auth-actions" aria-label="选择登录方式">
          {authError && (
            <p
              role="alert"
              style={{
                margin: '0 0 4px',
                padding: '8px 14px',
                borderRadius: 12,
                background: 'rgba(255,250,235,0.95)',
                color: 'var(--ink)',
                fontSize: '0.82rem',
                boxShadow: '0 2px 10px rgba(80,60,30,0.12)',
              }}
            >
              {AUTH_ERROR_TEXT[authError] || AUTH_ERROR_TEXT.OAUTH_FAILED}
            </p>
          )}
          <button type="button" className="gs-btn gs-btn--ghost auth-provider-button" onClick={onGoogleLogin}>
            <ProviderMark provider="google" />
            使用 Google 登录
          </button>
          <button type="button" className="gs-btn gs-btn--ghost auth-provider-button" onClick={onGitHubLogin}>
            <ProviderMark provider="github" />
            使用 GitHub 登录
          </button>
          {devMode && onStartFresh && (
            <button type="button" className="gs-btn gs-btn--ghost gs-btn--small" onClick={onStartFresh} title="创建全新 mock 账号，重走建猫流程">
              <Icon name="plus" size={15} strokeWidth={2.4} />
              以新账号体验建猫流程
            </button>
          )}
        </div>

        <p className="title-footer">
          它是你的猫，也是替你在云端生活的另一个自己
        </p>
      </main>
    </Sky>
  );
}
