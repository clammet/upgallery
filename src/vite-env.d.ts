/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONVEX_URL: string;
  readonly VITE_CONVEX_SITE_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_STORAGE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
