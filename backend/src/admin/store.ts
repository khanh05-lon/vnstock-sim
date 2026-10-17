import { RULES, applyRules, type EmergencyHalt, type RulesPatch, type TradingRules } from '@vss/shared';
import type { Queryable } from '../db';
import type { SpotEngine } from '../trading/engine';

/** Thông báo hệ thống hiển thị cho mọi người dùng */
export interface Announcement {
  text: string;
  level: 'info' | 'warning' | 'critical';
  updatedAt: string;
}

/** Trạng thái vận hành công khai (gửi cho mọi trình duyệt) */
export interface SystemStatus {
  announcement: Announcement | null;
  tradingHalted: boolean;
  haltReason: string;
  haltedSymbols: string[];
  /** Đang bảo trì (vd. khôi phục dữ liệu): API tạm từ chối mọi thao tác */
  maintenance: string | null;
  /** Đang dừng khẩn chưa được xác nhận: thời điểm tự mở lại (ISO) */
  emergencyUntil: string | null;
  /** Biểu phí và tham số sàn đang áp dụng — giao diện dùng để tính trước */
  rules: TradingRules;
}

const KEY_HALT = 'admin.halt';
const KEY_SYMBOLS = 'admin.halted_symbols';
const KEY_ANNOUNCEMENT = 'admin.announcement';
const KEY_RULES = 'admin.rules';

/**
 * Cấu hình vận hành do quản trị viên đặt, lưu trong bảng market_meta (key → JSON)
 * và giữ bản sao trong bộ nhớ để kiểm tra nhanh ở mỗi request.
 */
export class AdminStore {
  /** userId của tài khoản đang bị khoá — kiểm tra O(1) ở mọi request đã đăng nhập */
  readonly locked = new Set<string>();
  announcement: Announcement | null = null;
  /** Các tham số quản trị viên đã chỉnh so với mặc định */
  rulesPatch: RulesPatch = {};
  /** Lý do bảo trì (chỉ trong bộ nhớ — khởi động lại là hết) */
  maintenance: string | null = null;
  /** Dừng khẩn toàn sàn do 1 người, chưa có người thứ hai xác nhận (null = không có / đã xác nhận) */
  emergency: EmergencyHalt | null = null;

  constructor(
    private db: Queryable,
    private engine: SpotEngine,
  ) {}

  async load() {
    const meta = await this.db.many<{ key: string; value: unknown }>('SELECT key, value FROM market_meta WHERE key LIKE $1', ['admin.%']);
    const get = (k: string) => meta.find((m) => m.key === k)?.value;
    const halt = get(KEY_HALT) as { halted?: boolean; reason?: string; emergency?: EmergencyHalt | null } | undefined;
    this.engine.control.haltAll = !!halt?.halted;
    this.engine.control.haltReason = halt?.reason ?? '';
    this.emergency = halt?.halted ? (halt.emergency ?? null) : null;
    this.engine.control.haltedSymbols.clear();
    for (const s of (get(KEY_SYMBOLS) as string[] | undefined) ?? []) this.engine.control.haltedSymbols.add(s);
    this.announcement = (get(KEY_ANNOUNCEMENT) as Announcement | undefined) ?? null;
    this.rulesPatch = (get(KEY_RULES) as RulesPatch | undefined) ?? {};
    applyRules(this.rulesPatch);

    this.locked.clear();
    for (const r of await this.db.many<{ id: string }>(`SELECT id FROM users WHERE status = 'LOCKED'`)) this.locked.add(r.id);
  }

  status(): SystemStatus {
    return {
      announcement: this.announcement,
      tradingHalted: this.engine.control.haltAll,
      haltReason: this.engine.control.haltReason,
      haltedSymbols: [...this.engine.control.haltedSymbols].sort(),
      maintenance: this.maintenance,
      emergencyUntil: this.emergency?.expiresAt ?? null,
      rules: JSON.parse(JSON.stringify(RULES)),
    };
  }

  private async save(key: string, value: unknown) {
    await this.db.many(
      `INSERT INTO market_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  /** emergency: dừng khẩn chưa xác nhận (tự mở lại khi quá hạn); null = tạm ngừng chính thức hoặc mở lại */
  async setHalt(halted: boolean, reason: string, emergency: EmergencyHalt | null = null) {
    this.engine.control.haltAll = halted;
    this.engine.control.haltReason = halted ? reason : '';
    this.emergency = halted ? emergency : null;
    await this.save(KEY_HALT, { halted, reason: this.engine.control.haltReason, emergency: this.emergency });
  }

  async setSymbolHalt(symbol: string, halted: boolean) {
    if (halted) this.engine.control.haltedSymbols.add(symbol);
    else this.engine.control.haltedSymbols.delete(symbol);
    await this.save(KEY_SYMBOLS, [...this.engine.control.haltedSymbols]);
  }

  async setAnnouncement(a: Announcement | null) {
    this.announcement = a;
    await this.save(KEY_ANNOUNCEMENT, a);
  }

  /** Chỉnh biểu phí / vốn ban đầu (null = khôi phục mặc định) */
  async setRules(patch: RulesPatch | null) {
    const next = patch == null ? {} : { ...this.rulesPatch, ...patch };
    applyRules(next);
    this.rulesPatch = next;
    await this.save(KEY_RULES, next);
  }
}
