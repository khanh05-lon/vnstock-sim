import { Router } from 'express';
import { createTicketSchema, rateTicketSchema, ticketMessageSchema } from '@vss/shared';
import { requireAuthOrSupportTicket, type AuthedRequest, type SupportRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';
import { limiter } from '../lib/rateLimit';
import type { SupportService } from '../support/service';

const idOf = (raw: string | undefined) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã yêu cầu không hợp lệ');
  return id;
};

/** Khách hàng: gửi và theo dõi yêu cầu hỗ trợ (tài khoản bị khoá vào bằng vé hỗ trợ) */
export function supportRoutes(support: SupportService) {
  const r = Router();
  r.use('/support', requireAuthOrSupportTicket);
  const createLimiter = limiter({ windowMs: 60 * 60_000, limit: 10, message: 'Bạn tạo yêu cầu quá nhiều, vui lòng bổ sung vào yêu cầu đang có' });
  const msgLimiter = limiter({ windowMs: 10 * 60_000, limit: 40, message: 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ một chút' });

  r.get(
    '/support/tickets',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await support.listMine(user.id));
    }),
  );

  r.post(
    '/support/tickets',
    createLimiter,
    ah(async (req, res) => {
      const { user, supportOnly } = req as SupportRequest;
      const detail = await support.create(user.id, createTicketSchema.parse(req.body), { locked: supportOnly });
      if (supportOnly) {
        // Có thể là chủ tài khoản thật hoặc kẻ đã chiếm mật khẩu → nhắc nhân viên xác minh trước khi đề xuất mở khoá
        await support.postSystem(
          detail.ticket.id,
          `Khách gửi khi tài khoản đang bị khoá (IP ${req.ip ?? '?'}). Xác minh chính chủ trước khi đề xuất mở khoá: yêu cầu khách đặt lại mật khẩu qua email, đối chiếu lịch sử đăng nhập.`,
          true,
        );
      }
      res.status(201).json(detail);
    }),
  );

  r.get(
    '/support/tickets/:id',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await support.detailForCustomer(user.id, idOf(req.params.id)));
    }),
  );

  r.post(
    '/support/tickets/:id/messages',
    msgLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { body } = ticketMessageSchema.parse(req.body);
      res.json(await support.customerMessage(user.id, idOf(req.params.id), body));
    }),
  );

  r.post(
    '/support/tickets/:id/rate',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { rating, comment } = rateTicketSchema.parse(req.body);
      res.json(await support.rate(user.id, idOf(req.params.id), rating, comment));
    }),
  );

  r.post(
    '/support/tickets/:id/close',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await support.customerClose(user.id, idOf(req.params.id)));
    }),
  );

  return r;
}
