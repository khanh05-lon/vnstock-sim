import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import type { Database, Queryable } from '../db';

/**
 * Sao lưu / khôi phục dữ liệu nghiệp vụ dạng JSON (người dùng, ví, lệnh, khớp lệnh, sổ cái...).
 * Dữ liệu giá không nằm trong bản sao lưu vì tải lại từ Binance.
 *
 * Định dạng: { app: 'vncoin-sim', version: 3, exportedAt, exportedBy, tradeDate (ngày UTC), migrations: [...], counts, data: { bảng: [dòng...] } }
 * Bản sao lưu của sàn chứng khoán cũ (app 'vnstock-sim') không khôi phục được vì khác hoàn toàn cấu trúc dữ liệu.
 */

export const BACKUP_VERSION = 3;
const APP = 'vncoin-sim';

interface TableSpec {
  name: string;
  /** Câu lấy dữ liệu khi xuất */
  sql: string;
  /** Xoá toàn bộ trước khi khôi phục (bảng nghiệp vụ); false = chỉ thêm phần còn thiếu */
  replace: boolean;
}

/** Thứ tự = thứ tự khôi phục (bảng được tham chiếu đứng trước) */
export const BACKUP_TABLES: TableSpec[] = [
  { name: 'symbols', sql: 'SELECT * FROM symbols ORDER BY sort_order, symbol', replace: false },
  { name: 'users', sql: 'SELECT * FROM users ORDER BY created_at', replace: true },
  { name: 'accounts', sql: 'SELECT * FROM accounts', replace: true },
  { name: 'balances', sql: 'SELECT * FROM balances ORDER BY user_id, asset', replace: true },
  // Ngân hàng giả lập + P2P: phải đứng trước ledger (ledger.p2p_order_id tham chiếu p2p_orders)
  { name: 'bank_accounts', sql: 'SELECT * FROM bank_accounts ORDER BY user_id', replace: true },
  { name: 'bank_transfers', sql: 'SELECT * FROM bank_transfers ORDER BY id', replace: true },
  { name: 'p2p_merchants', sql: 'SELECT * FROM p2p_merchants ORDER BY user_id', replace: true },
  { name: 'p2p_payment_methods', sql: 'SELECT * FROM p2p_payment_methods ORDER BY id', replace: true },
  { name: 'p2p_ads', sql: 'SELECT * FROM p2p_ads ORDER BY id', replace: true },
  { name: 'p2p_orders', sql: 'SELECT * FROM p2p_orders ORDER BY id', replace: true },
  { name: 'p2p_messages', sql: 'SELECT * FROM p2p_messages ORDER BY id', replace: true },
  { name: 'recovery_codes', sql: 'SELECT * FROM recovery_codes ORDER BY id', replace: true },
  { name: 'watchlist_lists', sql: 'SELECT * FROM watchlist_lists ORDER BY id', replace: true },
  { name: 'watchlists', sql: 'SELECT * FROM watchlists', replace: true },
  { name: 'price_alerts', sql: 'SELECT * FROM price_alerts ORDER BY id', replace: true },
  { name: 'order_lists', sql: 'SELECT * FROM order_lists ORDER BY id', replace: true },
  { name: 'orders', sql: 'SELECT * FROM orders ORDER BY id', replace: true },
  { name: 'fills', sql: 'SELECT * FROM fills ORDER BY id', replace: true },
  { name: 'ledger', sql: 'SELECT * FROM ledger ORDER BY id', replace: true },
  { name: 'nav_daily', sql: 'SELECT * FROM nav_daily ORDER BY day, user_id', replace: true },
  { name: 'market_meta', sql: `SELECT * FROM market_meta WHERE key LIKE 'admin.%'`, replace: true },
  { name: 'order_events', sql: 'SELECT * FROM order_events ORDER BY id', replace: true },
  { name: 'balance_adjust_requests', sql: 'SELECT * FROM balance_adjust_requests ORDER BY id', replace: true },
  { name: 'support_tickets', sql: 'SELECT * FROM support_tickets ORDER BY id', replace: true },
  { name: 'support_messages', sql: 'SELECT * FROM support_messages ORDER BY id', replace: true },
  // Nhật ký quản trị chỉ được ghi thêm: khôi phục KHÔNG xoá nhật ký hiện có, chỉ gộp thêm dòng còn thiếu
  { name: 'admin_audit_log', sql: 'SELECT * FROM admin_audit_log ORDER BY id', replace: false },
  // Đề xuất chờ duyệt: chỉ gộp thêm (đề xuất khôi phục đang thực hiện vẫn còn để ghi kết quả)
  { name: 'approval_requests', sql: 'SELECT * FROM approval_requests ORDER BY id', replace: false },
];

/** Bảng xoá theo khi khôi phục nhưng không có trong bản sao lưu (token tạm thời) */
const EPHEMERAL_TABLES = ['password_reset_tokens', 'email_verification_tokens'];

/** Đăng ký thêm bảng của tính năng khác (gọi lúc nạp module) */
export function registerBackupTable(spec: TableSpec, after?: string) {
  if (BACKUP_TABLES.some((t) => t.name === spec.name)) return;
  const i = after ? BACKUP_TABLES.findIndex((t) => t.name === after) : -1;
  if (i >= 0) BACKUP_TABLES.splice(i + 1, 0, spec);
  else BACKUP_TABLES.push(spec);
}

export interface BackupFile {
  app: 'vncoin-sim';
  version: number;
  exportedAt: string;
  exportedBy: string;
  tradeDate: string;
  migrations?: string[];
  counts: Record<string, number>;
  data: Record<string, Record<string, unknown>[]>;
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export async function exportBackup(db: Queryable, meta: { exportedBy: string; tradeDate: string }): Promise<BackupFile> {
  const data: BackupFile['data'] = {};
  const counts: Record<string, number> = {};
  for (const t of BACKUP_TABLES) {
    data[t.name] = await db.many(t.sql);
    counts[t.name] = data[t.name]!.length;
  }
  const migrations = (await db.many<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
  return { app: APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), exportedBy: meta.exportedBy, tradeDate: meta.tradeDate, migrations, counts, data };
}

export const serializeBackup = (b: BackupFile) => JSON.stringify(b, bigintSafe);

/** Ghi bản sao lưu ra thư mục (vd. tự sao lưu trước khi khôi phục); trả về đường dẫn file */
export function writeBackupFile(dir: string, prefix: string, b: BackupFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const file = path.join(dir, `${prefix}-${stamp}.json`);
  fs.writeFileSync(file, serializeBackup(b));
  return file;
}

export interface RestoreReport {
  dryRun: boolean;
  meta: { version: number; exportedAt: string; exportedBy: string; tradeDate: string };
  tables: { name: string; rows: number; ignoredColumns: string[] }[];
  symbolsAdded: string[];
  warnings: string[];
}

export class RestoreError extends Error {}

class DryRun extends Error {
  constructor(readonly report: RestoreReport) {
    super('dry-run');
  }
}

interface ColumnInfo {
  name: string;
  type: string;
  required: boolean;
}

async function columnsOf(q: Queryable, table: string): Promise<ColumnInfo[]> {
  const rows = await q.many<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => ({ name: r.column_name, type: r.data_type, required: r.is_nullable === 'NO' && r.column_default == null }));
}

async function insertRows(q: Queryable, table: string, cols: ColumnInfo[], rows: Record<string, unknown>[], conflict = '') {
  if (!rows.length || !cols.length) return;
  const per = cols.length;
  const chunk = Math.max(1, Math.floor(4000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = part.map((r, j) => {
      for (const c of cols) {
        const v = r[c.name];
        params.push(v != null && (c.type === 'jsonb' || c.type === 'json') && typeof v !== 'string' ? JSON.stringify(v) : (v ?? null));
      }
      return `(${cols.map((_, k) => `$${j * per + k + 1}`).join(',')})`;
    });
    await q.many(`INSERT INTO ${table} (${cols.map((c) => c.name).join(',')}) VALUES ${values.join(',')} ${conflict}`, params);
  }
}

/** Kiểm tra cấu trúc file trước khi đụng vào CSDL */
export function parseBackup(raw: string | Buffer): BackupFile {
  let b: BackupFile;
  try {
    b = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch {
    throw new RestoreError('File không phải JSON hợp lệ');
  }
  if ((b as { app?: string } | null)?.app === 'vnstock-sim') {
    throw new RestoreError('Đây là bản sao lưu của sàn chứng khoán VNStock cũ, không dùng được cho sàn coin VNCoin');
  }
  if (!b || b.app !== APP || typeof b.data !== 'object' || !b.data) throw new RestoreError('File không phải bản sao lưu VNCoin');
  if (!Number.isInteger(b.version) || b.version < 3 || b.version > BACKUP_VERSION) {
    throw new RestoreError(`Phiên bản bản sao lưu ${b.version} không được hỗ trợ (hỗ trợ ${BACKUP_VERSION})`);
  }
  for (const [k, v] of Object.entries(b.data)) {
    if (!Array.isArray(v) || v.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new RestoreError(`Bảng ${k} trong file không hợp lệ`);
  }
  return b;
}

/**
 * Khôi phục toàn bộ dữ liệu nghiệp vụ từ bản sao lưu trong 1 transaction (lỗi giữa chừng → không thay đổi gì).
 * dryRun = true: chạy thử đầy đủ rồi huỷ transaction, chỉ trả báo cáo.
 */
export async function restoreBackup(db: Database, b: BackupFile, opts: { dryRun: boolean; actor?: { id: string; email: string } }): Promise<RestoreReport> {
  const report: RestoreReport = {
    dryRun: opts.dryRun,
    meta: { version: b.version, exportedAt: b.exportedAt, exportedBy: b.exportedBy, tradeDate: b.tradeDate },
    tables: [],
    symbolsAdded: [],
    warnings: [],
  };

  const applied = new Set((await db.many<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const newer = (b.migrations ?? []).filter((m) => !applied.has(m));
  if (newer.length) throw new RestoreError(`Bản sao lưu được tạo từ phiên bản mới hơn (thiếu migration: ${newer.join(', ')}) — hãy cập nhật ứng dụng trước`);
  const unknownTables = Object.keys(b.data).filter((t) => !BACKUP_TABLES.some((s) => s.name === t));
  if (unknownTables.length) report.warnings.push(`Bỏ qua bảng không nhận diện được: ${unknownTables.join(', ')}`);

  // Người dùng không có mật khẩu đã băm trong file → đặt mật khẩu ngẫu nhiên, phải dùng "Quên mật khẩu"
  const users = b.data.users ?? [];
  const missingHash = users.filter((u) => typeof u.password_hash !== 'string' || !u.password_hash);
  let placeholderHash: string | null = null;
  if (missingHash.length) {
    placeholderHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    report.warnings.push(`${missingHash.length} người dùng không có mật khẩu trong file — họ cần dùng "Quên mật khẩu" để đặt lại`);
  }

  try {
    await db.tx(async (tx) => {
      // Cặp giao dịch: chỉ thêm cặp còn thiếu (không ghi đè bộ lọc / trạng thái hiện tại)
      const existing = new Set((await tx.many<{ symbol: string }>('SELECT symbol FROM symbols')).map((r) => r.symbol));
      const backupSymbols = (b.data.symbols ?? []).filter((s) => typeof s.symbol === 'string');
      const referenced = new Set<string>();
      for (const t of ['watchlists', 'price_alerts', 'order_lists', 'orders', 'fills']) {
        for (const r of b.data[t] ?? []) if (typeof r.symbol === 'string') referenced.add(r.symbol);
      }
      const missing = [...referenced].filter((s) => !existing.has(s) && !backupSymbols.some((x) => x.symbol === s));
      if (missing.length) throw new RestoreError(`Bản sao lưu tham chiếu cặp giao dịch không có trên hệ thống: ${missing.slice(0, 20).join(', ')}`);
      const toAdd = backupSymbols.filter((s) => !existing.has(String(s.symbol)));
      report.symbolsAdded = toAdd.map((s) => String(s.symbol));
      if (toAdd.length) report.warnings.push(`Sẽ thêm ${toAdd.length} cặp giao dịch có trong bản sao lưu: ${report.symbolsAdded.join(', ')}`);

      // Xoá dữ liệu nghiệp vụ hiện tại
      const replaceTables = BACKUP_TABLES.filter((t) => t.replace && t.name !== 'market_meta').map((t) => t.name);
      await tx.exec(`TRUNCATE ${[...replaceTables, ...EPHEMERAL_TABLES].join(', ')} RESTART IDENTITY CASCADE`);
      await tx.many(`DELETE FROM market_meta WHERE key LIKE 'admin.%'`);

      for (const spec of BACKUP_TABLES) {
        let rows = b.data[spec.name];
        if (!rows) {
          if (spec.replace) report.tables.push({ name: spec.name, rows: 0, ignoredColumns: [] });
          continue;
        }
        if (spec.name === 'symbols') rows = toAdd;
        if (spec.name === 'market_meta') rows = rows.filter((r) => typeof r.key === 'string' && r.key.startsWith('admin.'));
        if (spec.name === 'users' && placeholderHash) rows = rows.map((u) => (u.password_hash ? u : { ...u, password_hash: placeholderHash }));

        const cols = await columnsOf(tx, spec.name);
        const keys = new Set(rows.flatMap((r) => Object.keys(r)));
        const used = cols.filter((c) => keys.has(c.name));
        const ignoredColumns = [...keys].filter((k) => !cols.some((c) => c.name === k));
        const lacking = cols.filter((c) => c.required && !keys.has(c.name));
        if (rows.length && lacking.length) throw new RestoreError(`Bảng ${spec.name} trong file thiếu cột bắt buộc: ${lacking.map((c) => c.name).join(', ')}`);
        await insertRows(tx, spec.name, used, rows, spec.replace ? '' : 'ON CONFLICT DO NOTHING');
        report.tables.push({ name: spec.name, rows: rows.length, ignoredColumns });

        // Đồng bộ bộ đếm id tự tăng với dữ liệu vừa chèn
        if (cols.some((c) => c.name === 'id')) {
          const seq = await tx.one<{ s: string | null }>(`SELECT pg_get_serial_sequence($1, 'id') AS s`, [spec.name]);
          if (seq?.s) await tx.many(`SELECT setval($1, (SELECT COALESCE(MAX(id), 0) FROM ${spec.name}) + 1, false)`, [seq.s]);
        }
      }

      // Ghi nhật ký quản trị (người thao tác có thể không có trong bản sao lưu → admin_id để trống)
      if (opts.actor) {
        const exists = await tx.one('SELECT 1 FROM users WHERE id = $1', [opts.actor.id]);
        await tx.many(
          `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, detail) VALUES ($1, $2, 'DATA_RESTORE', 'system', NULL, $3::jsonb)`,
          [exists ? opts.actor.id : null, opts.actor.email, JSON.stringify({ exportedAt: b.exportedAt, exportedBy: b.exportedBy, counts: b.counts })],
        );
      }
      if (opts.dryRun) throw new DryRun(report);
    });
  } catch (err) {
    if (err instanceof DryRun) return err.report;
    if (err instanceof RestoreError) throw err;
    const code = (err as { code?: string }).code;
    if (code === '23503' || code === '23505' || code === '23514') {
      throw new RestoreError(`Dữ liệu trong file không nhất quán: ${(err as Error).message}`);
    }
    throw err;
  }
  return report;
}
