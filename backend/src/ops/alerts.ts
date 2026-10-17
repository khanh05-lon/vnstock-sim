import type { Database } from '../db';
import { alertEmail } from '../lib/emails';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { metrics } from './metrics';

export type AlertLevel = 'warning' | 'critical';

export interface AlertState {
  id: number;
  key: string;
  level: AlertLevel;
  title: string;
  detail: string;
  since: string;
}

interface Verdict {
  firing: boolean;
  detail: string;
}

interface Rule {
  key: string;
  level: AlertLevel;
  title: string;
  /** Bật ngay ở lần kiểm tra đầu tiên (mặc định phải đúng 2 lần liên tiếp để tránh báo nhầm) */
  immediate?: boolean;
  check(ctx: CheckContext): Verdict;
}

interface CheckContext {
  now: number;
  dbOk: boolean;
  dbMs: number | null;
  http: ReturnType<typeof metrics.window>;
  eventLoopMs: number;
  rssMb: number;
}

export interface AlertOptions {
  emails: string[];
  webhookUrl: string;
  thresholds: { eventLoopMs: number; p95Ms: number; rssMb: number; dbSlowMs: number; errorRate: number };
  /** true khi đang trong giờ giao dịch và nguồn giá thật được kỳ vọng hoạt động nhưng đang chạy giả lập */
  feedLost?: () => boolean;
  /** Số yêu cầu hỗ trợ khách hàng đã quá hạn trả lời (số liệu cache, cập nhật định kỳ) */
  supportOverdue?: () => number;
}

/**
 * Tự kiểm tra sức khoẻ hệ thống 30 giây/lần. Cảnh báo mới / đã hết được ghi vào bảng system_alerts
 * và gửi tới email ALERT_EMAILS + webhook ALERT_WEBHOOK_URL (Slack, Discord, Telegram...).
 */
export class AlertMonitor {
  readonly active = new Map<string, AlertState>();
  private streak = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  onChange: () => void = () => undefined;
  readonly rules: Rule[];

  constructor(
    private db: Database,
    private mailer: Mailer,
    private opts: AlertOptions,
  ) {
    const t = opts.thresholds;
    this.rules = [
      { key: 'db_down', level: 'critical', title: 'Mất kết nối cơ sở dữ liệu', immediate: true, check: (c) => ({ firing: !c.dbOk, detail: 'CSDL không phản hồi trong 3 giây' }) },
      {
        key: 'db_slow',
        level: 'warning',
        title: 'Cơ sở dữ liệu phản hồi chậm',
        check: (c) => ({ firing: c.dbOk && c.dbMs != null && c.dbMs > t.dbSlowMs, detail: `Ping CSDL ${c.dbMs} ms (ngưỡng ${t.dbSlowMs} ms)` }),
      },
      {
        key: 'event_loop',
        level: 'warning',
        title: 'Máy chủ bị nghẽn (event loop chậm)',
        check: (c) => ({ firing: c.eventLoopMs > t.eventLoopMs, detail: `Độ trễ event loop p99 ${c.eventLoopMs} ms (ngưỡng ${t.eventLoopMs} ms)` }),
      },
      {
        key: 'http_errors',
        level: 'warning',
        title: 'Tỷ lệ lỗi máy chủ (5xx) cao',
        check: (c) => ({
          firing: c.http.requests >= 20 && c.http.errorRate > t.errorRate,
          detail: `${c.http.errors}/${c.http.requests} request lỗi 5xx trong 5 phút (${(c.http.errorRate * 100).toFixed(1)}%)`,
        }),
      },
      {
        key: 'http_slow',
        level: 'warning',
        title: 'API phản hồi chậm',
        check: (c) => ({ firing: c.http.requests >= 20 && c.http.p95 > t.p95Ms, detail: `p95 = ${Math.round(c.http.p95)} ms trong 5 phút (ngưỡng ${t.p95Ms} ms)` }),
      },
      { key: 'memory', level: 'warning', title: 'Bộ nhớ tiến trình cao', check: (c) => ({ firing: c.rssMb > t.rssMb, detail: `RSS ${c.rssMb} MB (ngưỡng ${t.rssMb} MB)` }) },
      {
        key: 'market_stalled',
        level: 'critical',
        title: 'Vòng lặp thị trường ngừng chạy',
        check: (c) => {
          const age = metrics.lastTickAt ? (c.now - metrics.lastTickAt) / 1000 : 0;
          return { firing: age > 30, detail: `Không có nhịp cập nhật giá trong ${Math.round(age)} giây` };
        },
      },
      {
        key: 'feed_lost',
        level: 'warning',
        title: 'Mất nguồn giá Binance (đang chạy giả lập)',
        check: () => ({ firing: !!opts.feedLost?.(), detail: 'Không nhận được dữ liệu từ luồng Binance, bảng giá và khớp lệnh đang dùng giá giả lập' }),
      },
      {
        key: 'support_overdue',
        level: 'warning',
        title: 'Yêu cầu hỗ trợ khách hàng quá hạn trả lời',
        check: () => {
          const n = opts.supportOverdue?.() ?? 0;
          return { firing: n > 0, detail: `${n} yêu cầu hỗ trợ đã quá hạn trả lời khách (xem khu vực CSKH)` };
        },
      },
    ];
  }

  start(everyMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref?.();
    void this.loadActive();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Nạp lại cảnh báo chưa xử lý từ lần chạy trước */
  async loadActive() {
    const rows = await this.db.many<{ id: number; key: string; level: AlertLevel; title: string; detail: string; started_at: Date }>(
      'SELECT id, key, level, title, detail, started_at FROM system_alerts WHERE resolved_at IS NULL',
    );
    for (const r of rows) this.active.set(r.key, { id: r.id, key: r.key, level: r.level, title: r.title, detail: r.detail, since: new Date(r.started_at).toISOString() });
  }

  async ping(): Promise<{ ok: boolean; ms: number | null }> {
    const t0 = Date.now();
    const ok = await Promise.race([
      this.db.one('SELECT 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((r) => setTimeout(r, 3000, false)),
    ]);
    const ms = ok ? Date.now() - t0 : null;
    metrics.dbOk = ok;
    metrics.dbPingMs = ms;
    return { ok, ms };
  }

  async check(now = Date.now()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const db = await this.ping();
      const ctx: CheckContext = {
        now,
        dbOk: db.ok,
        dbMs: db.ms,
        http: metrics.window(),
        eventLoopMs: metrics.eventLoopP99(),
        rssMb: Math.round(process.memoryUsage().rss / 1e6),
      };
      for (const rule of this.rules) {
        const v = rule.check(ctx);
        const prev = this.streak.get(rule.key) ?? 0;
        // streak > 0: số lần liên tiếp đang lỗi; < 0: số lần liên tiếp đã ổn
        const streak = v.firing ? Math.max(1, prev + 1) : Math.min(-1, prev - 1);
        this.streak.set(rule.key, streak);
        const active = this.active.get(rule.key);
        if (v.firing && !active && (rule.immediate || streak >= 2)) await this.fire(rule, v.detail);
        else if (v.firing && active) active.detail = v.detail;
        else if (!v.firing && active && streak <= -2) await this.resolve(rule.key);
      }
    } catch (err) {
      log.error('[alert] lỗi khi kiểm tra sức khoẻ', { err });
    } finally {
      this.checking = false;
    }
  }

  private async fire(rule: Rule, detail: string) {
    let id = 0;
    try {
      const row = await this.db.one<{ id: number }>('INSERT INTO system_alerts (key, level, title, detail) VALUES ($1,$2,$3,$4) RETURNING id', [rule.key, rule.level, rule.title, detail]);
      id = row?.id ?? 0;
    } catch {
      /* CSDL đang lỗi: vẫn gửi cảnh báo */
    }
    const state: AlertState = { id, key: rule.key, level: rule.level, title: rule.title, detail, since: new Date().toISOString() };
    this.active.set(rule.key, state);
    log.warn(`[alert] ${rule.level.toUpperCase()}: ${rule.title}`, { detail });
    const sent = await this.notify(rule.level, rule.title, detail, false);
    if (id && sent) await this.db.many('UPDATE system_alerts SET notified = true WHERE id = $1', [id]).catch(() => undefined);
    this.onChange();
  }

  private async resolve(key: string) {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    if (a.id) await this.db.many('UPDATE system_alerts SET resolved_at = now() WHERE id = $1', [a.id]).catch(() => undefined);
    log.info(`[alert] đã hết: ${a.title}`);
    await this.notify(a.level, a.title, a.detail, true);
    this.onChange();
  }

  /** Gửi tới email + webhook; trả true nếu có ít nhất 1 kênh gửi thành công */
  async notify(level: string, title: string, detail: string, resolved: boolean): Promise<boolean> {
    let ok = false;
    const mail = alertEmail(level, title, detail, resolved);
    for (const to of this.opts.emails) {
      try {
        await this.mailer.send({ to, ...mail });
        ok = true;
      } catch (err) {
        log.error('[alert] gửi email cảnh báo thất bại', { err, to });
      }
    }
    if (this.opts.webhookUrl) {
      const text = `${resolved ? '✅ ĐÃ XỬ LÝ' : level === 'critical' ? '🔴 NGHIÊM TRỌNG' : '🟠 CẢNH BÁO'} — VNStock Sim: ${title}\n${detail}`;
      try {
        const res = await fetch(this.opts.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // "text" cho Slack / Telegram, "content" cho Discord
          body: JSON.stringify({ text, content: text, level, title, detail, resolved }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ok = true;
      } catch (err) {
        log.error('[alert] gửi webhook cảnh báo thất bại', { err });
      }
    }
    return ok;
  }

  channels() {
    return { emails: this.opts.emails, webhook: this.opts.webhookUrl ? this.opts.webhookUrl.replace(/(bot)[^/]+/, '$1***').replace(/\?.*$/, '?…') : null };
  }

  async history(limit = 50) {
    return this.db.many('SELECT * FROM system_alerts ORDER BY id DESC LIMIT $1', [limit]);
  }
}
