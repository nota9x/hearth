// Wrangler emits a global declaration file, not an importable module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./bindings.d.ts" />
export type Env = Omit<
  CloudflareEnv,
  | 'ENVIRONMENT'
  | 'APP_ORIGIN'
  | 'LOCAL_DELIVERY_PORT'
  | 'TURNSTILE_SITE_KEY'
  | 'MAX_UPLOAD_BYTES'
> & {
  ENVIRONMENT: string;
  APP_ORIGIN: string;
  LOCAL_DELIVERY_PORT?: string;
  TURNSTILE_SITE_KEY: string;
  MAX_UPLOAD_BYTES: string;
  TURNSTILE_SECRET_KEY?: string;
  IMAGES?: ImagesBinding;
};
