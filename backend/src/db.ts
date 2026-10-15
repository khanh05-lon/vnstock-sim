import { PGlite, types } from '@electric-sql/pglite';

/** Giao diện truy vấn dùng chung cho kết nối thường và transaction */
export interface Queryable {
  many<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
}

/** Khoá bất đồng bộ đơn giản: đảm bảo mọi truy vấn/transaction chạy tuần tự. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

type PgLike = Pick<PGlite, 'query' | 'exec'>;

function wrap(pg: PgLike): Queryable {
  return {
    async many<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows;
    },
    async one<T>(sql: string, params?: unknown[]) {
      const res = await pg.query<T>(sql, params as never[]);
      return res.rows[0];
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
  };
}

export class Database implements Queryable {
  private lock = new Mutex();
  private q: Queryable;

  private constructor(private pg: PGlite) {
    this.q = wrap(pg);
  }

  /** dataDir = undefined → cơ sở dữ liệu trong bộ nhớ (dùng cho test) */
  static async open(dataDir?: string): Promise<Database> {
    const pg = new PGlite(dataDir, {
      parsers: {
        // giữ DATE ở dạng chuỗi YYYY-MM-DD
        [types.DATE]: (v: string) => v,
      },
    });
    await pg.waitReady;
    return new Database(pg);
  }

  many<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.lock.run(() => this.q.many<T>(sql, params));
  }

  one<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.lock.run(() => this.q.one<T>(sql, params));
  }

  exec(sql: string) {
    return this.lock.run(() => this.q.exec(sql));
  }

  /** Chạy fn trong 1 transaction; lỗi ném ra sẽ rollback. Không gọi db.* bên trong fn — dùng tx. */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.lock.run(() => this.pg.transaction((t) => fn(wrap(t as unknown as PgLike))));
  }

  close() {
    return this.lock.run(() => this.pg.close());
  }
}
