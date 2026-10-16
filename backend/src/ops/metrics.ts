import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Chỉ số vận hành trong bộ nhớ tiến trình (không cần thư viện ngoài):
 *  - HTTP: số request theo nhóm mã trạng thái, độ trễ (p50/p95/p99 trong 5 phút gần nhất)
 *  - Event loop: độ trễ p99 (đo bằng perf_hooks)
 *  - Nghiệp vụ: lệnh đặt / huỷ / khớp, kết nối realtime, nhịp vòng lặp thị trường
 * Mỗi phút lưu 1 mẫu (giữ 3 giờ) cho biểu đồ ở trang Quản trị → Giám sát.
 */

const WINDOW_MS = 5 * 60_000;

export interface MetricSample {
  t: number;
  rps: number;
  p95: number;
  errors: number;
  eventLoopMs: number;
  rssMb: number;
  sockets: number;
  dbMs: number | null;
  fills: number;
}

class Metrics {
  readonly startedAt = Date.now();
  http = { total: 0, byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number> };
  /** [thời điểm, ms, có lỗi 5xx] trong cửa sổ 5 phút */
  private lat: [number, number, boolean][] = [];
  orders = { placed: 0, cancelled: 0, rejected: 0, fills: 0, fillValue: 0 };
  private fillsInMinute = 0;
  lastTickAt = 0;
  dbPingMs: number | null = null;
  dbOk = true;
  socketCount: () => number = () => 0;
  readonly series: MetricSample[] = [];
  private eld = monitorEventLoopDelay({ resolution: 20 });
  private sampler: NodeJS.Timeout | null = null;
  private lastEventLoopMs = 0;

  constructor() {
    this.eld.enable();
  }

  /** Middleware đo mọi request /api */
  http_ = (req: Request, res: Response, next: NextFunction) => {
    if (!req.originalUrl.startsWith('/api') || req.originalUrl.startsWith('/api/metrics')) return next();
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const cls = `${Math.floor(res.statusCode / 100)}xx`;
      this.http.total++;
      this.http.byClass[cls] = (this.http.byClass[cls] ?? 0) + 1;
      this.lat.push([Date.now(), ms, res.statusCode >= 500]);
      if (this.lat.length > 50_000) this.lat.splice(0, this.lat.length - 50_000);
    });
    next();
  };

  recordFill(value: number) {
    this.orders.fills++;
    this.orders.fillValue += value;
    this.fillsInMinute++;
  }

  private trim(now = Date.now()) {
    const cut = now - WINDOW_MS;
    let i = 0;
    while (i < this.lat.length && this.lat[i][0] < cut) i++;
    if (i) this.lat.splice(0, i);
  }

  /** Thống kê HTTP trong 5 phút gần nhất */
  window() {
    this.trim();
    const ms = this.lat.map((x) => x[1]).sort((a, b) => a - b);
    const q = (p: number) => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : 0);
    const errors = this.lat.filter((x) => x[2]).length;
    return { requests: ms.length, rps: ms.length / (WINDOW_MS / 1000), p50: q(0.5), p95: q(0.95), p99: q(0.99), errors, errorRate: ms.length ? errors / ms.length : 0 };
  }

  /** Độ trễ event loop p99 (ms) từ lần đọc trước */
  eventLoopP99(): number {
    const v = this.eld.percentile(99) / 1e6;
    this.eld.reset();
    this.lastEventLoopMs = Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
    return this.lastEventLoopMs;
  }

  get eventLoopMs() {
    return this.lastEventLoopMs;
  }

  startSampling() {
    if (this.sampler) return;
    this.sampler = setInterval(() => this.sample(), 60_000);
    this.sampler.unref?.();
  }

  stopSampling() {
    if (this.sampler) clearInterval(this.sampler);
    this.sampler = null;
  }

  sample(now = Date.now()): MetricSample {
    const w = this.window();
    const s: MetricSample = {
      t: now,
      rps: Math.round(w.rps * 100) / 100,
      p95: Math.round(w.p95),
      errors: w.errors,
      eventLoopMs: this.lastEventLoopMs,
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
      sockets: this.socketCount(),
      dbMs: this.dbPingMs,
      fills: this.fillsInMinute,
    };
    this.fillsInMinute = 0;
    this.series.push(s);
    if (this.series.length > 180) this.series.shift();
    return s;
  }

  /** Định dạng Prometheus */
  prometheus(extra: Record<string, number>): string {
    const w = this.window();
    const mem = process.memoryUsage();
    const lines: string[] = [];
    const g = (name: string, help: string, v: number, type = 'gauge', labels = '') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}${labels} ${v}`);
    };
    lines.push('# HELP vnstock_http_requests_total Số request API theo nhóm mã trạng thái', '# TYPE vnstock_http_requests_total counter');
    for (const [cls, n] of Object.entries(this.http.byClass)) lines.push(`vnstock_http_requests_total{class="${cls}"} ${n}`);
    g('vnstock_http_latency_p95_ms', 'Độ trễ API p95 trong 5 phút (ms)', Math.round(w.p95));
    g('vnstock_http_latency_p99_ms', 'Độ trễ API p99 trong 5 phút (ms)', Math.round(w.p99));
    g('vnstock_http_error_rate', 'Tỷ lệ lỗi 5xx trong 5 phút', Math.round(w.errorRate * 10_000) / 10_000);
    g('vnstock_event_loop_p99_ms', 'Độ trễ event loop p99 (ms)', this.lastEventLoopMs);
    g('vnstock_process_rss_bytes', 'Bộ nhớ tiến trình (RSS)', mem.rss);
    g('vnstock_process_heap_used_bytes', 'Heap đang dùng', mem.heapUsed);
    g('vnstock_uptime_seconds', 'Thời gian chạy', Math.round(process.uptime()));
    g('vnstock_socket_connections', 'Kết nối realtime đang mở', this.socketCount());
    g('vnstock_db_ping_ms', 'Thời gian ping CSDL (ms)', this.dbPingMs ?? -1);
    g('vnstock_db_up', 'CSDL phản hồi (1/0)', this.dbOk ? 1 : 0);
    g('vnstock_orders_placed_total', 'Số lệnh đã đặt', this.orders.placed, 'counter');
    g('vnstock_orders_cancelled_total', 'Số lệnh đã huỷ', this.orders.cancelled, 'counter');
    g('vnstock_fills_total', 'Số lần khớp lệnh', this.orders.fills, 'counter');
    g('vnstock_fill_value_total', 'Tổng giá trị khớp (VNĐ)', this.orders.fillValue, 'counter');
    g('vnstock_market_tick_age_seconds', 'Số giây từ nhịp thị trường gần nhất', this.lastTickAt ? Math.round((Date.now() - this.lastTickAt) / 1000) : -1);
    for (const [k, v] of Object.entries(extra)) g(`vnstock_${k}`, k, v);
    return `${lines.join('\n')}\n`;
  }
}

/** Một bộ chỉ số dùng chung cho cả tiến trình */
export const metrics = new Metrics();
