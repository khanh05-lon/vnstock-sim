import type { Router } from 'express';
import { z } from 'zod';
import { Big, type FeeRevenueReport, type ReconIssue, type ReconRunDTO } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { reconIssuesEmail } from '../lib/emails';
import { ah } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { audit, need, type AdminDeps, type AdminRequest } from './common';
import { notifyStaff } from './notify';

/** Lệch nhỏ hơn mức này coi là bằng (làm tròn NUMERIC 18 chữ số lẻ) */
const EPS = new Big('1e-12');
/** Lưu tối đa chừng này lỗi chi tiết mỗi lần chạy */
const MAX_ISSUES = 500;

interface RunRow {
  id: number | string;
  started_at: Date;
  finished_at: Date;
  ok: boolean;
  balances_checked: number;
  issue_count: number;
  issues: ReconIssue[];
  triggered_by: string;
}

const toDTO = (r: RunRow): ReconRunDTO => ({
  id: Number(r.id),
  startedAt: new Date(r.started_at).toISOString(),
  finishedAt: new Date(r.finished_at).toISOString(),
  ok: r.ok,
  balancesChecked: r.balances_checked,
  issues: r.issues ?? [],
  issueCount: r.issue_count,
  triggeredBy: r.triggered_by,
});

const differs = (a: string | null, b: string | null) => new Big(a ?? 0).minus(b ?? 0).abs().gt(EPS);

/**
 * Đối soát số dư ↔ sổ cái ↔ khớp lệnh. Sổ cái ghi mọi biến động tổng số dư (cấp vốn, khớp, phí, điều chỉnh);
 * khoá tiền cho lệnh chỉ chuyển free → locked nên không đổi tổng. Vì vậy với mỗi (người dùng, tài sản):
 *   tổng sổ cái = free + locked = số dư sau dòng sổ cái cuối.
 * Lệch → có chỗ cộng / trừ tiền không ghi sổ (lỗi bộ khớp lệnh, sửa tay CSDL...).
 */
export async function runReconciliation(db: Queryable, triggeredBy: string): Promise<ReconRunDTO> {
  const startedAt = new Date();
  const issues: ReconIssue[] = [];
  const rows = await db.many<{ user_id: string; email: string; asset: string; total: string; ledger_sum: string; last_after: string | null }>(
    `WITH l AS (SELECT user_id, asset, sum(amount) AS s FROM ledger GROUP BY user_id, asset),
          last AS (SELECT DISTINCT ON (user_id, asset) user_id, asset, balance_after FROM ledger ORDER BY user_id, asset, id DESC)
     SELECT b.user_id::text AS user_id, u.email, b.asset, (b.free + b.locked)::text AS total,
            COALESCE(l.s, 0)::text AS ledger_sum, last.balance_after::text AS last_after
     FROM balances b JOIN users u ON u.id = b.user_id
     LEFT JOIN l ON l.user_id = b.user_id AND l.asset = b.asset
     LEFT JOIN last ON last.user_id = b.user_id AND last.asset = b.asset`,
  );
  for (const r of rows) {
    if (differs(r.ledger_sum, r.total)) {
      issues.push({ kind: 'LEDGER_MISMATCH', userId: r.user_id, email: r.email, asset: r.asset, expected: r.ledger_sum, actual: r.total });
    }
    if (r.last_after != null && differs(r.last_after, r.total)) {
      issues.push({ kind: 'LAST_BALANCE_MISMATCH', userId: r.user_id, email: r.email, asset: r.asset, expected: r.last_after, actual: r.total });
    }
  }
  // Sổ cái có tài sản mà bảng số dư không có dòng
  const orphan = await db.many<{ user_id: string; email: string; asset: string; s: string }>(
    `SELECT l.user_id::text AS user_id, u.email, l.asset, sum(l.amount)::text AS s FROM ledger l JOIN users u ON u.id = l.user_id
     WHERE NOT EXISTS (SELECT 1 FROM balances b WHERE b.user_id = l.user_id AND b.asset = l.asset)
     GROUP BY l.user_id, u.email, l.asset HAVING abs(sum(l.amount)) > 0.000000000001`,
  );
  for (const o of orphan) issues.push({ kind: 'LEDGER_MISMATCH', userId: o.user_id, email: o.email, asset: o.asset, expected: o.s, actual: '0' });

  // Số dư khoá = tổng mọi nguồn khoá: lệnh Spot đang mở, quảng cáo bán P2P, coin ký quỹ của đơn P2P đang chạy, tiền cọc thương nhân
  const locked = await db.many<{ user_id: string; email: string; asset: string; locked: string; expected: string }>(
    `WITH src AS (
       SELECT user_id, locked_asset AS asset, locked_amount AS amt FROM orders WHERE status IN ('NEW', 'PARTIALLY_FILLED')
       UNION ALL SELECT merchant_id, asset, locked_amount FROM p2p_ads WHERE status <> 'CLOSED'
       UNION ALL SELECT seller_id, asset, escrow_amount FROM p2p_orders WHERE status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL')
       UNION ALL SELECT user_id, 'USDT', deposit_usdt FROM p2p_merchants
     ), exp AS (SELECT user_id, asset, sum(amt) AS s FROM src GROUP BY user_id, asset)
     SELECT b.user_id::text AS user_id, u.email, b.asset, b.locked::text AS locked, COALESCE(exp.s, 0)::text AS expected
     FROM balances b JOIN users u ON u.id = b.user_id
     LEFT JOIN exp ON exp.user_id = b.user_id AND exp.asset = b.asset
     WHERE abs(b.locked - COALESCE(exp.s, 0)) > 0.000000000001`,
  );
  for (const l of locked) {
    const kind = new Big(l.expected).eq(0) ? 'LOCKED_WITHOUT_ORDERS' : 'LOCKED_MISMATCH';
    issues.push({ kind, userId: l.user_id, email: l.email, asset: l.asset, expected: l.expected, actual: l.locked });
  }

  // Phí: tổng phí ghi sổ cái = tổng phí trong bảng khớp lệnh (theo tài sản trả phí)
  const fees = await db.many<{ asset: string; ledger_fee: string; fill_fee: string }>(
    `WITH lf AS (SELECT asset, -sum(amount) AS s FROM ledger WHERE type = 'FEE' GROUP BY asset),
          ff AS (SELECT asset, sum(s) AS s FROM (
                   SELECT commission_asset AS asset, sum(commission) AS s FROM fills GROUP BY commission_asset
                   UNION ALL SELECT asset, sum(fee) FROM p2p_orders WHERE status = 'COMPLETED' GROUP BY asset
                 ) x GROUP BY asset)
     SELECT COALESCE(lf.asset, ff.asset) AS asset, COALESCE(lf.s, 0)::text AS ledger_fee, COALESCE(ff.s, 0)::text AS fill_fee
     FROM lf FULL OUTER JOIN ff ON ff.asset = lf.asset`,
  );
  for (const f of fees) {
    if (differs(f.ledger_fee, f.fill_fee)) issues.push({ kind: 'FEE_MISMATCH', asset: f.asset, expected: f.fill_fee, actual: f.ledger_fee });
  }

  // Ngân hàng giả lập: số dư = tổng nhận − tổng chuyển
  const bank = await db.many<{ user_id: string; email: string; balance: string; flows: string }>(
    `WITH f AS (
       SELECT to_user AS uid, amount AS a FROM bank_transfers WHERE to_user IS NOT NULL
       UNION ALL SELECT from_user, -amount FROM bank_transfers WHERE from_user IS NOT NULL
     ), s AS (SELECT uid, sum(a) AS s FROM f GROUP BY uid)
     SELECT b.user_id::text AS user_id, u.email, b.balance_vnd::text AS balance, COALESCE(s.s, 0)::text AS flows
     FROM bank_accounts b JOIN users u ON u.id = b.user_id LEFT JOIN s ON s.uid = b.user_id
     WHERE b.balance_vnd <> COALESCE(s.s, 0)`,
  );
  for (const b of bank) issues.push({ kind: 'BANK_MISMATCH', userId: b.user_id, email: b.email, asset: 'VND', expected: b.flows, actual: b.balance });

  const row = await db.one<RunRow>(
    `INSERT INTO reconciliation_runs (started_at, finished_at, ok, balances_checked, issue_count, issues, triggered_by)
     VALUES ($1, now(), $2, $3, $4, $5::jsonb, $6) RETURNING *`,
    [startedAt, issues.length === 0, rows.length, issues.length, JSON.stringify(issues.slice(0, MAX_ISSUES)), triggeredBy],
  );
  return toDTO(row!);
}

/** Báo cáo doanh thu phí: theo ngày (UTC) và theo cặp trong `days` ngày gần nhất */
export async function feeRevenue(db: Queryable, days: number): Promise<FeeRevenueReport> {
  const since = `now() - make_interval(days => $1::int)`;
  const byDay = await db.many<{ day: string; fills: number; volume: string; fee: string; maker: string; taker: string }>(
    `SELECT (executed_at AT TIME ZONE 'UTC')::date::text AS day, count(*)::int AS fills,
            COALESCE(sum(quote_qty), 0)::text AS volume, COALESCE(sum(commission_usdt), 0)::text AS fee,
            COALESCE(sum(commission_usdt) FILTER (WHERE is_maker), 0)::text AS maker,
            COALESCE(sum(commission_usdt) FILTER (WHERE NOT is_maker), 0)::text AS taker
     FROM fills WHERE executed_at > ${since} GROUP BY 1 ORDER BY 1 DESC`,
    [days],
  );
  const bySymbol = await db.many<{ symbol: string; fills: number; volume: string; fee: string }>(
    `SELECT symbol, count(*)::int AS fills, COALESCE(sum(quote_qty), 0)::text AS volume, COALESCE(sum(commission_usdt), 0)::text AS fee
     FROM fills WHERE executed_at > ${since} GROUP BY symbol ORDER BY sum(commission_usdt) DESC LIMIT 30`,
    [days],
  );
  const sum = (xs: string[]) => xs.reduce((a, x) => a.plus(x), new Big(0)).toFixed();
  return {
    days: byDay.map((d) => ({ day: d.day, fills: d.fills, volumeUsdt: d.volume, feeUsdt: d.fee, makerFeeUsdt: d.maker, takerFeeUsdt: d.taker })),
    bySymbol: bySymbol.map((x) => ({ symbol: x.symbol, fills: x.fills, volumeUsdt: x.volume, feeUsdt: x.fee })),
    totalFeeUsdt: sum(byDay.map((d) => d.fee)),
    totalVolumeUsdt: sum(byDay.map((d) => d.volume)),
  };
}

/** Lệch → email Tài chính + Kiểm toán (người có quyền finance.view) */
async function alertIfIssues(db: Queryable, mailer: Mailer | undefined, run: ReconRunDTO) {
  if (run.ok) return;
  log.warn('[reconcile] đối soát phát hiện lệch', { runId: run.id, issues: run.issueCount });
  await notifyStaff(db, mailer, 'finance.view', [], (name) => reconIssuesEmail(name, run), { runId: run.id }).catch(() => undefined);
}

export function mountReconcile(r: Router, deps: AdminDeps) {
  const { db, mailer } = deps;

  r.get(
    '/finance/revenue',
    need('finance.view'),
    ah(async (req, res) => {
      const { days } = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }).parse(req.query);
      res.json(await feeRevenue(db, days));
    }),
  );

  r.get(
    '/finance/reconciliations',
    need('finance.view'),
    ah(async (_req, res) => {
      const rows = await db.many<RunRow>('SELECT * FROM reconciliation_runs ORDER BY id DESC LIMIT 30');
      res.json(rows.map(toDTO));
    }),
  );

  /** Chạy đối soát ngay (ngoài lịch hằng ngày) */
  r.post(
    '/finance/reconciliations',
    need('finance.view'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const run = await runReconciliation(db, admin.email);
      await audit(db, admin, 'RECONCILE_RUN', 'system', null, { runId: run.id, ok: run.ok, issues: run.issueCount });
      await alertIfIssues(db, mailer, run);
      res.json(run);
    }),
  );
}

/** Lịch đối soát tự động: mỗi giờ kiểm tra, lần chạy gần nhất quá 24 giờ thì chạy (giữ được qua khởi động lại) */
export function startReconcileSchedule(db: Database, mailer: Mailer | undefined): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const last = await db.one<{ at: Date }>('SELECT max(started_at) AS at FROM reconciliation_runs');
      if (last?.at && Date.now() - new Date(last.at).getTime() < 24 * 60 * 60_000) return;
      const run = await runReconciliation(db, 'Hệ thống (hằng ngày)');
      log.info('[reconcile] đối soát hằng ngày xong', { runId: run.id, ok: run.ok, balances: run.balancesChecked, issues: run.issueCount });
      await alertIfIssues(db, mailer, run);
    } catch (err) {
      log.error('[reconcile] lỗi đối soát hằng ngày', { err });
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 60_000);
  const timer = setInterval(() => void tick(), 60 * 60_000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
