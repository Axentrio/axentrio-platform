/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
  readonly VITE_WS_URL: string
  readonly VITE_APP_NAME: string
  readonly VITE_SENTRY_DSN: string
  readonly VITE_SENTRY_ENVIRONMENT: string
  readonly VITE_SENTRY_RELEASE: string
  readonly VITE_FEATURE_CAPABILITY_READINESS: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
