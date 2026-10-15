import { PGlite, types } from '@electric-sql/pglite';
import pg from 'pg';

/** Giao diện truy vấn dùng chung cho kết nối thường và transaction */
export interface Queryable {
  many<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(sql: string): Promise<void>;
}

/** Phần khác nhau giữa PGlite (nhúng) và PostgreSQL thật */
interface Driver {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DbKind = 'pglite' | 'postgres';

/** Khoá bất đồng bộ đơn giản: đảm bảo mọi truy vấn/transaction chạy tuần tự. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

function queryable(query: <T>(sql: string, params?: unknown[]) => Promise<T[]>, exec: (sql: string) => Promise<void>): Queryable {
  return {
    many: (sql, params) => query(sql, params),
    one: async <T>(sql: string, params?: unknown[]) => (await query<T>(sql, params))[0],
    exec,
  };
}

/* ------------------------------- PGlite ------------------------------- */

type PgLike = Pick<PGlite, 'query' | 'exec'>;

const pgliteQuery =
  (pg: PgLike) =>
  async <T>(sql: string, params?: unknown[]) =>
    (await pg.query<T>(sql, params as never[])).rows;

/** PGlite chỉ có 1 kết nối → tuần tự hoá mọi truy vấn bằng mutex */
function pgliteDriver(pg: PGlite): Driver {
  const lock = new Mutex();
  const query = pgliteQuery(pg);
  return {
    query: (sql, params) => lock.run(() => query(sql, params)),
    exec: (sql) => lock.run(async () => void (await pg.exec(sql))),
    tx: (fn) =>
      lock.run(() =>
        pg.transaction((t) => {
          const tq = t as unknown as PgLike;
          return fn(queryable(pgliteQuery(tq), async (sql) => void (await tq.exec(sql))));
        }),
      ),
    close: () => lock.run(() => pg.close()),
  };
}

/* ----------------------------- PostgreSQL ----------------------------- */

const OID_INT8 = 20;
const OID_DATE = 1082;

/** Đồng bộ kiểu trả về với PGlite: INT8 → number (khi an toàn), DATE → chuỗi YYYY-MM-DD */
const pgTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format !== 'binary') {
      if (oid === OID_INT8) {
        return (v: string) => {
          const n = Number(v);
          return Number.isSafeInteger(n) ? n : BigInt(v);
        };
      }
      if (oid === OID_DATE) return (v: string) => v;
    }
    return pg.types.getTypeParser(oid, format);
  },
} as pg.CustomTypesConfig;

/** deadlock_detected / serialization_failure: Postgres huỷ 1 transaction, chạy lại là an toàn */
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_TX_ATTEMPTS = 3;

function postgresDriver(pool: pg.Pool): Driver {
  const query = async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as T[];
  return {
    query,
    exec: async (sql) => void (await pool.query(sql)),
    // Không dùng mutex: các transaction chạy song song, tranh chấp được xử lý bằng SELECT ... FOR UPDATE
    async tx(fn) {
      for (let attempt = 1; ; attempt++) {
        const client = await pool.connect();
        let broken: Error | undefined;
        try {
          await client.query('BEGIN');
          const tq = queryable(
            async (sql, params) => (await client.query(sql, params)).rows,
            async (sql) => void (await client.query(sql)),
          );
          const result = await fn(tq);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK').catch((e: Error) => (broken = e));
          const code = (err as { code?: string }).code;
          if (!broken && code && RETRYABLE.has(code) && attempt < MAX_TX_ATTEMPTS) continue;
          throw err;
        } finally {
          client.release(broken);
        }
      }
    },
    close: () => pool.end(),
  };
}

export interface PostgresOptions {
  /** Số kết nối tối đa trong pool */
  max?: number;
  /** Đặt search_path (dùng để cô lập dữ liệu test theo schema) */
  schema?: string;
  onError?: (err: Error) => void;
}

export class Database implements Queryable {
  private constructor(
    private driver: Driver,
    readonly kind: DbKind,
  ) {}

  /** PGlite nhúng. dataDir = undefined → cơ sở dữ liệu trong bộ nhớ (dùng cho test) */
  static async open(dataDir?: string): Promise<Database> {
    const pg = new PGlite(dataDir, {
      parsers: {
        // giữ DATE ở dạng chuỗi YYYY-MM-DD
        [types.DATE]: (v: string) => v,
      },
    });
    await pg.waitReady;
    return new Database(pgliteDriver(pg), 'pglite');
  }

  /** PostgreSQL thật qua chuỗi kết nối (DATABASE_URL) */
  static async connect(url: string, opts: PostgresOptions = {}): Promise<Database> {
    if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`Tên schema không hợp lệ: ${opts.schema}`);
    const pool = new pg.Pool({
      connectionString: url,
      max: opts.max ?? 10,
      types: pgTypes,
      options: opts.schema ? `-c search_path=${opts.schema}` : undefined,
    });
    // Lỗi của kết nối đang rảnh (vd. Postgres khởi động lại) không được làm sập tiến trình
    pool.on('error', (err) => (opts.onError ? opts.onError(err) : console.error('[db] lỗi kết nối Postgres', err)));
    await pool.query('SELECT 1');
    return new Database(postgresDriver(pool), 'postgres');
  }

  many<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return this.driver.query<T>(sql, params);
  }

  async one<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    return (await this.driver.query<T>(sql, params))[0];
  }

  exec(sql: string) {
    return this.driver.exec(sql);
  }

  /** Chạy fn trong 1 transaction; lỗi ném ra sẽ rollback. Không gọi db.* bên trong fn — dùng tx. */
  tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.driver.tx(fn);
  }

  close() {
    return this.driver.close();
  }
}
