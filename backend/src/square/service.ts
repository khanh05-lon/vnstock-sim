import crypto from 'node:crypto';
import {
  Big,
  MOD_RULE_LABEL,
  SQUARE_RULES,
  foldVi,
  isStaff,
  moderateName,
  moderateText,
  parseTags,
  strikePenaltyHours,
  type Dec,
  type ModHit,
  type ModRule,
  type ModerationExtra,
  type SquareAppealStatus,
  type SquareAuthorDTO,
  type SquareCommentDTO,
  type SquareConfigDTO,
  type SquareFeedDTO,
  type SquareMeDTO,
  type SquareModUserDTO,
  type SquareNotificationDTO,
  type SquareNotificationKind,
  type SquarePostDTO,
  type SquarePostInput,
  type SquareProfileDTO,
  type SquareProfileInput,
  type SquareQueueItemDTO,
  type SquareRemovedInfo,
  type SquareReportReason,
  type SquareSentiment,
  type SquareShareDTO,
  type SquareStatus,
  type SquareStrikeDTO,
  type SquareTargetType,
  type SquareTrendDTO,
} from '@vss/shared';
import type { Database, Queryable } from '../db';
import { AppError, badRequest, notFound } from '../lib/errors';

/* =====================================================================================
 * Cộng đồng VNCoin (kiểu Binance Square). Nghiệp vụ: docs/CONG-DONG.md
 * - Đăng / bình luận: qua postingGate (khách, email đã xác thực, tài khoản đủ tuổi, có hồ sơ, không bị cấm)
 *   rồi bộ lọc moderateText: BLOCK → 400, REVIEW → PENDING (chỉ tác giả thấy), ALLOW → PUBLISHED.
 * - Báo cáo: đủ SQUARE_RULES.autoHideReports người khác nhau → tự ẩn về PENDING chờ kiểm duyệt.
 * - Gỡ nội dung có vi phạm → square_strikes + thang phạt (strikePenaltyHours).
 * ===================================================================================== */

export interface SquareMarket {
  /** Coin đang niêm yết (tài sản cơ sở của các cặp) */
  listedAssets(): string[];
  /** Cặp USDT của coin (vd. BTC → BTCUSDT) nếu có */
  lastPrice(symbol: string): Dec | null;
}

export interface SquareDeps {
  db: Database;
  market: SquareMarket;
  /** ROI từ đầu (%) của người dùng, null nếu chưa có dữ liệu */
  roiOf(userId: string): Promise<number | null>;
  /** Báo realtime cho người dùng (sự kiện `square`) */
  notify?(userId: string): void;
  /** Gửi email quyết định kiểm duyệt */
  emailUser?(userId: string, title: string, lines: string[]): Promise<void>;
}

export interface ModCtx {
  id: string;
  email: string;
}

type Kind = 'POST' | 'COMMENT';

interface PostRow {
  id: number;
  user_id: string;
  body: string;
  sentiment: SquareSentiment | null;
  assets: string[];
  hashtags: string[];
  share: SquareShareDTO | null;
  status: SquareStatus;
  mod_hits: ModHit[];
  like_count: number;
  comment_count: number;
  removed_by: string | null;
  removed_rule: ModRule | null;
  removed_note: string | null;
  removed_at: Date | null;
  appeal_note: string | null;
  appeal_at: Date | null;
  appeal_status: SquareAppealStatus | null;
  created_at: Date;
  handle: string;
  display_name: string;
  liked?: boolean;
}

interface CommentRow {
  id: number;
  post_id: number;
  user_id: string;
  parent_id: number | null;
  body: string;
  status: SquareStatus;
  mod_hits: ModHit[];
  removed_by: string | null;
  removed_rule: ModRule | null;
  removed_note: string | null;
  removed_at: Date | null;
  appeal_note: string | null;
  appeal_at: Date | null;
  appeal_status: SquareAppealStatus | null;
  created_at: Date;
  handle: string;
  display_name: string;
}

interface ProfileRow {
  user_id: string;
  handle: string;
  display_name: string;
  bio: string;
  banned_until: Date | null;
  ban_permanent: boolean;
  ban_reason: string | null;
  created_at: Date;
}

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const forbidden = (code: string, message: string) => new AppError(403, code, message);
const tooMany = (message: string) => new AppError(429, 'RATE_LIMIT', message);
const PAGE = 20;

const POST_COLS = `p.*, sp.handle, sp.display_name`;
const POST_FROM = `square_posts p JOIN square_profiles sp ON sp.user_id = p.user_id`;
const COMMENT_FROM = `square_comments c JOIN square_profiles sp ON sp.user_id = c.user_id`;

/** Từ điển + tên miền quản trị thêm (chỉ BE) */
export const moderationExtra = (): ModerationExtra => ({
  blockWords: SQUARE_RULES.extraBlockWords,
  reviewWords: SQUARE_RULES.extraReviewWords,
  allowedDomains: SQUARE_RULES.allowedDomains,
});

const fmtTime = (d: Date) => d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });

export class SquareService {
  private db: Database;
  /** Lần bị bộ lọc chặn gần đây theo người dùng (chống thử từ ngữ liên tục) */
  private blocked = new Map<string, number[]>();
  private cooldownUntil = new Map<string, number>();

  constructor(private deps: SquareDeps) {
    this.db = deps.db;
  }

  config(): SquareConfigDTO {
    const r = SQUARE_RULES;
    return {
      allowedDomains: r.allowedDomains,
      minAccountAgeHours: r.minAccountAgeHours,
      postsPerHour: r.postsPerHour,
      postsPerDay: r.postsPerDay,
      commentsPerHour: r.commentsPerHour,
      maxTags: 5,
      strikeExpiryDays: r.strikeExpiryDays,
      strikeBanHours: r.strikeBanHours,
      autoHideReports: r.autoHideReports,
      assets: this.deps.market.listedAssets(),
    };
  }

  /* ------------------------------ điều kiện ------------------------------ */

  private async profileOf(q: Queryable, userId: string) {
    return q.one<ProfileRow>('SELECT * FROM square_profiles WHERE user_id = $1', [userId]);
  }

  private banText(p: ProfileRow): string | null {
    if (p.ban_permanent) return 'Bạn đã bị cấm vĩnh viễn đăng bài và bình luận trong Cộng đồng';
    if (p.banned_until && new Date(p.banned_until).getTime() > Date.now())
      return `Bạn đang bị cấm đăng bài và bình luận tới ${fmtTime(new Date(p.banned_until))}${p.ban_reason ? ` (${p.ban_reason})` : ''}`;
    return null;
  }

  /** Lý do chưa được đăng (null = đăng được) */
  private async postingBlock(userId: string, needProfile = true): Promise<{ code: string; message: string } | null> {
    const u = await this.db.one<{ role: string; status: string; email_verified_at: Date | null; created_at: Date }>(
      'SELECT role, status, email_verified_at, created_at FROM users WHERE id = $1',
      [userId],
    );
    if (!u || u.status !== 'ACTIVE') return { code: 'ACCOUNT', message: 'Tài khoản không hoạt động' };
    if (isStaff(u.role)) return { code: 'STAFF', message: 'Tài khoản nhân viên chỉ được đọc Cộng đồng, không đăng / bình luận / tương tác' };
    if (!u.email_verified_at) return { code: 'EMAIL_UNVERIFIED', message: 'Xác thực email để tham gia Cộng đồng' };
    const ageH = (Date.now() - new Date(u.created_at).getTime()) / 3_600_000;
    if (ageH < SQUARE_RULES.minAccountAgeHours)
      return { code: 'ACCOUNT_TOO_NEW', message: `Tài khoản mới cần ${SQUARE_RULES.minAccountAgeHours} giờ trước khi đăng bài (chống tài khoản rác)` };
    if (!needProfile) return null;
    const p = await this.profileOf(this.db, userId);
    if (!p) return { code: 'NO_PROFILE', message: 'Tạo hồ sơ Cộng đồng trước khi đăng' };
    const ban = this.banText(p);
    if (ban) return { code: 'SQUARE_BANNED', message: ban };
    const cd = this.cooldownUntil.get(userId);
    if (cd && cd > Date.now())
      return { code: 'SQUARE_COOLDOWN', message: `Nội dung bị chặn nhiều lần liên tiếp, tạm khoá đăng tới ${fmtTime(new Date(cd))}` };
    return null;
  }

  private async gate(userId: string) {
    const b = await this.postingBlock(userId);
    if (b) throw forbidden(b.code, b.message);
  }

  /** Thích / theo dõi: không cần đang được đăng, chỉ cần là khách có hồ sơ */
  private async gateInteract(userId: string) {
    const b = await this.postingBlock(userId, false);
    if (b && b.code !== 'ACCOUNT_TOO_NEW') throw forbidden(b.code, b.message);
    if (!(await this.profileOf(this.db, userId))) throw forbidden('NO_PROFILE', 'Tạo hồ sơ Cộng đồng trước');
  }

  /** Chạy bộ lọc; BLOCK thì đếm lần bị chặn và ném lỗi */
  private screen(userId: string, text: string, what: string) {
    const r = moderateText(text, moderationExtra());
    if (r.verdict === 'BLOCK') {
      const now = Date.now();
      const list = (this.blocked.get(userId) ?? []).filter((t) => now - t < 3_600_000);
      list.push(now);
      this.blocked.set(userId, list);
      if (list.length >= SQUARE_RULES.blockedAttemptsPerHour) {
        this.cooldownUntil.set(userId, now + SQUARE_RULES.blockedCooldownMinutes * 60_000);
        this.blocked.delete(userId);
      }
      const rules = [...new Set(r.hits.filter((h) => h.action === 'BLOCK').map((h) => h.rule))];
      throw new AppError(400, 'CONTENT_BLOCKED', `${what} vi phạm Tiêu chuẩn cộng đồng: ${rules.map((x) => MOD_RULE_LABEL[x]).join(', ')}`, { rules });
    }
    return r;
  }

  /* ------------------------------ hồ sơ ------------------------------ */

  async me(userId: string): Promise<SquareMeDTO> {
    const p = await this.profileOf(this.db, userId);
    const block = await this.postingBlock(userId);
    const strikes = await this.strikesOf(this.db, userId);
    const unread = await this.db.one<{ n: number }>('SELECT count(*)::int AS n FROM square_notifications WHERE user_id = $1 AND read_at IS NULL', [userId]);
    const active = strikes.filter((s) => !s.revoked && new Date(s.expiresAt).getTime() > Date.now());
    return {
      profile: p ? await this.profileDTO(p, userId) : null,
      canPost: !block,
      blockedReason: block?.message ?? null,
      banUntil: p && !p.ban_permanent && p.banned_until && new Date(p.banned_until).getTime() > Date.now() ? iso(p.banned_until) : null,
      banPermanent: p?.ban_permanent ?? false,
      banReason: p && this.banText(p) ? p.ban_reason : null,
      activeStrikes: active.length,
      strikes: active,
      unread: unread?.n ?? 0,
    };
  }

  private async strikesOf(q: Queryable, userId: string): Promise<(SquareStrikeDTO & { by: string })[]> {
    const rows = await q.many<{ id: number; rule: ModRule; target_type: SquareTargetType; target_id: string | null; by_email: string; created_at: Date; expires_at: Date; revoked_at: Date | null }>(
      'SELECT * FROM square_strikes WHERE user_id = $1 ORDER BY id DESC LIMIT 50',
      [userId],
    );
    return rows.map((s) => ({
      id: s.id,
      rule: s.rule,
      targetType: s.target_type,
      targetId: s.target_id,
      createdAt: iso(s.created_at)!,
      expiresAt: iso(s.expires_at)!,
      revoked: !!s.revoked_at,
      by: s.by_email,
    }));
  }

  private async activeStrikeCount(q: Queryable, userId: string) {
    const r = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM square_strikes WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()', [userId]);
    return r?.n ?? 0;
  }

  private async profileDTO(p: ProfileRow, viewer: string | null): Promise<SquareProfileDTO> {
    const c = await this.db.one<{ followers: number; following: number; posts: number; likes: number; followed: boolean }>(
      `SELECT (SELECT count(*)::int FROM square_follows WHERE followee_id = $1) AS followers,
              (SELECT count(*)::int FROM square_follows WHERE follower_id = $1) AS following,
              (SELECT count(*)::int FROM square_posts WHERE user_id = $1 AND status = 'PUBLISHED') AS posts,
              (SELECT coalesce(sum(like_count), 0)::int FROM square_posts WHERE user_id = $1 AND status = 'PUBLISHED') AS likes,
              EXISTS (SELECT 1 FROM square_follows WHERE follower_id = $2 AND followee_id = $1) AS followed`,
      [p.user_id, viewer],
    );
    return {
      handle: p.handle,
      displayName: p.display_name,
      bio: p.bio,
      joinedAt: iso(p.created_at)!,
      followers: c?.followers ?? 0,
      following: c?.following ?? 0,
      posts: c?.posts ?? 0,
      likesReceived: c?.likes ?? 0,
      followed: c?.followed ?? false,
      isMe: viewer === p.user_id,
      banned: !!this.banText(p),
    };
  }

  async profile(handle: string, viewer: string | null): Promise<SquareProfileDTO> {
    const p = await this.db.one<ProfileRow>('SELECT * FROM square_profiles WHERE handle = $1', [handle.toLowerCase()]);
    if (!p) throw notFound('Không tìm thấy người dùng');
    return this.profileDTO(p, viewer);
  }

  /** Tạo / sửa hồ sơ. Tạo mới phải đồng ý Tiêu chuẩn cộng đồng */
  async saveProfile(userId: string, input: SquareProfileInput): Promise<SquareProfileDTO> {
    const block = await this.postingBlock(userId, false);
    if (block?.code === 'STAFF' || block?.code === 'ACCOUNT') throw forbidden(block.code, block.message);
    const extra = moderationExtra();
    const bad = (label: string, r: ReturnType<typeof moderateName>) => {
      if (r.verdict !== 'ALLOW') throw badRequest('NAME_REJECTED', `${label} không hợp lệ: ${[...new Set(r.hits.map((h) => MOD_RULE_LABEL[h.rule]))].join(', ')}`);
    };
    bad('Tên người dùng', moderateName(input.handle, extra));
    bad('Tên hiển thị', moderateName(input.displayName, extra));
    if (input.bio) {
      const r = moderateText(input.bio, extra);
      if (r.verdict !== 'ALLOW') throw badRequest('NAME_REJECTED', `Giới thiệu không hợp lệ: ${[...new Set(r.hits.map((h) => MOD_RULE_LABEL[h.rule]))].join(', ')}`);
    }
    const cur = await this.profileOf(this.db, userId);
    if (!cur && !input.acceptGuidelines) throw badRequest('GUIDELINES', 'Bạn cần đồng ý Tiêu chuẩn cộng đồng');
    const taken = await this.db.one('SELECT 1 FROM square_profiles WHERE handle = $1 AND user_id <> $2', [input.handle, userId]);
    if (taken) throw badRequest('HANDLE_TAKEN', 'Tên người dùng đã có người dùng');
    const row = cur
      ? await this.db.one<ProfileRow>('UPDATE square_profiles SET handle = $2, display_name = $3, bio = $4 WHERE user_id = $1 RETURNING *', [
          userId,
          input.handle,
          input.displayName,
          input.bio,
        ])
      : await this.db.one<ProfileRow>(
          'INSERT INTO square_profiles (user_id, handle, display_name, bio, guidelines_accepted_at) VALUES ($1, $2, $3, $4, now()) RETURNING *',
          [userId, input.handle, input.displayName, input.bio],
        );
    return this.profileDTO(row!, userId);
  }

  /* ------------------------------ bài viết ------------------------------ */

  private removedInfo(r: { status: SquareStatus; removed_rule: ModRule | null; removed_note: string | null; removed_at: Date | null; appeal_status: SquareAppealStatus | null }): SquareRemovedInfo | undefined {
    if (r.status !== 'REMOVED') return undefined;
    return {
      rule: r.removed_rule ?? 'CUSTOM',
      note: r.removed_note,
      at: iso(r.removed_at) ?? new Date().toISOString(),
      appealStatus: r.appeal_status,
      canAppeal: !r.appeal_status,
    };
  }

  private toPost(r: PostRow, viewer: string | null): SquarePostDTO {
    const mine = viewer === r.user_id;
    return {
      id: r.id,
      author: { handle: r.handle, displayName: r.display_name },
      body: r.body,
      sentiment: r.sentiment,
      assets: r.assets ?? [],
      hashtags: r.hashtags ?? [],
      share: r.share,
      status: r.status,
      createdAt: iso(r.created_at)!,
      likeCount: r.like_count,
      commentCount: r.comment_count,
      liked: !!r.liked,
      mine,
      ...(mine && r.status !== 'PUBLISHED' && { hits: r.mod_hits, removed: this.removedInfo(r) }),
    };
  }

  private likedCol(viewerParam: string) {
    return `EXISTS (SELECT 1 FROM square_likes l WHERE l.post_id = p.id AND l.user_id = ${viewerParam}) AS liked`;
  }

  private async rate(sql: string, params: unknown[], max: number, message: string) {
    const r = await this.db.one<{ n: number }>(sql, params);
    if ((r?.n ?? 0) >= max) throw tooMany(message);
  }

  private async buildShare(userId: string, share: SquarePostInput['share']): Promise<SquareShareDTO | null> {
    if (!share) return null;
    if (share.type === 'ROI') {
      const roi = await this.deps.roiOf(userId);
      if (roi == null) throw badRequest('SHARE_ROI', 'Chưa có dữ liệu ROI để chia sẻ (cần ít nhất 1 lệnh khớp)');
      return { type: 'ROI', returnPct: Math.round(roi * 100) / 100, at: new Date().toISOString() };
    }
    const o = await this.db.one<{ symbol: string; side: 'BUY' | 'SELL'; type: string; executed_qty: string; cumm_quote_qty: string; updated_at: Date; base_asset: string }>(
      `SELECT o.symbol, o.side, o.type, o.executed_qty, o.cumm_quote_qty, o.updated_at, s.base_asset
       FROM orders o JOIN symbols s ON s.symbol = o.symbol WHERE o.id = $1 AND o.user_id = $2 AND o.executed_qty > 0`,
      [share.orderId, userId],
    );
    if (!o) throw badRequest('SHARE_ORDER', 'Chỉ chia sẻ được lệnh đã khớp của chính bạn');
    const avg = new Big(o.cumm_quote_qty).div(o.executed_qty);
    const now = this.deps.market.lastPrice(o.symbol);
    if (!now) throw badRequest('SHARE_ORDER', 'Chưa có giá thị trường của cặp này');
    const diff = new Big(now).minus(avg).div(avg).times(100);
    const pnl = Number((o.side === 'BUY' ? diff : diff.neg()).toFixed(2));
    return {
      type: 'ORDER',
      symbol: o.symbol,
      base: o.base_asset,
      side: o.side,
      orderType: o.type,
      avgPrice: avg.toFixed(8).replace(/\.?0+$/, ''),
      priceAtShare: new Big(now).toFixed(),
      pnlPct: pnl,
      filledAt: iso(o.updated_at)!,
    };
  }

  async createPost(userId: string, input: SquarePostInput): Promise<SquarePostDTO> {
    await this.gate(userId);
    await this.rate(
      `SELECT count(*)::int AS n FROM square_posts WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId],
      SQUARE_RULES.postsPerHour,
      `Tối đa ${SQUARE_RULES.postsPerHour} bài / giờ`,
    );
    await this.rate(
      `SELECT count(*)::int AS n FROM square_posts WHERE user_id = $1 AND created_at > now() - interval '1 day'`,
      [userId],
      SQUARE_RULES.postsPerDay,
      `Tối đa ${SQUARE_RULES.postsPerDay} bài / ngày`,
    );
    const r = this.screen(userId, input.body, 'Bài viết');
    const hits = [...r.hits];
    const hash = crypto.createHash('sha256').update(foldVi(input.body).replace(/\s+/g, ' ').trim()).digest('hex');
    const dup = await this.db.one(
      `SELECT 1 FROM square_posts WHERE user_id = $1 AND body_hash = $2 AND status <> 'DELETED' AND created_at > now() - interval '1 day'`,
      [userId, hash],
    );
    if (dup && !hits.some((h) => h.rule === 'SPAM')) hits.push({ rule: 'SPAM', action: 'REVIEW', excerpt: 'Trùng bài đã đăng trong 24 giờ' });
    const listed = new Set(this.deps.market.listedAssets());
    const tags = parseTags(input.body);
    const assets = tags.cashtags.filter((a) => listed.has(a)).slice(0, 5);
    const share = await this.buildShare(userId, input.share ?? null);
    if (share?.type === 'ORDER' && !assets.includes(share.base)) assets.unshift(share.base);
    const status: SquareStatus = hits.length ? 'PENDING' : 'PUBLISHED';
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO square_posts (user_id, body, sentiment, assets, hashtags, share, status, mod_hits, body_hash)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9) RETURNING id`,
      [userId, input.body, input.sentiment ?? null, assets.slice(0, 5), tags.hashtags.slice(0, 5), share ? JSON.stringify(share) : null, status, JSON.stringify(hits), hash],
    );
    return this.post(row!.id, userId);
  }

  /** Chi tiết bài: công khai nếu đã đăng; tác giả xem được cả bài chờ duyệt / bị gỡ */
  async post(id: number, viewer: string | null): Promise<SquarePostDTO> {
    const r = await this.db.one<PostRow>(`SELECT ${POST_COLS}, ${this.likedCol('$2')} FROM ${POST_FROM} WHERE p.id = $1`, [id, viewer]);
    if (!r || r.status === 'DELETED' || (r.status !== 'PUBLISHED' && r.user_id !== viewer)) throw notFound('Bài viết không tồn tại hoặc đã bị gỡ');
    return this.toPost(r, viewer);
  }

  async deletePost(userId: string, id: number) {
    const r = await this.db.one<{ id: number }>(
      `UPDATE square_posts SET status = 'DELETED' WHERE id = $1 AND user_id = $2 AND status <> 'DELETED' RETURNING id`,
      [id, userId],
    );
    if (!r) throw notFound('Không tìm thấy bài viết của bạn');
  }

  async feed(
    viewer: string | null,
    f: { tab: 'foryou' | 'latest' | 'following'; coin?: string; tag?: string; before?: string; author?: string },
  ): Promise<SquareFeedDTO> {
    const params: unknown[] = [viewer];
    const where: string[] = [];
    let authorId: string | null = null;
    if (f.author) {
      const p = await this.db.one<{ user_id: string }>('SELECT user_id FROM square_profiles WHERE handle = $1', [f.author.toLowerCase()]);
      if (!p) return { posts: [], next: null };
      authorId = p.user_id;
      params.push(authorId);
      where.push(`p.user_id = $${params.length}`);
      // Chính chủ xem được cả bài chờ duyệt / bị gỡ của mình trên trang cá nhân
      where.push(authorId === viewer ? `p.status IN ('PUBLISHED', 'PENDING', 'REMOVED')` : `p.status = 'PUBLISHED'`);
    } else where.push(`p.status = 'PUBLISHED'`);
    if (f.coin) {
      params.push(f.coin.toUpperCase());
      where.push(`$${params.length} = ANY (p.assets)`);
    }
    if (f.tag) {
      params.push(f.tag.toLowerCase());
      where.push(`$${params.length} = ANY (p.hashtags)`);
    }
    if (f.tab === 'following' && !authorId) {
      if (!viewer) return { posts: [], next: null };
      where.push(`(p.user_id IN (SELECT followee_id FROM square_follows WHERE follower_id = $1) OR p.user_id = $1)`);
    }
    if (f.tab === 'foryou' && !authorId && !f.coin && !f.tag) {
      const page = Math.max(0, Number(f.before ?? 0) || 0);
      params.push(PAGE + 1, page * PAGE);
      const rows = await this.db.many<PostRow>(
        `SELECT ${POST_COLS}, ${this.likedCol('$1')} FROM ${POST_FROM}
         WHERE ${where.join(' AND ')} AND p.created_at > now() - interval '7 days'
         ORDER BY (p.like_count * 2 + p.comment_count * 3 + 1) / power(extract(epoch FROM now() - p.created_at) / 3600 + 2, 1.5) DESC, p.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );
      const more = rows.length > PAGE;
      return { posts: rows.slice(0, PAGE).map((r) => this.toPost(r, viewer)), next: more ? String(page + 1) : null };
    }
    const before = Number(f.before ?? 0);
    if (before > 0) {
      params.push(before);
      where.push(`p.id < $${params.length}`);
    }
    params.push(PAGE + 1);
    const rows = await this.db.many<PostRow>(
      `SELECT ${POST_COLS}, ${this.likedCol('$1')} FROM ${POST_FROM} WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT $${params.length}`,
      params,
    );
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    return { posts: page.map((r) => this.toPost(r, viewer)), next: more ? String(page[page.length - 1]!.id) : null };
  }

  /* ------------------------------ thích / theo dõi ------------------------------ */

  async like(userId: string, postId: number, on: boolean) {
    await this.gateInteract(userId);
    const p = await this.db.one<{ user_id: string; status: string }>('SELECT user_id, status FROM square_posts WHERE id = $1', [postId]);
    if (!p || p.status !== 'PUBLISHED') throw notFound('Bài viết không tồn tại hoặc đã bị gỡ');
    const changed = await this.db.tx(async (tx) => {
      const r = on
        ? await tx.one('INSERT INTO square_likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING post_id', [userId, postId])
        : await tx.one('DELETE FROM square_likes WHERE user_id = $1 AND post_id = $2 RETURNING post_id', [userId, postId]);
      if (r) await tx.many(`UPDATE square_posts SET like_count = GREATEST(like_count ${on ? '+' : '-'} 1, 0) WHERE id = $1`, [postId]);
      return !!r;
    });
    if (changed && on && p.user_id !== userId) await this.notifyUser(this.db, p.user_id, 'LIKE', { actorId: userId, postId });
    const c = await this.db.one<{ like_count: number }>('SELECT like_count FROM square_posts WHERE id = $1', [postId]);
    return { liked: on, likeCount: c?.like_count ?? 0 };
  }

  async follow(userId: string, handle: string, on: boolean) {
    await this.gateInteract(userId);
    const p = await this.db.one<{ user_id: string }>('SELECT user_id FROM square_profiles WHERE handle = $1', [handle.toLowerCase()]);
    if (!p) throw notFound('Không tìm thấy người dùng');
    if (p.user_id === userId) throw badRequest('SELF', 'Không tự theo dõi chính mình');
    const r = on
      ? await this.db.one('INSERT INTO square_follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING follower_id', [userId, p.user_id])
      : await this.db.one('DELETE FROM square_follows WHERE follower_id = $1 AND followee_id = $2 RETURNING follower_id', [userId, p.user_id]);
    if (r && on) await this.notifyUser(this.db, p.user_id, 'FOLLOW', { actorId: userId });
    return { followed: on };
  }

  /* ------------------------------ bình luận ------------------------------ */

  private toComment(r: CommentRow, viewer: string | null): SquareCommentDTO {
    const mine = viewer === r.user_id;
    return {
      id: r.id,
      postId: r.post_id,
      parentId: r.parent_id,
      author: { handle: r.handle, displayName: r.display_name },
      body: r.body,
      status: r.status,
      createdAt: iso(r.created_at)!,
      mine,
      ...(mine && r.status === 'REMOVED' && { removed: this.removedInfo(r) }),
    };
  }

  async comments(postId: number, viewer: string | null): Promise<SquareCommentDTO[]> {
    await this.post(postId, viewer);
    const rows = await this.db.many<CommentRow>(
      `SELECT c.*, sp.handle, sp.display_name FROM ${COMMENT_FROM}
       WHERE c.post_id = $1 AND (c.status = 'PUBLISHED' OR (c.user_id = $2 AND c.status IN ('PENDING', 'REMOVED')))
       ORDER BY c.id LIMIT 500`,
      [postId, viewer],
    );
    return rows.map((r) => this.toComment(r, viewer));
  }

  async comment(userId: string, postId: number, input: { body: string; parentId?: number | null }): Promise<SquareCommentDTO> {
    await this.gate(userId);
    await this.rate(
      `SELECT count(*)::int AS n FROM square_comments WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
      [userId],
      SQUARE_RULES.commentsPerHour,
      `Tối đa ${SQUARE_RULES.commentsPerHour} bình luận / giờ`,
    );
    const post = await this.db.one<{ user_id: string; status: string }>('SELECT user_id, status FROM square_posts WHERE id = $1', [postId]);
    if (!post || post.status !== 'PUBLISHED') throw notFound('Bài viết không tồn tại hoặc đã bị gỡ');
    let parentId: number | null = null;
    let parentAuthor: string | null = null;
    if (input.parentId) {
      const par = await this.db.one<{ id: number; parent_id: number | null; user_id: string; post_id: number; status: string }>(
        'SELECT id, parent_id, user_id, post_id, status FROM square_comments WHERE id = $1',
        [input.parentId],
      );
      if (!par || par.post_id !== postId || par.status !== 'PUBLISHED') throw badRequest('PARENT', 'Bình luận được trả lời không tồn tại');
      parentId = par.parent_id ?? par.id; // trả lời 1 cấp
      parentAuthor = par.user_id;
    }
    const r = this.screen(userId, input.body, 'Bình luận');
    const status: SquareStatus = r.hits.length ? 'PENDING' : 'PUBLISHED';
    const row = await this.db.tx(async (tx) => {
      const c = await tx.one<{ id: number }>(
        `INSERT INTO square_comments (post_id, user_id, parent_id, body, status, mod_hits) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
        [postId, userId, parentId, input.body, status, JSON.stringify(r.hits)],
      );
      if (status === 'PUBLISHED') await tx.many('UPDATE square_posts SET comment_count = comment_count + 1 WHERE id = $1', [postId]);
      return c!;
    });
    if (status === 'PUBLISHED') await this.announceComment(userId, postId, row.id, post.user_id, parentAuthor);
    const out = await this.db.one<CommentRow>(`SELECT c.*, sp.handle, sp.display_name FROM ${COMMENT_FROM} WHERE c.id = $1`, [row.id]);
    return this.toComment(out!, userId);
  }

  private async announceComment(actor: string, postId: number, commentId: number, postAuthor: string, parentAuthor: string | null) {
    if (parentAuthor && parentAuthor !== actor) await this.notifyUser(this.db, parentAuthor, 'REPLY', { actorId: actor, postId, commentId });
    if (postAuthor !== actor && postAuthor !== parentAuthor) await this.notifyUser(this.db, postAuthor, 'COMMENT', { actorId: actor, postId, commentId });
  }

  async deleteComment(userId: string, id: number) {
    await this.db.tx(async (tx) => {
      const c = await tx.one<{ post_id: number; status: string }>(
        `SELECT post_id, status FROM square_comments WHERE id = $1 AND user_id = $2 AND status <> 'DELETED' FOR UPDATE`,
        [id, userId],
      );
      if (!c) throw notFound('Không tìm thấy bình luận của bạn');
      await tx.many(`UPDATE square_comments SET status = 'DELETED' WHERE id = $1`, [id]);
      if (c.status === 'PUBLISHED') await tx.many('UPDATE square_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [c.post_id]);
    });
  }

  /* ------------------------------ báo cáo / khiếu nại ------------------------------ */

  async report(userId: string, input: { targetType: SquareTargetType; targetId: string; reason: SquareReportReason; note: string }) {
    const u = await this.db.one<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
    if (!u || isStaff(u.role)) throw forbidden('STAFF', 'Nhân viên xử lý nội dung qua khu Kiểm duyệt, không gửi báo cáo');
    await this.rate(
      `SELECT count(*)::int AS n FROM square_reports WHERE reporter_id = $1 AND created_at > now() - interval '1 day'`,
      [userId],
      SQUARE_RULES.reportsPerDay,
      `Tối đa ${SQUARE_RULES.reportsPerDay} báo cáo / ngày`,
    );
    let targetId = input.targetId;
    let owner: string | null = null;
    let status: string | null = null;
    if (input.targetType === 'PROFILE') {
      const p = await this.db.one<{ user_id: string }>('SELECT user_id FROM square_profiles WHERE handle = $1', [input.targetId.toLowerCase().replace(/^@/, '')]);
      owner = p?.user_id ?? null;
      targetId = owner ?? '';
      status = 'PUBLISHED';
    } else {
      const id = Number(input.targetId);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã nội dung không hợp lệ');
      const t = await this.db.one<{ user_id: string; status: string }>(
        `SELECT user_id, status FROM ${input.targetType === 'POST' ? 'square_posts' : 'square_comments'} WHERE id = $1`,
        [id],
      );
      owner = t?.user_id ?? null;
      status = t?.status ?? null;
      targetId = String(id);
    }
    if (!owner || status !== 'PUBLISHED') throw notFound('Nội dung không tồn tại hoặc đã bị gỡ');
    if (owner === userId) throw badRequest('SELF', 'Không báo cáo nội dung của chính mình');
    await this.db.many(
      `INSERT INTO square_reports (target_type, target_id, reporter_id, reason, note) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (target_type, target_id, reporter_id) DO NOTHING`,
      [input.targetType, targetId, userId, input.reason, input.note],
    );
    // Đủ người báo cáo (tài khoản đủ tuổi) → tự ẩn chờ kiểm duyệt
    if (input.targetType !== 'PROFILE') {
      const n = await this.db.one<{ n: number }>(
        `SELECT count(DISTINCT r.reporter_id)::int AS n FROM square_reports r JOIN users u ON u.id = r.reporter_id
         WHERE r.target_type = $1 AND r.target_id = $2 AND r.status = 'OPEN' AND u.created_at < now() - make_interval(days => $3::int)`,
        [input.targetType, targetId, SQUARE_RULES.reporterMinAgeDays],
      );
      if ((n?.n ?? 0) >= SQUARE_RULES.autoHideReports) await this.hide(input.targetType, Number(targetId));
    }
    return { ok: true };
  }

  /** Ẩn nội dung đang hiển thị về PENDING (giữ đếm bình luận đúng) */
  private async hide(type: Kind, id: number) {
    await this.db.tx(async (tx) => {
      if (type === 'POST') {
        await tx.many(`UPDATE square_posts SET status = 'PENDING' WHERE id = $1 AND status = 'PUBLISHED'`, [id]);
        return;
      }
      const c = await tx.one<{ post_id: number }>(`UPDATE square_comments SET status = 'PENDING' WHERE id = $1 AND status = 'PUBLISHED' RETURNING post_id`, [id]);
      if (c) await tx.many('UPDATE square_posts SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = $1', [c.post_id]);
    });
  }

  async appeal(userId: string, type: Kind, id: number, note: string) {
    const table = type === 'POST' ? 'square_posts' : 'square_comments';
    const r = await this.db.one<{ id: number }>(
      `UPDATE ${table} SET appeal_note = $3, appeal_at = now(), appeal_status = 'PENDING'
       WHERE id = $1 AND user_id = $2 AND status = 'REMOVED' AND appeal_status IS NULL RETURNING id`,
      [id, userId, note],
    );
    if (!r) throw badRequest('APPEAL', 'Chỉ khiếu nại được nội dung của bạn đã bị gỡ, mỗi nội dung 1 lần');
    return { ok: true };
  }

  /* ------------------------------ thông báo ------------------------------ */

  async notifyUser(
    q: Queryable,
    userId: string,
    kind: SquareNotificationKind,
    o: { actorId?: string | null; postId?: number | null; commentId?: number | null; detail?: Record<string, unknown> } = {},
  ) {
    await q.many(`INSERT INTO square_notifications (user_id, kind, actor_id, post_id, comment_id, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [
      userId,
      kind,
      o.actorId ?? null,
      o.postId ?? null,
      o.commentId ?? null,
      JSON.stringify(o.detail ?? {}),
    ]);
    this.deps.notify?.(userId);
  }

  async notifications(userId: string, before?: number): Promise<SquareNotificationDTO[]> {
    const rows = await this.db.many<{
      id: number;
      kind: SquareNotificationKind;
      post_id: number | null;
      comment_id: number | null;
      detail: Record<string, unknown>;
      created_at: Date;
      read_at: Date | null;
      handle: string | null;
      display_name: string | null;
    }>(
      `SELECT n.*, sp.handle, sp.display_name FROM square_notifications n LEFT JOIN square_profiles sp ON sp.user_id = n.actor_id
       WHERE n.user_id = $1 AND ($2::bigint IS NULL OR n.id < $2) ORDER BY n.id DESC LIMIT 30`,
      [userId, before ?? null],
    );
    return rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      actor: n.handle ? { handle: n.handle, displayName: n.display_name! } : null,
      postId: n.post_id,
      commentId: n.comment_id,
      detail: n.detail ?? {},
      createdAt: iso(n.created_at)!,
      read: !!n.read_at,
    }));
  }

  async markRead(userId: string) {
    await this.db.many('UPDATE square_notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [userId]);
  }

  /* ------------------------------ xu hướng ------------------------------ */

  async trends(asset?: string): Promise<SquareTrendDTO[]> {
    const rows = await this.db.many<{ asset: string; posts: number; bullish: number; bearish: number }>(
      `SELECT a AS asset, count(*)::int AS posts,
              count(*) FILTER (WHERE sentiment = 'BULLISH')::int AS bullish,
              count(*) FILTER (WHERE sentiment = 'BEARISH')::int AS bearish
       FROM square_posts, unnest(assets) AS a
       WHERE status = 'PUBLISHED' AND created_at > now() - interval '1 day' AND ($1::text IS NULL OR a = $1)
       GROUP BY a ORDER BY posts DESC, a LIMIT 10`,
      [asset?.toUpperCase() ?? null],
    );
    return rows;
  }

  async suggestions(viewer: string | null): Promise<(SquareAuthorDTO & { likes: number; followers: number })[]> {
    return this.db.many(
      `SELECT sp.handle, sp.display_name AS "displayName",
              coalesce(sum(p.like_count), 0)::int AS likes,
              (SELECT count(*)::int FROM square_follows f WHERE f.followee_id = sp.user_id) AS followers
       FROM square_profiles sp JOIN square_posts p ON p.user_id = sp.user_id AND p.status = 'PUBLISHED' AND p.created_at > now() - interval '30 days'
       WHERE ($1::uuid IS NULL OR (sp.user_id <> $1 AND NOT EXISTS (SELECT 1 FROM square_follows f WHERE f.follower_id = $1 AND f.followee_id = sp.user_id)))
         AND sp.ban_permanent = false
       GROUP BY sp.user_id, sp.handle, sp.display_name
       ORDER BY likes DESC, followers DESC LIMIT 5`,
      [viewer],
    );
  }

  /* ================================ KIỂM DUYỆT ================================ */

  private async authorFor(q: Queryable, userId: string) {
    const p = await this.profileOf(q, userId);
    return {
      userId,
      handle: p?.handle ?? '—',
      displayName: p?.display_name ?? '—',
      activeStrikes: await this.activeStrikeCount(q, userId),
      banned: p ? !!this.banText(p) : false,
    };
  }

  private async reportsFor(type: SquareTargetType, ids: string[]) {
    const out = new Map<string, NonNullable<SquareQueueItemDTO['reports']>>();
    if (!ids.length) return out;
    const rows = await this.db.many<{ id: number; target_id: string; reason: SquareReportReason; note: string }>(
      `SELECT id, target_id, reason, note FROM square_reports WHERE target_type = $1 AND target_id = ANY ($2::text[]) AND status = 'OPEN' ORDER BY id`,
      [type, ids],
    );
    for (const r of rows) {
      const cur = out.get(r.target_id) ?? { count: 0, reasons: {}, notes: [], ids: [] };
      cur.count++;
      cur.reasons[r.reason] = (cur.reasons[r.reason] ?? 0) + 1;
      if (r.note) cur.notes.push(r.note);
      cur.ids.push(r.id);
      out.set(r.target_id, cur);
    }
    return out;
  }

  private async queueItems(rows: { type: Kind; r: PostRow | CommentRow }[]): Promise<SquareQueueItemDTO[]> {
    const posts = await this.reportsFor('POST', rows.filter((x) => x.type === 'POST').map((x) => String(x.r.id)));
    const comments = await this.reportsFor('COMMENT', rows.filter((x) => x.type === 'COMMENT').map((x) => String(x.r.id)));
    const out: SquareQueueItemDTO[] = [];
    for (const { type, r } of rows) {
      out.push({
        type,
        id: String(r.id),
        postId: type === 'POST' ? r.id : (r as CommentRow).post_id,
        author: await this.authorFor(this.db, r.user_id),
        body: r.body,
        status: r.status,
        hits: r.mod_hits ?? [],
        createdAt: iso(r.created_at)!,
        reports: (type === 'POST' ? posts : comments).get(String(r.id)) ?? null,
        appeal: r.appeal_status === 'PENDING' ? { note: r.appeal_note ?? '', at: iso(r.appeal_at)!, removedBy: r.removed_by, rule: r.removed_rule, removedNote: r.removed_note } : null,
      });
    }
    return out;
  }

  async queue(view: 'pending' | 'reports' | 'appeals'): Promise<SquareQueueItemDTO[]> {
    const cond =
      view === 'pending'
        ? `x.status = 'PENDING'`
        : view === 'appeals'
          ? `x.appeal_status = 'PENDING'`
          : `x.status = 'PUBLISHED' AND EXISTS (SELECT 1 FROM square_reports r WHERE r.target_type = '%T' AND r.target_id = x.id::text AND r.status = 'OPEN')`;
    const posts = await this.db.many<PostRow>(
      `SELECT x.*, sp.handle, sp.display_name FROM square_posts x JOIN square_profiles sp ON sp.user_id = x.user_id WHERE ${cond.replace('%T', 'POST')} ORDER BY x.id LIMIT 100`,
    );
    const comments = await this.db.many<CommentRow>(
      `SELECT x.*, sp.handle, sp.display_name FROM square_comments x JOIN square_profiles sp ON sp.user_id = x.user_id WHERE ${cond.replace('%T', 'COMMENT')} ORDER BY x.id LIMIT 100`,
    );
    const items = await this.queueItems([...posts.map((r) => ({ type: 'POST' as const, r })), ...comments.map((r) => ({ type: 'COMMENT' as const, r }))]);
    if (view === 'reports') {
      const profiles = await this.db.many<{ target_id: string }>(`SELECT DISTINCT target_id FROM square_reports WHERE target_type = 'PROFILE' AND status = 'OPEN'`);
      const rep = await this.reportsFor('PROFILE', profiles.map((p) => p.target_id));
      for (const { target_id } of profiles) {
        const p = await this.profileOf(this.db, target_id);
        if (!p) continue;
        items.push({
          type: 'PROFILE',
          id: target_id,
          postId: null,
          author: await this.authorFor(this.db, target_id),
          body: `@${p.handle} · ${p.display_name}${p.bio ? `\n${p.bio}` : ''}`,
          status: 'ACTIVE',
          hits: moderateName(`${p.handle} ${p.display_name}`, moderationExtra()).hits,
          createdAt: iso(p.created_at)!,
          reports: rep.get(target_id) ?? null,
          appeal: null,
        });
      }
      items.sort((a, b) => (b.reports?.count ?? 0) - (a.reports?.count ?? 0));
    }
    return items;
  }

  async stats() {
    const r = await this.db.one<{ pending: number; reports: number; appeals: number; posts24h: number; removed24h: number; banned: number }>(
      `SELECT (SELECT count(*)::int FROM square_posts WHERE status = 'PENDING') + (SELECT count(*)::int FROM square_comments WHERE status = 'PENDING') AS pending,
              (SELECT count(DISTINCT (target_type, target_id))::int FROM square_reports WHERE status = 'OPEN') AS reports,
              (SELECT count(*)::int FROM square_posts WHERE appeal_status = 'PENDING') + (SELECT count(*)::int FROM square_comments WHERE appeal_status = 'PENDING') AS appeals,
              (SELECT count(*)::int FROM square_posts WHERE created_at > now() - interval '1 day') AS posts24h,
              (SELECT count(*)::int FROM square_posts WHERE removed_at > now() - interval '1 day') AS removed24h,
              (SELECT count(*)::int FROM square_profiles WHERE ban_permanent OR banned_until > now()) AS banned`,
    );
    return r!;
  }

  private async loadTarget(q: Queryable, type: Kind, id: number, lock = true) {
    const table = type === 'POST' ? 'square_posts' : 'square_comments';
    const r = await q.one<(PostRow | CommentRow) & { post_id?: number }>(`SELECT * FROM ${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    if (!r || r.status === 'DELETED') throw notFound('Không tìm thấy nội dung');
    return { table, r };
  }

  /** Đổi trạng thái hiển thị, giữ comment_count của bài khớp số bình luận đang hiển thị */
  private async setStatus(q: Queryable, type: Kind, row: { id: number; status: SquareStatus; post_id?: number }, status: SquareStatus, extraSql = '', extra: unknown[] = []) {
    const table = type === 'POST' ? 'square_posts' : 'square_comments';
    await q.many(`UPDATE ${table} SET status = $2${extraSql} WHERE id = $1`, [row.id, status, ...extra]);
    if (type === 'COMMENT' && row.post_id) {
      const delta = (status === 'PUBLISHED' ? 1 : 0) - (row.status === 'PUBLISHED' ? 1 : 0);
      if (delta) await q.many('UPDATE square_posts SET comment_count = GREATEST(comment_count + $2, 0) WHERE id = $1', [row.post_id, delta]);
    }
  }

  private async closeReports(q: Queryable, type: SquareTargetType, id: string, mod: ModCtx, status: 'ACTIONED' | 'DISMISSED') {
    await q.many(`UPDATE square_reports SET status = $3, handled_by = $4, handled_at = now() WHERE target_type = $1 AND target_id = $2 AND status = 'OPEN'`, [
      type,
      id,
      status,
      mod.email,
    ]);
  }

  async approve(mod: ModCtx, type: Kind, id: number) {
    const out = await this.db.tx(async (tx) => {
      const { r } = await this.loadTarget(tx, type, id);
      if (r.status !== 'PENDING') throw badRequest('STATUS', 'Nội dung không ở trạng thái chờ duyệt');
      await this.setStatus(tx, type, r, 'PUBLISHED', ', reviewed_by = $3, reviewed_at = now()', [mod.email]);
      await this.closeReports(tx, type, String(id), mod, 'DISMISSED');
      return r;
    });
    const postId = type === 'POST' ? out.id : (out as CommentRow).post_id;
    await this.notifyUser(this.db, out.user_id, 'APPROVED', { postId, commentId: type === 'COMMENT' ? out.id : null });
    if (type === 'COMMENT') {
      // Bình luận vừa được hiển thị: báo chủ bài / người được trả lời như lúc đăng
      const c = out as CommentRow;
      const post = await this.db.one<{ user_id: string }>('SELECT user_id FROM square_posts WHERE id = $1', [c.post_id]);
      const par = c.parent_id ? await this.db.one<{ user_id: string }>('SELECT user_id FROM square_comments WHERE id = $1', [c.parent_id]) : null;
      if (post) await this.announceComment(c.user_id, c.post_id, c.id, post.user_id, par?.user_id ?? null);
    }
    return { userId: out.user_id, postId };
  }

  /** Thêm 1 vi phạm và áp thang phạt. Trả số vi phạm còn hiệu lực + giờ cấm */
  async addStrike(q: Queryable, mod: ModCtx, userId: string, rule: ModRule, targetType: SquareTargetType, targetId: string | null, note: string) {
    await q.many(
      `INSERT INTO square_strikes (user_id, rule, target_type, target_id, by_email, note, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7::int))`,
      [userId, rule, targetType, targetId, mod.email, note, SQUARE_RULES.strikeExpiryDays],
    );
    const count = await this.activeStrikeCount(q, userId);
    const hours = strikePenaltyHours(count);
    let banUntil: Date | null = null;
    if (hours > 0) {
      const p = await q.one<{ banned_until: Date | null }>(
        `UPDATE square_profiles SET banned_until = GREATEST(coalesce(banned_until, now()), now() + make_interval(hours => $2::int)), ban_reason = $3
         WHERE user_id = $1 AND NOT ban_permanent RETURNING banned_until`,
        [userId, hours, `Vi phạm lần ${count}: ${MOD_RULE_LABEL[rule]}`],
      );
      banUntil = p?.banned_until ?? null;
    }
    return { count, hours, banUntil, flagPermanent: count >= SQUARE_RULES.permanentFlagAt };
  }

  async remove(mod: ModCtx, type: Kind, id: number, input: { rule: ModRule; note: string; strike: boolean }) {
    const res = await this.db.tx(async (tx) => {
      const { r } = await this.loadTarget(tx, type, id);
      if (r.status === 'REMOVED') throw badRequest('STATUS', 'Nội dung đã bị gỡ');
      await this.setStatus(
        tx,
        type,
        r,
        'REMOVED',
        ', removed_by = $3, removed_rule = $4, removed_note = $5, removed_at = now(), appeal_status = NULL, appeal_note = NULL, appeal_at = NULL',
        [mod.email, input.rule, input.note],
      );
      await this.closeReports(tx, type, String(id), mod, 'ACTIONED');
      const strike = input.strike ? await this.addStrike(tx, mod, r.user_id, input.rule, type, String(id), input.note) : null;
      return { r, strike };
    });
    const postId = type === 'POST' ? res.r.id : (res.r as CommentRow).post_id;
    await this.notifyUser(this.db, res.r.user_id, 'REMOVED', {
      postId: type === 'POST' ? postId : postId,
      commentId: type === 'COMMENT' ? id : null,
      detail: { rule: input.rule, note: input.note, strike: !!res.strike, strikes: res.strike?.count ?? null, banUntil: iso(res.strike?.banUntil ?? null) },
    });
    const what = type === 'POST' ? 'Bài viết' : 'Bình luận';
    await this.deps.emailUser?.(res.r.user_id, `${what} của bạn đã bị gỡ`, [
      `${what}: "${res.r.body.slice(0, 160)}${res.r.body.length > 160 ? '…' : ''}"`,
      `Lý do: ${MOD_RULE_LABEL[input.rule]} — ${input.note}`,
      ...(res.strike
        ? [
            `Đây là vi phạm thứ ${res.strike.count} còn hiệu lực trong ${SQUARE_RULES.strikeExpiryDays} ngày.`,
            res.strike.banUntil ? `Bạn bị cấm đăng bài và bình luận tới ${fmtTime(new Date(res.strike.banUntil))}.` : 'Lần này là cảnh cáo.',
          ]
        : []),
    ]);
    return { userId: res.r.user_id, strike: res.strike };
  }

  /** Thu hồi vi phạm gắn với nội dung; nếu số vi phạm còn lại không còn phạt cấm thì gỡ cấm tự động (không đụng cấm tay / vĩnh viễn) */
  private async revokeStrikes(q: Queryable, userId: string, type: SquareTargetType, id: string) {
    await q.many(`UPDATE square_strikes SET revoked_at = now() WHERE user_id = $1 AND target_type = $2 AND target_id = $3 AND revoked_at IS NULL`, [userId, type, id]);
    const count = await this.activeStrikeCount(q, userId);
    if (strikePenaltyHours(count) === 0)
      await q.many(`UPDATE square_profiles SET banned_until = NULL, ban_reason = NULL WHERE user_id = $1 AND NOT ban_permanent AND ban_reason LIKE 'Vi phạm lần %'`, [userId]);
  }

  async restore(mod: ModCtx, type: Kind, id: number) {
    const r = await this.db.tx(async (tx) => {
      const { r } = await this.loadTarget(tx, type, id);
      if (r.status !== 'REMOVED') throw badRequest('STATUS', 'Nội dung không ở trạng thái đã gỡ');
      await this.setStatus(tx, type, r, 'PUBLISHED', ', reviewed_by = $3, reviewed_at = now(), appeal_status = CASE WHEN appeal_status = \'PENDING\' THEN \'ACCEPTED\' ELSE appeal_status END', [mod.email]);
      await this.revokeStrikes(tx, r.user_id, type, String(id));
      return r;
    });
    await this.notifyUser(this.db, r.user_id, 'APPEAL_ACCEPTED', { postId: type === 'POST' ? r.id : (r as CommentRow).post_id, detail: { restoredBy: 'mod' } });
    return { userId: r.user_id };
  }

  async dismissReports(mod: ModCtx, type: SquareTargetType, id: string) {
    const n = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM square_reports WHERE target_type = $1 AND target_id = $2 AND status = 'OPEN'`, [type, id]);
    if (!n?.n) throw badRequest('NO_REPORTS', 'Không còn báo cáo mở cho nội dung này');
    await this.closeReports(this.db, type, id, mod, 'DISMISSED');
    return { dismissed: n.n };
  }

  async decideAppeal(mod: ModCtx, type: Kind, id: number, accept: boolean, note: string) {
    const r = await this.db.tx(async (tx) => {
      const { r } = await this.loadTarget(tx, type, id);
      if (r.status !== 'REMOVED' || r.appeal_status !== 'PENDING') throw badRequest('STATUS', 'Không có khiếu nại đang chờ');
      if (r.removed_by === mod.email) throw badRequest('SELF', 'Người đã gỡ nội dung không được tự xử lý khiếu nại — cần kiểm duyệt viên khác');
      if (accept) {
        await this.setStatus(tx, type, r, 'PUBLISHED', ", appeal_status = 'ACCEPTED', reviewed_by = $3, reviewed_at = now()", [mod.email]);
        await this.revokeStrikes(tx, r.user_id, type, String(id));
      } else await tx.many(`UPDATE ${type === 'POST' ? 'square_posts' : 'square_comments'} SET appeal_status = 'REJECTED' WHERE id = $1`, [id]);
      return r;
    });
    await this.notifyUser(this.db, r.user_id, accept ? 'APPEAL_ACCEPTED' : 'APPEAL_REJECTED', {
      postId: type === 'POST' ? r.id : (r as CommentRow).post_id,
      commentId: type === 'COMMENT' ? id : null,
      detail: { note },
    });
    await this.deps.emailUser?.(r.user_id, accept ? 'Khiếu nại được chấp nhận' : 'Khiếu nại không được chấp nhận', [
      accept ? 'Nội dung của bạn đã được hiển thị lại và vi phạm liên quan đã được gỡ.' : 'Nội dung vẫn bị gỡ theo Tiêu chuẩn cộng đồng.',
      `Ghi chú của kiểm duyệt viên: ${note}`,
    ]);
    return { userId: r.user_id };
  }

  /* --- người dùng --- */

  async modUsers(q: string): Promise<SquareModUserDTO[]> {
    const term = q.trim().toLowerCase().replace(/^@/, '');
    const rows = await this.db.many<{ user_id: string }>(
      term
        ? `SELECT user_id FROM square_profiles WHERE handle LIKE $1 || '%' OR lower(display_name) LIKE '%' || $1 || '%' ORDER BY handle LIMIT 30`
        : `SELECT sp.user_id FROM square_profiles sp
           WHERE sp.ban_permanent OR sp.banned_until > now()
              OR (SELECT count(*) FROM square_strikes s WHERE s.user_id = sp.user_id AND s.revoked_at IS NULL AND s.expires_at > now()) > 0
           ORDER BY sp.handle LIMIT 100`,
      term ? [term] : [],
    );
    const out: SquareModUserDTO[] = [];
    for (const r of rows) out.push(await this.modUser(r.user_id));
    return out;
  }

  async modUser(userId: string): Promise<SquareModUserDTO> {
    const p = await this.profileOf(this.db, userId);
    if (!p) throw notFound('Người dùng chưa có hồ sơ Cộng đồng');
    const strikes = await this.strikesOf(this.db, userId);
    const c = await this.db.one<{ posts: number; removed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'PUBLISHED')::int AS posts, count(*) FILTER (WHERE status = 'REMOVED')::int AS removed FROM square_posts WHERE user_id = $1`,
      [userId],
    );
    const active = strikes.filter((s) => !s.revoked && new Date(s.expiresAt).getTime() > Date.now()).length;
    return {
      userId,
      handle: p.handle,
      displayName: p.display_name,
      activeStrikes: active,
      banned: !!this.banText(p),
      bio: p.bio,
      joinedAt: iso(p.created_at)!,
      banUntil: p.banned_until && new Date(p.banned_until).getTime() > Date.now() ? iso(p.banned_until) : null,
      banPermanent: p.ban_permanent,
      banReason: p.ban_reason,
      strikes,
      posts: c?.posts ?? 0,
      removedPosts: c?.removed ?? 0,
      flagPermanent: active >= SQUARE_RULES.permanentFlagAt && !p.ban_permanent,
    };
  }

  /** Cấm tay chỉ kéo dài lệnh cấm đang có, không rút ngắn (rút ngắn = gỡ cấm, có thể cần duyệt 2 người). Trả hạn cấm thực tế */
  async ban(userId: string, until: Date | null, permanent: boolean, reason: string): Promise<Date | null> {
    const p = await this.db.one<{ banned_until: Date | null }>(
      'UPDATE square_profiles SET banned_until = GREATEST(banned_until, $2), ban_permanent = ban_permanent OR $3, ban_reason = $4 WHERE user_id = $1 RETURNING banned_until',
      [userId, until, permanent, reason],
    );
    if (!p) throw notFound('Người dùng chưa có hồ sơ Cộng đồng');
    until = p.banned_until && new Date(p.banned_until);
    await this.notifyUser(this.db, userId, 'BANNED', { detail: { until: iso(until), permanent, reason } });
    await this.deps.emailUser?.(userId, permanent ? 'Bạn bị cấm vĩnh viễn đăng bài' : 'Bạn bị tạm cấm đăng bài', [
      permanent ? 'Tài khoản của bạn bị cấm vĩnh viễn đăng bài và bình luận trong Cộng đồng.' : `Bạn bị cấm đăng bài và bình luận tới ${fmtTime(until!)}.`,
      `Lý do: ${reason}`,
      'Bạn vẫn đọc Cộng đồng và giao dịch bình thường.',
    ]);
    return until;
  }

  async unban(userId: string, note: string) {
    await this.db.many('UPDATE square_profiles SET banned_until = NULL, ban_permanent = false, ban_reason = NULL WHERE user_id = $1', [userId]);
    await this.notifyUser(this.db, userId, 'UNBANNED', { detail: { note } });
  }

  async resetHandle(mod: ModCtx, userId: string, rule: ModRule, note: string) {
    const out = await this.db.tx(async (tx) => {
      const p = await this.profileOf(tx, userId);
      if (!p) throw notFound('Người dùng chưa có hồ sơ Cộng đồng');
      let handle = '';
      for (let i = 0; i < 5 && !handle; i++) {
        const h = `user_${crypto.randomBytes(3).toString('hex')}`;
        if (!(await tx.one('SELECT 1 FROM square_profiles WHERE handle = $1', [h]))) handle = h;
      }
      await tx.many(`UPDATE square_profiles SET handle = $2, display_name = 'Người dùng VNCoin', bio = '' WHERE user_id = $1`, [userId, handle]);
      await this.closeReports(tx, 'PROFILE', userId, mod, 'ACTIONED');
      const strike = await this.addStrike(tx, mod, userId, rule, 'PROFILE', userId, note);
      return { old: p.handle, handle, strike };
    });
    await this.notifyUser(this.db, userId, 'HANDLE_RESET', { detail: { rule, note, handle: out.handle } });
    await this.deps.emailUser?.(userId, 'Tên Cộng đồng của bạn đã bị đặt lại', [
      `Tên @${out.old} vi phạm Tiêu chuẩn cộng đồng (${MOD_RULE_LABEL[rule]}: ${note}) nên được đổi thành @${out.handle}. Bạn có thể chọn tên mới hợp lệ.`,
    ]);
    return out;
  }
}
