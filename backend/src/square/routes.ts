import { Router, type Request } from 'express';
import { z } from 'zod';
import { squareAppealSchema, squareCommentSchema, squarePostSchema, squareProfileSchema, squareReportSchema } from '@vss/shared';
import { requireAuth, verifyToken, type AuthedRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';
import { limiter } from '../lib/rateLimit';
import type { SquareService } from './service';

/**
 * Cộng đồng (/api/square/*). Đọc công khai (có đăng nhập thì biết đã thích / theo dõi chưa); ghi cần đăng nhập.
 * Gắn TRƯỚC tradingRoutes (router đó gắn requireAuth cho cả /api).
 */
export function squareRoutes(square: SquareService) {
  const r = Router();
  const uid = (req: Request) => (req as AuthedRequest).user.id;
  const viewer = (req: Request): string | null => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? (verifyToken(h.slice(7))?.id ?? null) : null;
  };
  const idOf = (raw: string | undefined) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã không hợp lệ');
    return id;
  };
  // Lớp chặn thô theo phút (giới hạn theo giờ / ngày nằm trong SquareService)
  const writeLimit = limiter({ windowMs: 60_000, limit: 30, message: 'Thao tác quá nhanh, thử lại sau ít phút' });

  r.get('/square/config', (_req, res) => res.json(square.config()));

  r.get(
    '/square/feed',
    ah(async (req, res) => {
      const f = z
        .object({
          tab: z.enum(['foryou', 'latest', 'following']).default('foryou'),
          coin: z.string().trim().regex(/^[A-Za-z0-9]{2,10}$/).optional(),
          tag: z.string().trim().min(2).max(30).optional(),
          author: z.string().trim().max(30).optional(),
          before: z.string().trim().max(20).optional(),
        })
        .parse(req.query);
      res.json(await square.feed(viewer(req), f));
    }),
  );
  r.get('/square/trends', ah(async (req, res) => res.json(await square.trends(z.string().max(10).optional().parse(req.query.coin)))));
  r.get('/square/suggestions', ah(async (req, res) => res.json(await square.suggestions(viewer(req)))));
  r.get('/square/posts/:id', ah(async (req, res) => res.json(await square.post(idOf(req.params.id), viewer(req)))));
  r.get('/square/posts/:id/comments', ah(async (req, res) => res.json(await square.comments(idOf(req.params.id), viewer(req)))));
  r.get('/square/users/:handle', ah(async (req, res) => res.json(await square.profile(String(req.params.handle), viewer(req)))));

  r.get('/square/me', requireAuth, ah(async (req, res) => res.json(await square.me(uid(req)))));
  r.put('/square/me', requireAuth, writeLimit, ah(async (req, res) => res.json(await square.saveProfile(uid(req), squareProfileSchema.parse(req.body)))));

  r.post(
    '/square/posts',
    requireAuth,
    writeLimit,
    ah(async (req, res) => {
      const post = await square.createPost(uid(req), squarePostSchema.parse(req.body));
      res.status(201).json(post);
    }),
  );
  r.delete(
    '/square/posts/:id',
    requireAuth,
    ah(async (req, res) => {
      await square.deletePost(uid(req), idOf(req.params.id));
      res.json({ ok: true });
    }),
  );
  r.post('/square/posts/:id/like', requireAuth, writeLimit, ah(async (req, res) => res.json(await square.like(uid(req), idOf(req.params.id), true))));
  r.delete('/square/posts/:id/like', requireAuth, ah(async (req, res) => res.json(await square.like(uid(req), idOf(req.params.id), false))));
  r.post(
    '/square/posts/:id/comments',
    requireAuth,
    writeLimit,
    ah(async (req, res) => res.status(201).json(await square.comment(uid(req), idOf(req.params.id), squareCommentSchema.parse(req.body)))),
  );
  r.delete(
    '/square/comments/:id',
    requireAuth,
    ah(async (req, res) => {
      await square.deleteComment(uid(req), idOf(req.params.id));
      res.json({ ok: true });
    }),
  );
  r.post('/square/users/:handle/follow', requireAuth, writeLimit, ah(async (req, res) => res.json(await square.follow(uid(req), String(req.params.handle), true))));
  r.delete('/square/users/:handle/follow', requireAuth, ah(async (req, res) => res.json(await square.follow(uid(req), String(req.params.handle), false))));
  r.post('/square/reports', requireAuth, writeLimit, ah(async (req, res) => res.status(201).json(await square.report(uid(req), squareReportSchema.parse(req.body)))));
  r.post(
    '/square/:type(posts|comments)/:id/appeal',
    requireAuth,
    ah(async (req, res) => {
      const { note } = squareAppealSchema.parse(req.body);
      res.json(await square.appeal(uid(req), req.params.type === 'posts' ? 'POST' : 'COMMENT', idOf(req.params.id), note));
    }),
  );
  r.get(
    '/square/notifications',
    requireAuth,
    ah(async (req, res) => {
      const before = req.query.before ? idOf(String(req.query.before)) : undefined;
      res.json(await square.notifications(uid(req), before));
    }),
  );
  r.post(
    '/square/notifications/read',
    requireAuth,
    ah(async (req, res) => {
      await square.markRead(uid(req));
      res.json({ ok: true });
    }),
  );
  return r;
}
