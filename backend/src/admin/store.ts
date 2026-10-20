import {
  RULES,
  applyAmlRules,
  applyP2PRules,
  applyVipRules,
  applyRules,
  applySquareRules,
  type SquareRulesPatch,
  type AmlRulesPatch,
  type EmergencyHalt,
  type P2PRulesPatch,
  type RulesPatch,
  type TradingRules,
  type VipRulesPatch,
} from '@vss/shared';
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
const KEY_P2P_RULES = 'admin.p2pRules';
const KEY_AML_RULES = 'admin.amlRules';
const KEY_VIP_RULES = 'admin.vipRules';
const KEY_SQUARE_RULES = 'admin.squareRules';

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
  /** Tham số P2P quản trị viên đã chỉnh so với mặc định */
  p2pRulesPatch: P2PRulesPatch = {};
  /** Ngưỡng cảnh báo AML bộ phận Tuân thủ đã chỉnh */
  amlRulesPatch: AmlRulesPatch = {};
  /** Hệ số ngưỡng cấp VIP Vận hành thị trường đã chỉnh */
  vipRulesPatch: VipRulesPatch = {};
  /** Bộ lọc / thang phạt Cộng đồng Kiểm duyệt nội dung đã chỉnh */
  squareRulesPatch: SquareRulesPatch = {};
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
    this.p2pRulesPatch = (get(KEY_P2P_RULES) as P2PRulesPatch | undefined) ?? {};
    applyP2PRules(this.p2pRulesPatch);
    this.amlRulesPatch = (get(KEY_AML_RULES) as AmlRulesPatch | undefined) ?? {};
    applyAmlRules(this.amlRulesPatch);
    this.vipRulesPatch = (get(KEY_VIP_RULES) as VipRulesPatch | undefined) ?? {};
    applyVipRules(this.vipRulesPatch);
    this.squareRulesPatch = (get(KEY_SQUARE_RULES) as SquareRulesPatch | undefined) ?? {};
    applySquareRules(this.squareRulesPatch);

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

  /** Chỉnh tham số P2P: tỷ giá tham chiếu, phí thương nhân, tiền cọc, điều kiện (null = khôi phục mặc định) */
  async setP2PRules(patch: P2PRulesPatch | null) {
    const next = patch == null ? {} : { ...this.p2pRulesPatch, ...patch };
    applyP2PRules(next);
    this.p2pRulesPatch = next;
    await this.save(KEY_P2P_RULES, next);
  }

  /** Chỉnh ngưỡng cảnh báo AML (null = khôi phục mặc định) */
  async setAmlRules(patch: AmlRulesPatch | null) {
    const next = patch == null ? {} : { ...this.amlRulesPatch, ...patch };
    applyAmlRules(next);
    this.amlRulesPatch = next;
    await this.save(KEY_AML_RULES, next);
  }

  /** Chỉnh hệ số ngưỡng cấp VIP (null = khôi phục mặc định) */
  async setVipRules(patch: VipRulesPatch | null) {
    const next = patch == null ? {} : { ...this.vipRulesPatch, ...patch };
    applyVipRules(next);
    this.vipRulesPatch = next;
    await this.save(KEY_VIP_RULES, next);
  }

  /** Chỉnh bộ lọc / thang phạt Cộng đồng (null = khôi phục mặc định) */
  async setSquareRules(patch: SquareRulesPatch | null) {
    const next = patch == null ? {} : { ...this.squareRulesPatch, ...patch };
    applySquareRules(next);
    this.squareRulesPatch = next;
    await this.save(KEY_SQUARE_RULES, next);
  }
}
