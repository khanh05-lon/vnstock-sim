import { MAX_ACTIVE_ALERTS, type PriceAlertDTO, type PriceAlertInput, type PriceAlertKind, type PriceAlertStatus } from '@vss/shared';
import type { Database } from '../db';
import { priceAlertEmail } from '../lib/emails';
import { badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';

export interface AlertMarket {
  info(symbol: string): unknown;
  quote(symbol: string): { last: number; ref: number; volume: number } | undefined;
}

export interface AlertRow {
  id: number;
  user_id: string;
  symbol: string;
  kind: PriceAlertKind;
  value: number;
  note: string | null;
  notify_email: boolean;
  status: PriceAlertStatus;
  triggered_price: number | null;
  triggered_at: Date | null;
  created_at: Date;
}

const isChange = (k: PriceAlertKind) => k === 'CHANGE_UP' || k === 'CHANGE_DOWN';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function toPriceAlertDTO(r: AlertRow): PriceAlertDTO {
  return {
    id: Number(r.id),
    symbol: r.symbol,
    kind: r.kind,
    // % thay đổi lưu dạng phần vạn (350 = 3,5%)
    value: isChange(r.kind) ? Number(r.value) / 100 : Number(r.value),
    note: r.note,
    notifyEmail: r.notify_email,
    status: r.status,
    triggeredPrice: r.triggered_price == null ? null : Number(r.triggered_price),
    triggeredAt: r.triggered_at ? new Date(r.triggered_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** Mô tả điều kiện cho thông báo / email: "Giá khớp ≥ 98,500đ", "Tăng ≥ 3.5%" */
export function describeAlert(kind: PriceAlertKind, value: number): string {
  if (kind === 'PRICE_ABOVE') return `Giá khớp ≥ ${fmt(value)}đ`;
  if (kind === 'PRICE_BELOW') return `Giá khớp ≤ ${fmt(value)}đ`;
  if (kind === 'CHANGE_UP') return `Tăng ≥ ${value}% so với tham chiếu`;
  if (kind === 'CHANGE_DOWN') return `Giảm ≥ ${value}% so với tham chiếu`;
  return `Tổng khối lượng ≥ ${fmt(value)} CP`;
}

/** Điều kiện đang thoả với giá hiện tại? (value đã ở dạng lưu trong CSDL) */
function satisfied(kind: PriceAlertKind, stored: number, q: { last: number; ref: number; volume: number }): boolean {
  if (kind === 'VOLUME_ABOVE') return q.volume >= stored;
  if (q.volume <= 0 || q.last <= 0) return false; // chưa có giao dịch trong phiên
  if (kind === 'PRICE_ABOVE') return q.last >= stored;
  if (kind === 'PRICE_BELOW') return q.last <= stored;
  const bp = ((q.last - q.ref) / q.ref) * 10_000;
  return kind === 'CHANGE_UP' ? bp >= stored : -bp >= stored;
}

/**
 * Cảnh báo giá: người dùng đặt ngưỡng giá / % thay đổi / khối lượng; mỗi nhịp thị trường kiểm tra các mã có cảnh báo,
 * thoả điều kiện thì báo realtime (và email nếu chọn) rồi dừng — mỗi cảnh báo chỉ báo 1 lần.
 */
export class PriceAlertService {
  notify: (userId: string, alert: PriceAlertDTO, message: string) => void = () => undefined;
  private active = new Map<string, Map<number, AlertRow>>();

  constructor(
    private db: Database,
    private market: AlertMarket,
    private mailer: Mailer | null = null,
  ) {}

  async load() {
    this.active.clear();
    const rows = await this.db.many<AlertRow>(`SELECT * FROM price_alerts WHERE status = 'ACTIVE'`);
    for (const r of rows) this.track(r);
  }

  private track(r: AlertRow) {
    let m = this.active.get(r.symbol);
    if (r.status !== 'ACTIVE') {
      m?.delete(Number(r.id));
      return;
    }
    if (!m) this.active.set(r.symbol, (m = new Map()));
    m.set(Number(r.id), r);
  }

  async list(userId: string, scope: 'active' | 'all' = 'all', symbol?: string): Promise<PriceAlertDTO[]> {
    const rows = await this.db.many<AlertRow>(
      `SELECT * FROM price_alerts WHERE user_id = $1 ${scope === 'active' ? `AND status = 'ACTIVE'` : ''} ${symbol ? 'AND symbol = $2' : ''}
       ORDER BY (status = 'ACTIVE') DESC, created_at DESC LIMIT 200`,
      symbol ? [userId, symbol] : [userId],
    );
    return rows.map(toPriceAlertDTO);
  }

  async create(userId: string, input: PriceAlertInput): Promise<PriceAlertDTO> {
    if (!this.market.info(input.symbol)) throw badRequest('SYMBOL', `Mã ${input.symbol} không tồn tại`);
    const q = this.market.quote(input.symbol);
    const stored = isChange(input.kind) ? Math.round(input.value * 100) : Math.round(input.value);
    if (stored <= 0) throw badRequest('VALUE', 'Giá trị phải lớn hơn 0');
    // Cảnh báo thoả ngay lúc tạo thì vô nghĩa (báo tức thì) → từ chối, kèm giá hiện tại để người dùng chỉnh
    if (q) {
      const now = { ...q, last: q.volume > 0 && q.last > 0 ? q.last : q.ref, volume: q.volume > 0 ? q.volume : input.kind === 'VOLUME_ABOVE' ? 0 : 1 };
      if (satisfied(input.kind, stored, now)) {
        const cur =
          input.kind === 'VOLUME_ABOVE'
            ? `tổng khối lượng hiện tại ${fmt(q.volume)} CP`
            : isChange(input.kind)
              ? `đang ${now.last >= q.ref ? 'tăng' : 'giảm'} ${Math.abs(((now.last - q.ref) / q.ref) * 100).toFixed(2)}%`
              : `giá hiện tại ${fmt(now.last)}đ`;
        throw badRequest('ALREADY_MET', `Điều kiện "${describeAlert(input.kind, input.value)}" đã thoả ngay bây giờ (${cur})`);
      }
    }
    const row = await this.db.tx(async (tx) => {
      const n = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM price_alerts WHERE user_id = $1 AND status = 'ACTIVE'`, [userId]);
      if ((n?.n ?? 0) >= MAX_ACTIVE_ALERTS) throw badRequest('LIMIT', `Tối đa ${MAX_ACTIVE_ALERTS} cảnh báo đang theo dõi`);
      return tx.one<AlertRow>(
        `INSERT INTO price_alerts (user_id, symbol, kind, value, note, notify_email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [userId, input.symbol, input.kind, stored, input.note || null, input.notifyEmail ?? false],
      );
    });
    this.track(row!);
    return toPriceAlertDTO(row!);
  }

  async cancel(userId: string, id: number): Promise<PriceAlertDTO> {
    const row = await this.db.one<AlertRow>(
      `UPDATE price_alerts SET status = 'CANCELLED' WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE' RETURNING *`,
      [id, userId],
    );
    if (!row) {
      const exists = await this.db.one('SELECT 1 FROM price_alerts WHERE id = $1 AND user_id = $2', [id, userId]);
      if (!exists) throw notFound('Không tìm thấy cảnh báo');
      throw badRequest('NOT_ACTIVE', 'Cảnh báo đã báo hoặc đã huỷ');
    }
    this.track(row);
    return toPriceAlertDTO(row);
  }

  /** Mã bị rút khỏi giao dịch (huỷ niêm yết, đáo hạn): huỷ cảnh báo đang theo dõi của mã đó */
  async cancelMissingSymbols(): Promise<number> {
    const gone = [...this.active.keys()].filter((s) => !this.market.info(s));
    let n = 0;
    for (const s of gone) {
      const rows = await this.db.many<AlertRow>(`UPDATE price_alerts SET status = 'CANCELLED', note = COALESCE(note || ' · ', '') || 'mã ngừng giao dịch' WHERE symbol = $1 AND status = 'ACTIVE' RETURNING *`, [s]);
      this.active.delete(s);
      n += rows.length;
    }
    return n;
  }

  /** Mỗi nhịp thị trường: kiểm tra cảnh báo của các mã vừa thay đổi */
  async onTick(symbols: Iterable<string>) {
    for (const sym of symbols) {
      const book = this.active.get(sym);
      if (!book?.size) continue;
      const q = this.market.quote(sym);
      if (!q) continue;
      for (const r of [...book.values()]) {
        if (satisfied(r.kind, Number(r.value), q)) await this.trigger(r, q.last);
      }
    }
  }

  private async trigger(r: AlertRow, price: number) {
    const row = await this.db.one<AlertRow & { email: string; full_name: string }>(
      `WITH t AS (UPDATE price_alerts SET status = 'TRIGGERED', triggered_price = $2, triggered_at = now() WHERE id = $1 AND status = 'ACTIVE' RETURNING *)
       SELECT t.*, u.email, u.full_name FROM t JOIN users u ON u.id = t.user_id`,
      [r.id, price],
    );
    this.active.get(r.symbol)?.delete(Number(r.id));
    if (!row) return;
    const dto = toPriceAlertDTO(row);
    const condition = describeAlert(dto.kind, dto.value);
    const message = `${row.symbol}: ${condition} — giá khớp ${fmt(price)}đ`;
    this.notify(row.user_id, dto, message);
    if (row.notify_email && this.mailer) {
      const detail = `Giá khớp lúc báo: ${fmt(price)}đ${row.note ? ` · Ghi chú của bạn: ${row.note}` : ''}.`;
      void this.mailer
        .send({ to: row.email, ...priceAlertEmail(row.full_name, row.symbol, condition, detail) })
        .catch((err) => log.error('[alert] gửi email cảnh báo giá thất bại', { err, id: row.id }));
    }
  }
}

