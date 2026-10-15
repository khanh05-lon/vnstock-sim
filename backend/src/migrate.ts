import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './db';
import { log } from './lib/logger';

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
/** Khoá advisory: nhiều tiến trình cùng khởi động thì chỉ một tiến trình chạy migration */
const MIGRATE_LOCK_ID = 73_910_001;

export async function migrate(db: Database): Promise<string[]> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const ran = await db.tx(async (tx) => {
    await tx.many('SELECT pg_advisory_xact_lock($1)', [MIGRATE_LOCK_ID]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await tx.many<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
    const out: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.many('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      out.push(file);
    }
    return out;
  });
  for (const file of ran) log.info(`[migrate] đã chạy ${file}`);
  return ran;
}
