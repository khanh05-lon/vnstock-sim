import bcrypt from 'bcryptjs';
import { Big, P2P_RULES } from '@vss/shared';
import type { Database } from '../db';
import { log } from '../lib/logger';
import { createUserAccount } from '../seed/seed';
import { credit, ledger, lockFunds } from '../trading/wallet';
import type { P2PService } from './service';

/**
 * Chỉ môi trường dev, khi đặt DEV_STAFF_PASSWORD: tạo 3 thương nhân mẫu đã được duyệt, mỗi người vài quảng cáo,
 * để chợ P2P không trống khi chạy thử. Email cùng tên miền với ADMIN_EMAIL: merchant1@, merchant2@, merchant3@.
 */
export async function seedDevMerchants(db: Database, p2p: P2PService) {
  const password = process.env.DEV_STAFF_PASSWORD;
  if (process.env.NODE_ENV === 'production' || !password) return;
  const domain = (process.env.ADMIN_EMAIL || 'admin@vncoin.local').split('@')[1] || 'vncoin.local';
  const merchants: { name: string; fullName: string; display: string; bank: string; usdtSell: string; usdtBuy: string; sellRatio: string; buyRatio: string; btc?: string }[] = [
    { name: 'merchant1', fullName: 'Thương nhân An Phát', display: 'AnPhat OTC', bank: 'Vietcombank', usdtSell: '5000', usdtBuy: '3000', sellRatio: '101.20', buyRatio: '99.40', btc: '0.05' },
    { name: 'merchant2', fullName: 'Thương nhân Bình Minh', display: 'BinhMinh Crypto', bank: 'Techcombank', usdtSell: '4000', usdtBuy: '2500', sellRatio: '101.50', buyRatio: '99.10' },
    { name: 'merchant3', fullName: 'Thương nhân Cát Tường', display: 'CatTuong Exchange', bank: 'MB Bank', usdtSell: '3000', usdtBuy: '2000', sellRatio: '100.90', buyRatio: '98.90' },
  ];
  const hash = await bcrypt.hash(password, 10);
  const created: string[] = [];
  for (const m of merchants) {
    const email = `${m.name}@${domain}`;
    if (await db.one('SELECT 1 FROM users WHERE email = $1', [email])) continue;
    const userId = await db.tx(async (tx) => {
      const user = await createUserAccount(tx, email, hash, m.fullName);
      await tx.many(`UPDATE users SET email_verified_at = now(), display_name = $2, kyc_level = 2, kyc_name = $3, created_at = now() - interval '90 days' WHERE id = $1`, [
        user.id,
        m.display,
        m.fullName,
      ]);
      // Coin để bán (dev): ghi sổ cái như quản trị viên điều chỉnh để đối soát vẫn khớp
      if (m.btc) {
        const after = await credit(tx, user.id, 'BTC', m.btc);
        await ledger(tx, user.id, 'BTC', 'ADJUST', m.btc, after, null, 'Dev: số dư mẫu cho thương nhân');
      }
      await lockFunds(tx, user.id, 'USDT', P2P_RULES.merchantDepositUsdt);
      await tx.many(
        `INSERT INTO p2p_merchants (user_id, status, deposit_usdt, reviewed_at, reviewed_by, note)
         VALUES ($1, 'ACTIVE', $2, now(), 'Hệ thống (dev)', 'Thương nhân mẫu')`,
        [user.id, P2P_RULES.merchantDepositUsdt],
      );
      return user.id;
    });
    const pm = await p2p.addPaymentMethod(userId, { bankName: m.bank });
    const base = { asset: 'USDT' as const, priceType: 'FLOATING' as const, payMinutes: 15 as const, paymentMethodIds: [pm.id], minAccountDays: 0, online: true };
    await p2p.createAd(userId, {
      ...base,
      side: 'SELL',
      floatRatio: m.sellRatio,
      totalQty: m.usdtSell,
      minFiat: '200000',
      maxFiat: '50000000',
      terms: 'Chuyển khoản đúng số tiền, nội dung ghi mã đơn. Không ghi chữ "USDT", "coin" trong nội dung chuyển khoản.',
    });
    await p2p.createAd(userId, {
      ...base,
      side: 'BUY',
      floatRatio: m.buyRatio,
      totalQty: m.usdtBuy,
      minFiat: '500000',
      maxFiat: '30000000',
      terms: 'Tài khoản nhận tiền phải đứng tên chính chủ trùng tên tài khoản sàn.',
    });
    if (m.btc && p2p.refPrice('BTC')) {
      await p2p.createAd(userId, {
        ...base,
        asset: 'BTC',
        side: 'SELL',
        floatRatio: '101.00',
        totalQty: new Big(m.btc).times('0.8').toFixed(),
        minFiat: '1000000',
        maxFiat: '100000000',
        terms: 'Nhả coin trong 5 phút sau khi nhận tiền.',
      });
    }
    created.push(email);
  }
  if (created.length) log.info(`[p2p] (dev) đã tạo thương nhân mẫu: ${created.join(', ')}`);
}
