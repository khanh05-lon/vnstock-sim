import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { closeTestDb, openTestDb, usingPostgres } from './helpers/db';

let db: Database;

beforeEach(async () => {
  db = await openTestDb();
  await db.exec(`CREATE TABLE kv (id INT PRIMARY KEY, n BIGINT NOT NULL, d DATE NOT NULL DEFAULT '2026-10-15')`);
  await db.exec('INSERT INTO kv (id, n) VALUES (1, 0), (2, 0)');
});
afterEach(() => closeTestDb(db));

describe(`Database (${usingPostgres ? 'PostgreSQL' : 'PGlite'})`, () => {
  it('migration ghi nhận vào schema_migrations, chạy lại không làm gì', async () => {
    const rows = await db.many<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toContain('002_password_reset.sql');
    const { migrate } = await import('../src/migrate');
    expect(await migrate(db)).toEqual([]);
  });

  it('BIGINT trả về number; số vượt Number.MAX_SAFE_INTEGER trả về bigint', async () => {
    const r = await db.one<{ a: unknown; b: unknown; c: unknown }>(
      'SELECT 1000000000000::bigint AS a, count(*) AS b, 9007199254740993::bigint AS c FROM kv',
    );
    expect(r).toEqual({ a: 1_000_000_000_000, b: 2, c: 9007199254740993n });
  });

  it('lỗi trong tx → rollback toàn bộ', async () => {
    await expect(
      db.tx(async (tx) => {
        await tx.many('UPDATE kv SET n = 99 WHERE id = 1');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect((await db.one<{ n: number }>('SELECT n FROM kv WHERE id = 1'))!.n).toBe(0);
  });

  it('50 transaction song song đọc-sửa-ghi cùng 1 dòng với FOR UPDATE không mất cập nhật', async () => {
    await Promise.all(
      Array.from({ length: 50 }, () =>
        db.tx(async (tx) => {
          const row = await tx.one<{ n: number }>('SELECT n FROM kv WHERE id = 1 FOR UPDATE');
          await new Promise((r) => setTimeout(r, 1));
          await tx.many('UPDATE kv SET n = $1 WHERE id = 1', [row!.n + 1]);
        }),
      ),
    );
    expect((await db.one<{ n: number }>('SELECT n FROM kv WHERE id = 1'))!.n).toBe(50);
  });
});

describe.skipIf(!usingPostgres)('Database (chỉ PostgreSQL thật)', () => {
  it('DATE trả về chuỗi YYYY-MM-DD', async () => {
    expect((await db.one<{ d: unknown }>('SELECT d FROM kv WHERE id = 1'))!.d).toBe('2026-10-15');
  });

  it('không còn mutex toàn cục: tx khác dòng chạy song song, không chờ nhau', async () => {
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const order: string[] = [];
    const a = db.tx(async (tx) => {
      await tx.many('SELECT n FROM kv WHERE id = 1 FOR UPDATE');
      await gate;
      order.push('A');
    });
    const b = db.tx(async (tx) => {
      await tx.many('UPDATE kv SET n = n + 1 WHERE id = 2');
      order.push('B');
    });
    await b; // B xong trong khi A vẫn giữ transaction mở
    releaseA();
    await a;
    expect(order).toEqual(['B', 'A']);
  });

  it('deadlock: Postgres huỷ 1 tx, Database tự chạy lại và cả hai đều thành công', async () => {
    let attempts = 0;
    let lockedA!: () => void;
    let lockedB!: () => void;
    const aHasRow1 = new Promise<void>((r) => (lockedA = r));
    const bHasRow2 = new Promise<void>((r) => (lockedB = r));
    const lockBoth = (first: number, second: number, mine: () => void, other: Promise<void>) =>
      db.tx(async (tx) => {
        attempts++;
        await tx.many('UPDATE kv SET n = n + 1 WHERE id = $1', [first]);
        mine();
        await other;
        await tx.many('UPDATE kv SET n = n + 1 WHERE id = $1', [second]);
      });
    await Promise.all([lockBoth(1, 2, lockedA, bHasRow2), lockBoth(2, 1, lockedB, aHasRow1)]);
    expect(attempts).toBe(3);
    const rows = await db.many<{ n: number }>('SELECT n FROM kv ORDER BY id');
    expect(rows.map((r) => r.n)).toEqual([2, 2]);
  });
});
