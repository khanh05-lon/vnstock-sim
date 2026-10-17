import type { AddressInfo } from 'node:net';
import http from 'node:http';
import express from 'express';
import bcrypt from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiChatTurn, AiStreamEvent } from '@vss/shared';
import type { Database } from '../src/db';
import { errorHandler } from '../src/lib/errors';
import { initSessionCheck, signSupportTicket, signToken } from '../src/lib/auth';
import type { Mailer } from '../src/lib/mailer';
import { supportRoutes } from '../src/routes/support';
import { createUserAccount } from '../src/seed/seed';
import { SupportAssistant, type AiBackend } from '../src/support/ai';
import { SupportService } from '../src/support/service';
import { closeTestDb, openTestDb } from './helpers/db';
import { FakeMarket } from './helpers/fakeMarket';

/** Thay Claude API: ghi lại tham số, trả lời theo kịch bản */
class FakeAi implements AiBackend {
  readonly model = 'fake';
  calls: { system: string[]; messages: AiChatTurn[] }[] = [];
  chunks = ['Phí ', 'giao dịch ', 'là **0,1%**.'];
  fail: Error | null = null;
  async stream(p: { system: string[]; messages: AiChatTurn[] }, onText: (t: string) => void) {
    this.calls.push({ system: p.system, messages: p.messages });
    if (this.fail) throw this.fail;
    for (const c of this.chunks) onText(c);
    return { inputTokens: 10, outputTokens: 5 };
  }
}

let db: Database;
const servers: http.Server[] = [];
let on: string;
let off: string;
const ai = new FakeAi();
let alice: { id: string; token: string; ticket: string };

async function listen(app: express.Express) {
  const s = app.listen(0);
  servers.push(s);
  await new Promise((r) => s.once('listening', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
}

async function chat(base: string, token: string | null, messages: unknown) {
  const res = await fetch(`${base}/support/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ messages }),
  });
  const text = await res.text();
  const events = res.headers.get('content-type')?.includes('ndjson')
    ? text
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AiStreamEvent)
    : [];
  return { status: res.status, events, json: events.length ? null : (JSON.parse(text) as { error: { code: string } }) };
}

beforeAll(async () => {
  db = await openTestDb();
  initSessionCheck(db);
  const mailer: Mailer = { kind: 'smtp', send: async () => undefined };
  const support = new SupportService(db, mailer);
  const market = new FakeMarket();
  market.add('BTCUSDT', 'BTC', '80000');
  const mk = (assistant: SupportAssistant | null) => {
    const app = express();
    app.use(express.json());
    app.use('/api', supportRoutes(support, assistant));
    app.use(errorHandler);
    return app;
  };
  on = await listen(mk(new SupportAssistant(db, market, ai)));
  off = await listen(mk(new SupportAssistant(db, market, null)));
  const u = await db.tx(async (tx) => createUserAccount(tx, 'alice-ai@example.test', await bcrypt.hash('matkhau123', 4), 'Alice'));
  const au = { id: u.id, email: 'alice-ai@example.test' };
  alice = { id: u.id, token: signToken(au), ticket: signSupportTicket(au) };
});

afterAll(async () => {
  initSessionCheck(null);
  for (const s of servers) await new Promise((r) => s.close(r));
  await closeTestDb(db);
});

describe('Trợ lý AI hỗ trợ khách', () => {
  it('chưa có khoá API → báo tắt, không gọi được', async () => {
    const st = await fetch(`${off}/support/ai`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(await st.json()).toEqual({ enabled: false });
    const r = await chat(off, alice.token, [{ role: 'user', content: 'Phí bao nhiêu?' }]);
    expect(r.status).toBe(503);
    expect(r.json?.error.code).toBe('AI_DISABLED');
  });

  it('stream câu trả lời; trợ lý nhận biểu phí và dữ liệu tài khoản của chính khách', async () => {
    const st = await fetch(`${on}/support/ai`, { headers: { Authorization: `Bearer ${alice.token}` } });
    expect(await st.json()).toEqual({ enabled: true });
    const r = await chat(on, alice.token, [
      // lượt trợ lý đứng đầu bị bỏ (Claude yêu cầu tin đầu là của người dùng)
      { role: 'assistant', content: 'Xin chào' },
      { role: 'user', content: 'Phí giao dịch bao nhiêu?' },
    ]);
    expect(r.status).toBe(200);
    expect(r.events.filter((e) => 't' in e).map((e) => (e as { t: string }).t).join('')).toBe('Phí giao dịch là **0,1%**.');
    expect(r.events.at(-1)).toEqual({ done: true });
    const call = ai.calls.at(-1)!;
    expect(call.messages).toEqual([{ role: 'user', content: 'Phí giao dịch bao nhiêu?' }]);
    expect(call.system[0]).toContain('maker 0.1%');
    expect(call.system[0]).toContain('KHÔNG bao giờ hỏi mật khẩu');
    expect(call.system[1]).toMatch(/- USDT: 10000(\.0+)? \/ 0/);
    expect(call.system[1]).toContain('Không có lệnh đang mở');
  });

  it('kiểm tra đầu vào: tin cuối phải là câu hỏi, câu hỏi không quá dài; cần đăng nhập', async () => {
    expect((await chat(on, alice.token, [{ role: 'assistant', content: 'x' }])).status).toBe(400);
    expect((await chat(on, alice.token, [{ role: 'user', content: 'a'.repeat(2001) }])).status).toBe(400);
    expect((await chat(on, alice.token, [])).status).toBe(400);
    expect((await chat(on, null, [{ role: 'user', content: 'hi' }])).status).toBe(401);
  });

  it('tài khoản bị khoá (vé hỗ trợ) không dùng trợ lý AI, chỉ nhắn nhân viên', async () => {
    const st = await fetch(`${on}/support/ai`, { headers: { Authorization: `Bearer ${alice.ticket}` } });
    expect(await st.json()).toEqual({ enabled: false });
    const r = await chat(on, alice.ticket, [{ role: 'user', content: 'Mở khoá giúp tôi' }]);
    expect(r.status).toBe(403);
    expect(r.json?.error.code).toBe('SUPPORT_ONLY');
  });

  it('Claude lỗi giữa chừng → khách nhận câu báo lỗi dễ hiểu trong stream', async () => {
    ai.fail = new Error('boom');
    try {
      const r = await chat(on, alice.token, [{ role: 'user', content: 'Xin chào' }]);
      expect(r.status).toBe(200);
      const last = r.events.at(-1) as { error: string };
      expect(last.error).toMatch(/Gặp nhân viên/);
      expect(JSON.stringify(r.events)).not.toContain('boom');
    } finally {
      ai.fail = null;
    }
  });
});
