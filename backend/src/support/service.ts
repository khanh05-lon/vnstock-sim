import {
  HIGH_PRIORITY_CATEGORIES,
  SUPPORT_AUTO_CLOSE_DAYS,
  SUPPORT_MAX_OPEN_TICKETS,
  SUPPORT_SLA_MINUTES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type CreateTicketInput,
  type TicketDTO,
  type TicketDetailDTO,
  type TicketMessageDTO,
  type TicketPriority,
  type TicketStatus,
  type TicketUpdateInput,
} from '@vss/shared';
import type { AdminCtx } from '../admin/common';
import type { Database, Queryable } from '../db';
import { supportReplyEmail, supportResolvedEmail } from '../lib/emails';
import { badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { sendLater } from '../routes/auth';

export interface TicketRow {
  id: number;
  user_id: string;
  subject: string;
  category: TicketDTO['category'];
  priority: TicketPriority;
  status: TicketStatus;
  order_id: number | null;
  assignee_id: string | null;
  assignee_email: string | null;
  customer_waiting_since: Date | null;
  first_response_at: Date | null;
  resolved_at: Date | null;
  resolved_by_email: string | null;
  resolution: string | null;
  rating: number | null;
  rating_comment: string | null;
  customer_unread: number;
  staff_unread: number;
  last_message_at: Date;
  created_at: Date;
  updated_at: Date;
  // khi JOIN users (màn hình nhân viên)
  email?: string;
  full_name?: string;
  user_status?: string;
}

interface MessageRow {
  id: number;
  ticket_id: number;
  author_id: string | null;
  author_email: string | null;
  author_kind: TicketMessageDTO['authorKind'];
  body: string;
  internal: boolean;
  created_at: Date;
}

/** Sự kiện realtime: khách nhận ở phòng user:<id>, nhân viên ở phòng "staff" */
export interface SupportEvent {
  ticketId: number;
  kind: 'created' | 'message' | 'updated';
}

const iso = (d: Date | string | null) => (d == null ? null : new Date(d).toISOString());

/** Hạn trả lời: tính từ tin nhắn đầu tiên của khách chưa được trả lời */
export function dueAtOf(t: Pick<TicketRow, 'customer_waiting_since' | 'priority' | 'status'>): Date | null {
  if (!t.customer_waiting_since || t.status === 'RESOLVED' || t.status === 'CLOSED') return null;
  return new Date(new Date(t.customer_waiting_since).getTime() + SUPPORT_SLA_MINUTES[t.priority] * 60_000);
}

function toTicketDTO(t: TicketRow, viewer: 'customer' | 'staff'): TicketDTO {
  const base: TicketDTO = {
    id: Number(t.id),
    subject: t.subject,
    category: t.category,
    priority: t.priority,
    status: t.status,
    orderId: t.order_id == null ? null : Number(t.order_id),
    // Khách không thấy email nhân viên, chỉ biết đã có người tiếp nhận
    assigneeEmail: viewer === 'staff' ? t.assignee_email : t.assignee_email ? 'Nhân viên CSKH' : null,
    customerWaitingSince: iso(t.customer_waiting_since),
    firstResponseAt: iso(t.first_response_at),
    resolvedAt: iso(t.resolved_at),
    resolution: t.resolution,
    rating: t.rating,
    ratingComment: t.rating_comment,
    unread: viewer === 'staff' ? t.staff_unread : t.customer_unread,
    lastMessageAt: iso(t.last_message_at)!,
    createdAt: iso(t.created_at)!,
  };
  if (viewer === 'staff') {
    const due = dueAtOf(t);
    base.customer = { id: t.user_id, email: t.email ?? '', fullName: t.full_name ?? '', status: t.user_status ?? '' };
    base.dueAt = iso(due);
    base.overdue = !!due && due.getTime() < Date.now();
  }
  return base;
}

function toMessageDTO(m: MessageRow, viewer: 'customer' | 'staff', customerName: string): TicketMessageDTO {
  const name =
    m.author_kind === 'CUSTOMER' ? customerName : m.author_kind === 'SYSTEM' ? 'Hệ thống' : viewer === 'staff' ? (m.author_email ?? 'Nhân viên') : 'Nhân viên CSKH';
  return { id: Number(m.id), authorKind: m.author_kind, authorName: name, body: m.body, internal: m.internal, createdAt: iso(m.created_at)! };
}

const STAFF_SELECT = `SELECT t.*, u.email, u.full_name, u.status AS user_status FROM support_tickets t JOIN users u ON u.id = t.user_id`;

/**
 * Hỗ trợ khách hàng: khách gửi yêu cầu (gắn với lệnh nếu có), nhân viên CSKH tiếp nhận, trao đổi, xử lý.
 * Mọi tin nhắn chỉ được ghi thêm (trigger CSDL), mọi thay đổi trạng thái để lại tin nhắn hệ thống trong yêu cầu
 * → luôn biết ai tiếp nhận, ai trả lời, ai đóng yêu cầu, khi nào.
 */
export class SupportService {
  notifyCustomer: (userId: string, ev: SupportEvent) => void = () => undefined;
  notifyStaff: (ev: SupportEvent) => void = () => undefined;
  private overdue = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Database,
    private mailer: Mailer | null = null,
  ) {}

  /** Số yêu cầu quá hạn trả lời (cache, cập nhật mỗi phút) — dùng cho cảnh báo vận hành */
  overdueCount() {
    return this.overdue;
  }

  start(everyMs = 60_000) {
    if (this.timer) return;
    const tick = () => void this.housekeeping().catch((err) => log.error('[support] lỗi tác vụ định kỳ', { err }));
    tick();
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Đếm yêu cầu quá hạn + tự đóng yêu cầu đã xử lý quá N ngày không phản hồi */
  async housekeeping() {
    const rows = await this.db.many<Pick<TicketRow, 'customer_waiting_since' | 'priority' | 'status'>>(
      `SELECT customer_waiting_since, priority, status FROM support_tickets WHERE status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER') AND customer_waiting_since IS NOT NULL`,
    );
    const now = Date.now();
    this.overdue = rows.filter((r) => (dueAtOf(r)?.getTime() ?? Infinity) < now).length;
    const closed = await this.db.many<{ id: number; user_id: string }>(
      `UPDATE support_tickets SET status = 'CLOSED', updated_at = now()
       WHERE status = 'RESOLVED' AND resolved_at < now() - make_interval(days => $1) RETURNING id, user_id`,
      [SUPPORT_AUTO_CLOSE_DAYS],
    );
    for (const t of closed) {
      await this.system(this.db, Number(t.id), `Tự đóng sau ${SUPPORT_AUTO_CLOSE_DAYS} ngày không có phản hồi kể từ khi xử lý xong`);
      this.notifyCustomer(t.user_id, { ticketId: Number(t.id), kind: 'updated' });
    }
  }

  private async system(q: Queryable, ticketId: number, body: string, internal = false) {
    await q.many(`INSERT INTO support_messages (ticket_id, author_kind, body, internal) VALUES ($1,'SYSTEM',$2,$3)`, [ticketId, body, internal]);
  }

  /** Tin nhắn hệ thống từ nơi khác (vd. kết quả duyệt điều chỉnh số dư) */
  async postSystem(ticketId: number, body: string, internal: boolean) {
    const t = await this.db.one<{ user_id: string }>('SELECT user_id FROM support_tickets WHERE id = $1', [ticketId]);
    if (!t) return;
    await this.db.tx(async (tx) => {
      await this.system(tx, ticketId, body, internal);
      await tx.many(
        `UPDATE support_tickets SET last_message_at = now(), updated_at = now(), customer_unread = customer_unread + $2 WHERE id = $1`,
        [ticketId, internal ? 0 : 1],
      );
    });
    if (!internal) this.notifyCustomer(t.user_id, { ticketId, kind: 'message' });
    this.notifyStaff({ ticketId, kind: 'message' });
  }

  /* ============================== phía khách hàng ============================== */

  async listMine(userId: string): Promise<TicketDTO[]> {
    const rows = await this.db.many<TicketRow>('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY last_message_at DESC LIMIT 100', [userId]);
    return rows.map((t) => toTicketDTO(t, 'customer'));
  }

  /** `locked`: khách gửi khi tài khoản đang bị khoá (không giao dịch được) → tối thiểu ưu tiên Cao */
  async create(userId: string, input: CreateTicketInput, opts: { locked?: boolean } = {}): Promise<TicketDetailDTO> {
    if (input.orderId) {
      const o = await this.db.one('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [input.orderId, userId]);
      if (!o) throw badRequest('ORDER', `Không tìm thấy lệnh #${input.orderId} của bạn`);
    }
    const priority: TicketPriority = input.urgent ? 'URGENT' : opts.locked || HIGH_PRIORITY_CATEGORIES.includes(input.category) ? 'HIGH' : 'NORMAL';
    const id = await this.db.tx(async (tx) => {
      const open = await tx.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM support_tickets WHERE user_id = $1 AND status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER')`,
        [userId],
      );
      if ((open?.n ?? 0) >= SUPPORT_MAX_OPEN_TICKETS) {
        throw badRequest('TOO_MANY', `Bạn đang có ${SUPPORT_MAX_OPEN_TICKETS} yêu cầu chưa xử lý xong — hãy bổ sung vào yêu cầu cũ`);
      }
      const t = await tx.one<{ id: number }>(
        `INSERT INTO support_tickets (user_id, subject, category, priority, order_id, customer_waiting_since, staff_unread)
         VALUES ($1,$2,$3,$4,$5, now(), 1) RETURNING id`,
        [userId, input.subject, input.category, priority, input.orderId ?? null],
      );
      const tid = Number(t!.id);
      await tx.many(`INSERT INTO support_messages (ticket_id, author_id, author_kind, body) VALUES ($1,$2,'CUSTOMER',$3)`, [tid, userId, input.message]);
      await this.system(
        tx,
        tid,
        `Đã nhận yêu cầu (mức ưu tiên: ${TICKET_PRIORITY_LABEL[priority]}). Nhân viên CSKH sẽ trả lời trong khoảng ${SUPPORT_SLA_MINUTES[priority]} phút.`,
      );
      return tid;
    });
    this.notifyStaff({ ticketId: id, kind: 'created' });
    return this.detailForCustomer(userId, id);
  }

  async detailForCustomer(userId: string, id: number): Promise<TicketDetailDTO> {
    const t = await this.db.one<TicketRow>(
      'UPDATE support_tickets SET customer_unread = 0 WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId],
    );
    if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
    const u = await this.db.one<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [userId]);
    const msgs = await this.db.many<MessageRow>('SELECT * FROM support_messages WHERE ticket_id = $1 AND internal = false ORDER BY id', [id]);
    return { ticket: toTicketDTO(t, 'customer'), messages: msgs.map((m) => toMessageDTO(m, 'customer', u?.full_name ?? 'Bạn')) };
  }

  async customerMessage(userId: string, id: number, body: string): Promise<TicketDetailDTO> {
    await this.db.tx(async (tx) => {
      const t = await tx.one<TicketRow>('SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
      if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
      if (t.status === 'CLOSED') throw badRequest('CLOSED', 'Yêu cầu đã đóng — hãy tạo yêu cầu mới');
      await tx.many(`INSERT INTO support_messages (ticket_id, author_id, author_kind, body) VALUES ($1,$2,'CUSTOMER',$3)`, [id, userId, body]);
      // Khách trả lời: yêu cầu đã xử lý được mở lại, chờ khách → quay về xử lý
      const next: TicketStatus = t.status === 'RESOLVED' || t.status === 'WAITING_CUSTOMER' ? (t.assignee_id ? 'IN_PROGRESS' : 'OPEN') : t.status;
      if (t.status === 'RESOLVED') await this.system(tx, id, 'Khách hàng mở lại yêu cầu');
      await tx.many(
        `UPDATE support_tickets SET status = $2, customer_waiting_since = COALESCE(customer_waiting_since, now()),
                staff_unread = staff_unread + 1, last_message_at = now(), updated_at = now(),
                resolved_at = CASE WHEN $2 <> 'RESOLVED' THEN NULL ELSE resolved_at END
         WHERE id = $1`,
        [id, next],
      );
    });
    this.notifyStaff({ ticketId: id, kind: 'message' });
    return this.detailForCustomer(userId, id);
  }

  async rate(userId: string, id: number, rating: number, comment?: string): Promise<TicketDetailDTO> {
    const t = await this.db.one<TicketRow>(
      `UPDATE support_tickets SET rating = $3, rating_comment = $4, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('RESOLVED','CLOSED') RETURNING *`,
      [id, userId, rating, comment || null],
    );
    if (!t) throw badRequest('NOT_RESOLVED', 'Chỉ đánh giá được yêu cầu đã xử lý');
    await this.system(this.db, id, `Khách hàng đánh giá ${rating}/5 sao${comment ? `: "${comment}"` : ''}`, true);
    this.notifyStaff({ ticketId: id, kind: 'updated' });
    return this.detailForCustomer(userId, id);
  }

  async customerClose(userId: string, id: number): Promise<TicketDetailDTO> {
    const t = await this.db.one<TicketRow>(
      `UPDATE support_tickets SET status = 'CLOSED', customer_waiting_since = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status <> 'CLOSED' RETURNING *`,
      [id, userId],
    );
    if (!t) throw badRequest('CLOSED', 'Yêu cầu đã đóng');
    await this.system(this.db, id, 'Khách hàng đóng yêu cầu');
    this.notifyStaff({ ticketId: id, kind: 'updated' });
    return this.detailForCustomer(userId, id);
  }

  /* ============================== phía nhân viên ============================== */

  async list(staff: AdminCtx, f: { scope: 'active' | 'mine' | 'unassigned' | 'overdue' | 'all'; q?: string }): Promise<TicketDTO[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.scope !== 'all') where.push(`t.status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER')`);
    if (f.scope === 'mine') {
      params.push(staff.id);
      where.push(`t.assignee_id = $${params.length}`);
    }
    if (f.scope === 'unassigned') where.push('t.assignee_id IS NULL');
    if (f.q) {
      params.push(`%${f.q.toLowerCase()}%`);
      const i = params.length;
      const asId = Number(f.q.replace(/^#/, ''));
      where.push(`(lower(u.email) LIKE $${i} OR lower(t.subject) LIKE $${i}${Number.isSafeInteger(asId) && asId > 0 ? ` OR t.id = ${asId} OR t.order_id = ${asId}` : ''})`);
    }
    const rows = await this.db.many<TicketRow>(
      `${STAFF_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END, t.customer_waiting_since NULLS LAST, t.last_message_at DESC
       LIMIT 300`,
      params,
    );
    let out = rows.map((t) => toTicketDTO(t, 'staff'));
    if (f.scope === 'overdue') out = out.filter((t) => t.overdue);
    return out;
  }

  async stats(staff: AdminCtx) {
    const r = await this.db.one<{ open: number; unassigned: number; mine: number; unread: number }>(
      `SELECT count(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER'))::int AS open,
              count(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER') AND assignee_id IS NULL)::int AS unassigned,
              count(*) FILTER (WHERE status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER') AND assignee_id = $1)::int AS mine,
              COALESCE(sum(staff_unread) FILTER (WHERE status <> 'CLOSED' AND (assignee_id = $1 OR assignee_id IS NULL)), 0)::int AS unread
       FROM support_tickets`,
      [staff.id],
    );
    return { ...(r ?? { open: 0, unassigned: 0, mine: 0, unread: 0 }), overdue: this.overdue };
  }

  async getRow(id: number): Promise<TicketRow> {
    const t = await this.db.one<TicketRow>(`${STAFF_SELECT} WHERE t.id = $1`, [id]);
    if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
    return t;
  }

  async detailForStaff(id: number): Promise<TicketDetailDTO> {
    await this.db.many('UPDATE support_tickets SET staff_unread = 0 WHERE id = $1', [id]);
    const t = await this.getRow(id);
    const msgs = await this.db.many<MessageRow>('SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY id', [id]);
    return { ticket: toTicketDTO(t, 'staff'), messages: msgs.map((m) => toMessageDTO(m, 'staff', t.full_name ?? 'Khách hàng')) };
  }

  /** Nhận xử lý (mặc định cho chính mình); quản trị viên được giao cho nhân viên khác */
  async assign(staff: AdminCtx, id: number, assignee: { id: string; email: string }) {
    await this.db.tx(async (tx) => {
      const t = await tx.one<TicketRow>('SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
      if (t.status === 'CLOSED') throw badRequest('CLOSED', 'Yêu cầu đã đóng');
      if (t.assignee_id === assignee.id) throw badRequest('NO_CHANGE', 'Yêu cầu đã được giao cho nhân viên này');
      await tx.many(
        `UPDATE support_tickets SET assignee_id = $2, assignee_email = $3, status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END, updated_at = now() WHERE id = $1`,
        [id, assignee.id, assignee.email],
      );
      const who = assignee.id === staff.id ? `${staff.email} tiếp nhận xử lý` : `${staff.email} giao cho ${assignee.email}`;
      await this.system(tx, id, t.assignee_email ? `${who} (thay ${t.assignee_email})` : who, true);
      await this.system(tx, id, 'Nhân viên CSKH đã tiếp nhận yêu cầu của bạn');
      await tx.many('UPDATE support_tickets SET customer_unread = customer_unread + 1 WHERE id = $1', [id]);
      return t.user_id;
    }).then((userId) => this.notifyCustomer(userId, { ticketId: id, kind: 'updated' }));
    this.notifyStaff({ ticketId: id, kind: 'updated' });
    return this.detailForStaff(id);
  }

  async staffMessage(staff: AdminCtx, id: number, body: string, internal: boolean) {
    const t = await this.db.tx(async (tx) => {
      const t = await tx.one<TicketRow>(`${STAFF_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
      if (t.status === 'CLOSED') throw badRequest('CLOSED', 'Yêu cầu đã đóng');
      await tx.many(`INSERT INTO support_messages (ticket_id, author_id, author_email, author_kind, body, internal) VALUES ($1,$2,$3,'STAFF',$4,$5)`, [
        id,
        staff.id,
        staff.email,
        body,
        internal,
      ]);
      if (internal) {
        await tx.many('UPDATE support_tickets SET updated_at = now() WHERE id = $1', [id]);
        return t;
      }
      // Trả lời khách: dừng đồng hồ hạn xử lý; chưa ai nhận thì người trả lời nhận luôn
      await tx.many(
        `UPDATE support_tickets SET first_response_at = COALESCE(first_response_at, now()), customer_waiting_since = NULL,
                customer_unread = customer_unread + 1, last_message_at = now(), updated_at = now(),
                assignee_id = COALESCE(assignee_id, $2), assignee_email = COALESCE(assignee_email, $3),
                status = CASE WHEN status = 'OPEN' THEN 'IN_PROGRESS' ELSE status END
         WHERE id = $1`,
        [id, staff.id, staff.email],
      );
      return t;
    });
    if (!internal) {
      this.notifyCustomer(t.user_id, { ticketId: id, kind: 'message' });
      if (this.mailer && t.email) sendLater(this.mailer, t.email, supportReplyEmail(t.full_name ?? '', id, t.subject, body), { userId: t.user_id });
    }
    this.notifyStaff({ ticketId: id, kind: 'message' });
    return this.detailForStaff(id);
  }

  async update(staff: AdminCtx, id: number, input: TicketUpdateInput) {
    const t = await this.db.tx(async (tx) => {
      const t = await tx.one<TicketRow>(`${STAFF_SELECT} WHERE t.id = $1 FOR UPDATE OF t`, [id]);
      if (!t) throw notFound('Không tìm thấy yêu cầu hỗ trợ');
      if (t.status === 'CLOSED') throw badRequest('CLOSED', 'Yêu cầu đã đóng');
      if (input.priority && input.priority !== t.priority) {
        await tx.many('UPDATE support_tickets SET priority = $2, updated_at = now() WHERE id = $1', [id, input.priority]);
        await this.system(tx, id, `${staff.email} đổi mức ưu tiên: ${TICKET_PRIORITY_LABEL[t.priority]} → ${TICKET_PRIORITY_LABEL[input.priority]}`, true);
      }
      if (input.status && input.status !== t.status) {
        if (input.status === 'RESOLVED') {
          await tx.many(
            `UPDATE support_tickets SET status = 'RESOLVED', resolution = $2, resolved_at = now(), resolved_by_email = $3, customer_waiting_since = NULL,
                    assignee_id = COALESCE(assignee_id, $4), assignee_email = COALESCE(assignee_email, $3),
                    first_response_at = COALESCE(first_response_at, now()), customer_unread = customer_unread + 1, last_message_at = now(), updated_at = now()
             WHERE id = $1`,
            [id, input.resolution, staff.email, staff.id],
          );
          await this.system(tx, id, `Đã xử lý: ${input.resolution}`);
          await this.system(tx, id, `${staff.email} đóng yêu cầu (đã xử lý)`, true);
        } else {
          await tx.many(
            `UPDATE support_tickets SET status = $2, updated_at = now(),
                    customer_waiting_since = CASE WHEN $2 = 'WAITING_CUSTOMER' THEN NULL ELSE customer_waiting_since END
             WHERE id = $1`,
            [id, input.status],
          );
          await this.system(tx, id, `${staff.email} chuyển trạng thái: ${TICKET_STATUS_LABEL[t.status]} → ${TICKET_STATUS_LABEL[input.status]}`, true);
        }
      }
      return t;
    });
    if (input.status === 'RESOLVED' && this.mailer && t.email) {
      sendLater(this.mailer, t.email, supportResolvedEmail(t.full_name ?? '', id, t.subject, input.resolution!), { userId: t.user_id });
    }
    this.notifyCustomer(t.user_id, { ticketId: id, kind: 'updated' });
    this.notifyStaff({ ticketId: id, kind: 'updated' });
    return this.detailForStaff(id);
  }

  /** Ghi lại thao tác nghiệp vụ nhân viên làm trong yêu cầu (huỷ lệnh, khoá TK, đề xuất điều chỉnh) */
  async action(staff: AdminCtx, id: number, internalNote: string, customerNote?: string) {
    const t = await this.getRow(id);
    await this.db.tx(async (tx) => {
      await this.system(tx, id, `${staff.email}: ${internalNote}`, true);
      if (customerNote) {
        await this.system(tx, id, customerNote);
        await tx.many('UPDATE support_tickets SET customer_unread = customer_unread + 1, last_message_at = now(), updated_at = now() WHERE id = $1', [id]);
      }
    });
    if (customerNote) this.notifyCustomer(t.user_id, { ticketId: id, kind: 'message' });
    this.notifyStaff({ ticketId: id, kind: 'updated' });
  }
}
