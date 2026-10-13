import type { User } from '@hearth/core/db';
import type { Env } from '@hearth/core/env';

declare global {
  namespace App {
    interface PageData {
      siteName?: string;
      appOrigin?: string;
    }
    interface Locals {
      user: User | null;
      env: Env;
      siteName?: string;
    }
  }
}
export {};
