import Anthropic from '@anthropic-ai/sdk';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { AI_CHAT_LIMITS, aiChatSchema, createTicketSchema, rateTicketSchema, ticketMessageSchema, type AiStatusDTO, type AiStreamEvent } from '@vss/shared';
import { requireAuthOrSupportTicket, type AuthedRequest, type SupportRequest } from '../lib/auth';
import { AppError, ah, badRequest } from '../lib/errors';
import { log } from '../lib/logger';
import { limiter } from '../lib/rateLimit';
import type { SupportAssistant } from '../support/ai';
import type { SupportService } from '../support/service';

const idOf = (raw: string | undefined) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã yêu cầu không hợp lệ');
  return id;
};

/** Lỗi Claude API → câu báo cho khách (chi tiết chỉ ghi log) */
function aiErrorMessage(e: unknown): string {
  if (e instanceof Anthropic.APIError) {
    if (e.status === 429 || e.status === 529 || (e.status ?? 0) >= 500) return 'Trợ lý AI đang quá tải, bạn thử lại sau ít phút hoặc bấm Gặp nhân viên';
    if (e.status === 401 || e.status === 403) return 'Trợ lý AI đang gặp sự cố cấu hình, bạn bấm Gặp nhân viên để được hỗ trợ';
  }
  return 'Trợ lý AI tạm thời không trả lời được, bạn thử lại hoặc bấm Gặp nhân viên';
}

/** Khách hàng: gửi và theo dõi yêu cầu hỗ trợ (tài khoản bị khoá vào bằng vé hỗ trợ) */
export function supportRoutes(support: SupportService, assistant: SupportAssistant | null = null) {
  const r = Router();
  r.use('/support', requireAuthOrSupportTicket);
  const createLimiter = limiter({ windowMs: 60 * 60_000, limit: 10, message: 'Bạn tạo yêu cầu quá nhiều, vui lòng bổ sung vào yêu cầu đang có' });
  const msgLimiter = limiter({ windowMs: 10 * 60_000, limit: 40, message: 'Bạn gửi tin nhắn quá nhanh, vui lòng chờ một chút' });

  /* ---------- trợ lý AI: chỉ phiên đăng nhập đầy đủ (vé hỗ trợ của tài khoản bị khoá thì gặp nhân viên) ---------- */
  const aiEnabledFor = (req: Request) => !!assistant?.enabled && !(req as SupportRequest).supportOnly;
  const aiGuard = (req: Request, _res: Response, next: NextFunction) => {
    if ((req as SupportRequest).supportOnly) return next(new AppError(403, 'SUPPORT_ONLY', 'Tài khoản đang bị khoá: vui lòng nhắn nhân viên hỗ trợ'));
    if (!assistant?.enabled) return next(new AppError(503, 'AI_DISABLED', 'Trợ lý AI chưa được bật, bạn bấm Gặp nhân viên để được hỗ trợ'));
    next();
  };
  const aiLimiter = limiter({ windowMs: 10 * 60_000, limit: AI_CHAT_LIMITS.per10Min, message: 'Bạn hỏi trợ lý hơi nhanh, vui lòng chờ vài phút' });
  const aiDayLimiter = limiter({
    windowMs: 24 * 60 * 60_000,
    limit: AI_CHAT_LIMITS.perDay,
    message: 'Bạn đã dùng hết lượt hỏi trợ lý AI hôm nay, bấm Gặp nhân viên nếu cần hỗ trợ thêm',
  });

  r.get('/support/ai', (req, res) => {
    res.json({ enabled: aiEnabledFor(req) } satisfies AiStatusDTO);
  });

  /** Trả lời dạng NDJSON stream: {"t":"đoạn chữ"} … rồi {"done":true} hoặc {"error":"…"} */
  r.post(
    '/support/ai/chat',
    aiGuard,
    (req, _res, next) => {
      try {
        req.body = aiChatSchema.parse(req.body);
        next();
      } catch (e) {
        next(e);
      }
    },
    aiLimiter,
    aiDayLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { messages } = req.body as { messages: Parameters<SupportAssistant['reply']>[1] };
      res.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const ac = new AbortController();
      // Khách đóng hộp chat / bấm dừng → ngừng gọi Claude cho đỡ tốn
      res.on('close', () => {
        if (!res.writableEnded) ac.abort();
      });
      const send = (ev: AiStreamEvent) => void res.write(`${JSON.stringify(ev)}
`);
      try {
        await assistant!.reply(user.id, messages, (t) => send({ t }), ac.signal);
        send({ done: true });
      } catch (e) {
        if (!ac.signal.aborted) {
          log.warn(`[ai] lỗi trả lời user=${user.id}: ${e instanceof Error ? e.message : String(e)}`);
          send({ error: aiErrorMessage(e) });
        }
      }
      res.end();
    }),
  );

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
