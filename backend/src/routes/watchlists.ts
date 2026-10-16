import { Router } from 'express';
import { MAX_WATCHLISTS, MAX_WATCHLIST_SYMBOLS, watchlistNameSchema, watchlistSymbolSchema, type WatchlistDTO } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { AppError, ah, badRequest, notFound } from '../lib/errors';

export const DEFAULT_WATCHLIST_NAME = 'Theo dõi';

/** Danh sách đầu tiên của người dùng (tạo "Theo dõi" nếu chưa có) — dùng cho API cũ /watchlist và nút ngôi sao */
export async function defaultWatchlistId(q: Queryable, userId: string): Promise<number> {
  const first = await q.one<{ id: number }>('SELECT id FROM watchlist_lists WHERE user_id = $1 ORDER BY sort, id LIMIT 1', [userId]);
  if (first) return Number(first.id);
  const row = await q.one<{ id: number }>(
    `INSERT INTO watchlist_lists (user_id, name) VALUES ($1, $2) ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [userId, DEFAULT_WATCHLIST_NAME],
  );
  return Number(row!.id);
}

export async function listWatchlists(q: Queryable, userId: string): Promise<WatchlistDTO[]> {
  await defaultWatchlistId(q, userId);
  const lists = await q.many<{ id: number; name: string }>('SELECT id, name FROM watchlist_lists WHERE user_id = $1 ORDER BY sort, id', [userId]);
  const items = await q.many<{ list_id: number; symbol: string }>('SELECT list_id, symbol FROM watchlists WHERE user_id = $1 ORDER BY created_at', [userId]);
  return lists.map((l) => ({ id: Number(l.id), name: l.name, symbols: items.filter((i) => Number(i.list_id) === Number(l.id)).map((i) => i.symbol) }));
}

async function ownList(q: Queryable, userId: string, id: number) {
  const row = await q.one<{ id: number; name: string }>('SELECT id, name FROM watchlist_lists WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!row) throw notFound('Không tìm thấy danh sách theo dõi');
  return row;
}

async function addSymbol(q: Queryable, userId: string, listId: number, symbol: string) {
  const s = await q.one<{ enabled: boolean }>('SELECT enabled FROM symbols WHERE symbol = $1', [symbol]);
  if (!s) throw badRequest('SYMBOL', `Cặp ${symbol} không tồn tại`);
  if (!s.enabled) throw badRequest('SYMBOL', `Cặp ${symbol} đã gỡ khỏi sàn`);
  const n = await q.one<{ n: number }>('SELECT count(*)::int AS n FROM watchlists WHERE list_id = $1', [listId]);
  if ((n?.n ?? 0) >= MAX_WATCHLIST_SYMBOLS) throw badRequest('LIMIT', `Mỗi danh sách tối đa ${MAX_WATCHLIST_SYMBOLS} cặp`);
  await q.many('INSERT INTO watchlists (user_id, list_id, symbol) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [userId, listId, symbol]);
}

const idParam = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('ID', 'Mã danh sách không hợp lệ');
  return n;
};

const isUnique = (err: unknown) => (err as { code?: string }).code === '23505';

/** Nhiều danh sách theo dõi + API cũ /watchlist (thao tác trên danh sách đầu tiên) */
export function watchlistRoutes(db: Database) {
  const r = Router();
  r.use('/watchlist', requireAuth);
  r.use('/watchlists', requireAuth);

  r.get(
    '/watchlists',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await db.tx((tx) => listWatchlists(tx, user.id)));
    }),
  );

  r.post(
    '/watchlists',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { name } = watchlistNameSchema.parse(req.body);
      try {
        const out = await db.tx(async (tx) => {
          await defaultWatchlistId(tx, user.id);
          const n = await tx.one<{ n: number; s: number }>('SELECT count(*)::int AS n, COALESCE(max(sort), 0)::int AS s FROM watchlist_lists WHERE user_id = $1', [user.id]);
          if ((n?.n ?? 0) >= MAX_WATCHLISTS) throw badRequest('LIMIT', `Tối đa ${MAX_WATCHLISTS} danh sách theo dõi`);
          const row = await tx.one<{ id: number }>('INSERT INTO watchlist_lists (user_id, name, sort) VALUES ($1,$2,$3) RETURNING id', [user.id, name, (n?.s ?? 0) + 1]);
          return { id: Number(row!.id), name, symbols: [] } satisfies WatchlistDTO;
        });
        res.status(201).json(out);
      } catch (err) {
        if (isUnique(err)) throw new AppError(409, 'NAME_EXISTS', `Đã có danh sách tên "${name}"`);
        throw err;
      }
    }),
  );

  r.patch(
    '/watchlists/:id',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = idParam(req.params.id);
      const { name } = watchlistNameSchema.parse(req.body);
      await ownList(db, user.id, id);
      try {
        await db.many('UPDATE watchlist_lists SET name = $3 WHERE id = $1 AND user_id = $2', [id, user.id, name]);
      } catch (err) {
        if (isUnique(err)) throw new AppError(409, 'NAME_EXISTS', `Đã có danh sách tên "${name}"`);
        throw err;
      }
      res.json({ ok: true });
    }),
  );

  r.delete(
    '/watchlists/:id',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = idParam(req.params.id);
      await db.tx(async (tx) => {
        await ownList(tx, user.id, id);
        const n = await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM watchlist_lists WHERE user_id = $1', [user.id]);
        if ((n?.n ?? 0) <= 1) throw badRequest('LAST_LIST', 'Phải giữ lại ít nhất 1 danh sách theo dõi');
        await tx.many('DELETE FROM watchlist_lists WHERE id = $1 AND user_id = $2', [id, user.id]);
      });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/watchlists/:id/symbols',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = idParam(req.params.id);
      const { symbol } = watchlistSymbolSchema.parse(req.body);
      await db.tx(async (tx) => {
        await ownList(tx, user.id, id);
        await addSymbol(tx, user.id, id, symbol);
      });
      res.status(201).json({ ok: true });
    }),
  );

  r.delete(
    '/watchlists/:id/symbols/:symbol',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = idParam(req.params.id);
      await db.many('DELETE FROM watchlists WHERE list_id = $1 AND user_id = $2 AND symbol = $3', [id, user.id, req.params.symbol.toUpperCase()]);
      res.json({ ok: true });
    }),
  );

  /* ---- API cũ: danh sách đầu tiên ---- */

  r.get(
    '/watchlist',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const lists = await db.tx((tx) => listWatchlists(tx, user.id));
      res.json(lists[0]?.symbols ?? []);
    }),
  );

  r.post(
    '/watchlist',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { symbol } = watchlistSymbolSchema.parse(req.body);
      await db.tx(async (tx) => addSymbol(tx, user.id, await defaultWatchlistId(tx, user.id), symbol));
      res.status(201).json({ ok: true });
    }),
  );

  r.delete(
    '/watchlist/:symbol',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await db.tx(async (tx) =>
        tx.many('DELETE FROM watchlists WHERE list_id = $1 AND symbol = $2', [await defaultWatchlistId(tx, user.id), req.params.symbol.toUpperCase()]),
      );
      res.json({ ok: true });
    }),
  );

  return r;
}
