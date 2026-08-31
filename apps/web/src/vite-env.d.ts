/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 与后端 NODE_ENV 对齐；运行时以 /healthz.env 为准（ADR-0024） */
  readonly VITE_APP_ENV?: string;
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
