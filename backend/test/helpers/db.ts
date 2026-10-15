import crypto from 'node:crypto';
import { Database } from '../../src/db';
import { migrate } from '../../src/migrate';

/**
 * CSDL cho test đã chạy migration.
 *  - Mặc định: PGlite in-memory.
 *  - TEST_DATABASE_URL=postgres://... → PostgreSQL thật, mỗi test một schema riêng (xoá khi đóng).
 */
const url = process.env.TEST_DATABASE_URL ?? '';
export const usingPostgres = url !== '';
const schemas = new WeakMap<Database, string>();

export async function openTestDb(): Promise<Database> {
  let db: Database;
  if (url) {
    const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
    const admin = await Database.connect(url, { max: 1 });
    await admin.exec(`CREATE SCHEMA ${schema}`);
    await admin.close();
    db = await Database.connect(url, { schema });
    schemas.set(db, schema);
  } else {
    db = await Database.open();
  }
  await migrate(db);
  return db;
}

export async function closeTestDb(db: Database) {
  const schema = schemas.get(db);
  if (schema) await db.exec(`DROP SCHEMA ${schema} CASCADE`);
  await db.close();
}
