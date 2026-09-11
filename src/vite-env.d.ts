/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Convex deployment URL; set at build time, absent on a purely local build. */
  readonly VITE_CONVEX_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
