import type { Database } from '../db';
import { log } from '../lib/logger';

/**
 * Chỉ môi trường dev (đặt DEV_STAFF_PASSWORD): hồ sơ Cộng đồng + vài bài mẫu của các thương nhân mẫu (merchant1@…3@)
 * để bảng tin không trống khi chạy thử. Chạy sau seedDevMerchants; đã có bài thì bỏ qua.
 */
export async function seedDevSquare(db: Database) {
  if (process.env.NODE_ENV === 'production' || !process.env.DEV_STAFF_PASSWORD) return;
  if (await db.one('SELECT 1 FROM square_posts LIMIT 1')) return;
  const domain = (process.env.ADMIN_EMAIL || 'admin@vncoin.local').split('@')[1] || 'vncoin.local';
  const people = [
    { name: 'merchant1', handle: 'anphat_otc', display: 'An Phát OTC', bio: 'Giao dịch Spot từ 2019, chủ yếu BTC / ETH. Nhận định là quan điểm cá nhân.' },
    { name: 'merchant2', handle: 'minh_swing', display: 'Minh Swing', bio: 'Swing trade altcoin, quản lý vốn là trên hết.' },
    { name: 'merchant3', handle: 'linh_hodl', display: 'Linh HODL', bio: 'DCA hằng tuần, không all-in.' },
  ];
  const ids: string[] = [];
  for (const p of people) {
    const u = await db.one<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${p.name}@${domain}`]);
    if (!u) return;
    ids.push(u.id);
    await db.many(
      `INSERT INTO square_profiles (user_id, handle, display_name, bio, guidelines_accepted_at, created_at) VALUES ($1, $2, $3, $4, now(), now() - interval '20 days')
       ON CONFLICT (user_id) DO NOTHING`,
      [u.id, p.handle, p.display, p.bio],
    );
  }
  const posts: [number, string, string | null, string[], string[], number][] = [
    [0, '$BTC giữ vững vùng hỗ trợ, khối lượng mua tăng dần. Mình canh mua thêm nếu đóng nến ngày trên kháng cự gần nhất. #phantich', 'BULLISH', ['BTC'], ['phantich'], 30],
    [1, 'Altcoin đang yếu hơn $BTC rõ rệt, $SOL thủng đáy cũ. Đứng ngoài chờ tín hiệu rõ hơn, giữ USDT là một vị thế. #quanlyvon', 'BEARISH', ['BTC', 'SOL'], ['quanlyvon'], 20],
    [2, 'Tuần thứ 12 DCA $ETH, mỗi tuần một khoản cố định, không quan tâm giá ngắn hạn. Ai cùng DCA điểm danh nhé #DCA', 'BULLISH', ['ETH'], ['dca'], 14],
    [0, 'Nhắc anh em: VNCoin không bao giờ nhắn riêng hỏi mật khẩu hay bảo chuyển tiền. Ai tự xưng nhân viên rủ vào nhóm kín là lừa đảo, báo cáo ngay.', null, [], [], 8],
    [1, 'Bật trả phí bằng $BNB được giảm 25% phí, tính ra cũng đáng kể nếu giao dịch nhiều. Xem biểu phí VIP ở mục Biểu phí.', null, ['BNB'], [], 3],
  ];
  const postIds: number[] = [];
  for (const [who, body, sentiment, assets, tags, hoursAgo] of posts) {
    const r = await db.one<{ id: number }>(
      `INSERT INTO square_posts (user_id, body, sentiment, assets, hashtags, status, body_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, 'PUBLISHED', md5($2), now() - make_interval(hours => $6::int)) RETURNING id`,
      [ids[who], body, sentiment, assets, tags, hoursAgo],
    );
    postIds.push(r!.id);
  }
  const comments: [number, number, string][] = [
    [0, 1, 'Đồng ý, nhưng nhớ đặt dừng lỗ dưới hỗ trợ nhé.'],
    [0, 2, 'Mình vẫn DCA đều, không đoán đỉnh đáy.'],
    [2, 0, 'Điểm danh! Tuần thứ 8 rồi.'],
  ];
  for (const [post, who, body] of comments) {
    await db.many(`INSERT INTO square_comments (post_id, user_id, body, status) VALUES ($1, $2, $3, 'PUBLISHED')`, [postIds[post], ids[who], body]);
    await db.many('UPDATE square_posts SET comment_count = comment_count + 1 WHERE id = $1', [postIds[post]]);
  }
  const likes: [number, number][] = [
    [1, 0],
    [2, 0],
    [0, 2],
    [0, 3],
    [2, 3],
    [1, 2],
  ];
  for (const [who, post] of likes) {
    await db.many('INSERT INTO square_likes (user_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ids[who], postIds[post]]);
    await db.many('UPDATE square_posts SET like_count = like_count + 1 WHERE id = $1', [postIds[post]]);
  }
  await db.many('INSERT INTO square_follows (follower_id, followee_id) VALUES ($1, $2), ($3, $2) ON CONFLICT DO NOTHING', [ids[1], ids[0], ids[2]]);
  log.info('[square] đã tạo bài mẫu cho Cộng đồng (dev)');
}
