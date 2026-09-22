declare global {
  namespace Cloudflare {
    interface Env {
      MIGRATION_DB: D1Database;
      TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
    }
  }
}

export {};
