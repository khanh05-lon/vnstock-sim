/* =====================================================================================
 * Bộ lọc nội dung Cộng đồng (lớp 1 của kiểm duyệt) — dùng chung FE (cảnh báo khi đang gõ) và BE (quyết định thật).
 *
 * moderateText(text, extra) → ALLOW | REVIEW (giữ lại chờ kiểm duyệt viên) | BLOCK (từ chối đăng).
 * Từ điển so trên văn bản đã chuẩn hoá: chữ thường, bỏ dấu, đổi leetspeak, bỏ ký tự chen giữa các chữ đơn
 * ("đ.m", "d m m"), rút gọn chữ lặp. Từ dễ trùng nghĩa khi bỏ dấu (lồn / lớn, cặc / các, đĩ / đi) chỉ so bản CÓ dấu.
 * Từ do quản trị thêm (SQUARE_RULES.extraBlockWords / extraReviewWords) chỉ có ở BE — không gửi cho FE để tránh bị dò.
 * ===================================================================================== */

export type ModRule =
  | 'PROFANITY'
  | 'HARASSMENT'
  | 'PII'
  | 'LINK'
  | 'ADULT'
  | 'GAMBLING'
  | 'DRUGS'
  | 'SCAM'
  | 'MANIPULATION'
  | 'IMPERSONATION'
  | 'POLITICS'
  | 'SPAM'
  | 'CUSTOM';

export type ModAction = 'BLOCK' | 'REVIEW';
export type ModVerdict = 'ALLOW' | ModAction;

export const MOD_RULES: readonly ModRule[] = [
  'PROFANITY',
  'HARASSMENT',
  'PII',
  'LINK',
  'ADULT',
  'GAMBLING',
  'DRUGS',
  'SCAM',
  'MANIPULATION',
  'IMPERSONATION',
  'POLITICS',
  'SPAM',
  'CUSTOM',
];

export const MOD_RULE_LABEL: Record<ModRule, string> = {
  PROFANITY: 'Ngôn từ tục tĩu',
  HARASSMENT: 'Xúc phạm, quấy rối',
  PII: 'Lộ thông tin cá nhân / ví',
  LINK: 'Liên kết ngoài không được phép',
  ADULT: 'Nội dung người lớn',
  GAMBLING: 'Cờ bạc, cá độ',
  DRUGS: 'Chất cấm',
  SCAM: 'Dấu hiệu lừa đảo, kéo giao dịch ra ngoài sàn',
  MANIPULATION: 'Hô hào kéo giá, cam kết lợi nhuận',
  IMPERSONATION: 'Mạo danh VNCoin / nhân viên',
  POLITICS: 'Chính trị, tôn giáo nhạy cảm',
  SPAM: 'Spam',
  CUSTOM: 'Từ ngữ bị cấm theo quy định của sàn',
};

/** Hướng dẫn ngắn cho người viết (FE hiện khi bộ lọc khớp) */
export const MOD_RULE_HINT: Record<ModRule, string> = {
  PROFANITY: 'Bỏ từ ngữ thô tục.',
  HARASSMENT: 'Tranh luận về ý kiến, không công kích người khác.',
  PII: 'Không đăng số điện thoại, email, số tài khoản, số giấy tờ, địa chỉ ví, seed phrase hay khoá bí mật — kể cả của chính bạn.',
  LINK: 'Chỉ được dẫn liên kết tới các trang trong danh sách cho phép (Binance, CoinMarketCap, CoinGecko, TradingView, VNCoin).',
  ADULT: 'Không đăng nội dung người lớn.',
  GAMBLING: 'Không quảng cáo cờ bạc, cá độ, nhà cái.',
  DRUGS: 'Không đề cập mua bán chất cấm.',
  SCAM: 'Không rủ nhắn riêng, vào nhóm Zalo / Telegram hay giao dịch ngoài sàn. Bài sẽ chờ kiểm duyệt.',
  MANIPULATION: 'Không hô hào cùng mua / kéo giá, không hứa hẹn lợi nhuận. Bài sẽ chờ kiểm duyệt.',
  IMPERSONATION: 'Không xưng là nhân viên / quản trị VNCoin. Bài sẽ chờ kiểm duyệt.',
  POLITICS: 'Nội dung chính trị, tôn giáo sẽ chờ kiểm duyệt.',
  SPAM: 'Viết bình thường (không viết hoa toàn bộ, không lặp ký tự, tối đa 5 thẻ $coin / #chủ đề). Bài sẽ chờ kiểm duyệt.',
  CUSTOM: 'Nội dung có từ ngữ sàn không cho phép.',
};

export const MOD_RULE_ACTION: Record<ModRule, ModAction> = {
  PROFANITY: 'BLOCK',
  HARASSMENT: 'BLOCK',
  PII: 'BLOCK',
  LINK: 'BLOCK',
  ADULT: 'BLOCK',
  GAMBLING: 'BLOCK',
  DRUGS: 'BLOCK',
  SCAM: 'REVIEW',
  MANIPULATION: 'REVIEW',
  IMPERSONATION: 'REVIEW',
  POLITICS: 'REVIEW',
  SPAM: 'REVIEW',
  CUSTOM: 'BLOCK',
};

export interface ModHit {
  rule: ModRule;
  action: ModAction;
  /** Đoạn khớp (cho kiểm duyệt viên / chính tác giả xem) */
  excerpt: string;
}

export interface ModResult {
  verdict: ModVerdict;
  hits: ModHit[];
}

/* ---------------------------------- chuẩn hoá ---------------------------------- */

/** Chữ thường, bỏ dấu tiếng Việt (đ → d) */
export function foldVi(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i' };

/** Rút gọn chữ lặp liên tiếp (vcllll → vcl, ngooo → ngo) — áp cho cả văn bản lẫn từ điển nên so khớp nhất quán */
const squeeze = (w: string) => w.replace(/(.)\1+/g, '$1');

/** Đổi leetspeak chỉ trong từ vừa có chữ vừa có số / ký hiệu (d1t, l0n, f@ck) — không đụng vào số thuần (giá, 100x) */
function deLeet(token: string): string {
  if (!/[a-z]/.test(token) || !/[0-9@$!]/.test(token)) return token;
  if (/^\d+[a-z]{1,2}$/.test(token)) return token; // 100x, 20k, 5m
  return token.replace(/[0-9@$!]/g, (c) => LEET[c] ?? c);
}

/** Tách từ: giữ chữ / số / @$! (cho leet), mọi thứ khác là khoảng trắng */
function tokens(s: string, letters: RegExp): string[] {
  return s
    .split(/\s+/)
    .flatMap((w) => w.replace(letters, ' ').split(' '))
    .filter(Boolean);
}

/** Gộp các chữ đơn đứng liền nhau: "d m m" → "dmm", "o c c h o" → "occho" */
function joinSingles(ws: string[]): string[] {
  const out: string[] = [];
  let run = '';
  for (const w of ws) {
    if (w.length === 1 && /[a-z]/.test(w)) run += w;
    else {
      if (run.length >= 2) out.push(squeeze(run));
      run = '';
    }
  }
  if (run.length >= 2) out.push(squeeze(run));
  return out;
}

interface Prepared {
  /** Văn bản gốc */
  raw: string;
  /** Chữ thường, bỏ dấu (cho regex PII / link / số) */
  folded: string;
  /** " w1 w2 … " — từ đã bỏ dấu, đổi leet, rút gọn chữ lặp (so cụm từ) */
  line: string;
  /** Tập từ dạng gọn: từng từ + cụm chữ đơn đã gộp (so từ viết liền / bị chèn dấu chấm) */
  compact: Set<string>;
  /** " w1 w2 … " — từ CÒN dấu, chữ thường (so từ dễ trùng nghĩa khi bỏ dấu) */
  accented: string;
}

function prepare(text: string): Prepared {
  // Bỏ thẻ $coin trước để "$BTC" không thành "sbtc"
  const noTags = text.replace(/\$[A-Za-z][A-Za-z0-9]{1,9}\b/g, ' ');
  const folded = foldVi(text);
  const ws = tokens(foldVi(noTags), /[^a-z0-9@$!]+/g).map(deLeet).map((w) => squeeze(w.replace(/[@$!]/g, '')));
  const words = ws.filter(Boolean);
  const accentedWords = tokens(noTags.normalize('NFC').toLowerCase(), /[^\p{L}\p{N}]+/gu);
  return {
    raw: text,
    folded,
    line: ` ${words.join(' ')} `,
    compact: new Set([...words, ...joinSingles(words)]),
    accented: ` ${accentedWords.join(' ')} `,
  };
}

/* ---------------------------------- từ điển ---------------------------------- */

/** Mục từ điển: chuỗi thường = so sau khi bỏ dấu; `{ v, exact }` = chỉ so bản còn dấu */
type Term = string | { v: string; exact: true };
const exact = (v: string): Term => ({ v, exact: true });

/*
 * Nguyên tắc chọn từ: cụm bỏ dấu chỉ dùng khi KHÔNG trùng câu bình thường (vd. "dành để" → "danh de" nên "đánh đề" phải so bản có dấu;
 * "bộ máy", "thẳng cho", "máy chết", "báo lại", "chế độ" cũng vậy). Thêm từ mới thì thêm câu bình thường tương ứng vào test.
 */
const DICT: Partial<Record<ModRule, Term[]>> = {
  PROFANITY: [
    // viết tắt / teencode
    'dm', 'dmm', 'dcm', 'dkm', 'dcmm', 'dmcs', 'dmml', 'vcl', 'vkl', 'vklm', 'clgt', 'cmn', 'cmnr', 'dmvl', 'loz', 'dit me', 'dit cu', 'dume',
    'ditme', 'djt', 'dit con me', 'vai lon', 'vai loz', 'cai loz', 'cave',
    // có dấu (bỏ dấu sẽ trùng từ bình thường)
    exact('lồn'), exact('cặc'), exact('buồi'), exact('đụ'), exact('địt'), exact('đéo'), exact('đếch'), exact('đĩ'), exact('cứt'), exact('lìn'),
    exact('chịch'), exact('nứng'), exact('dái'), exact('đụ má'), exact('đụ mẹ'),
    // tiếng Anh
    'fuck', 'fucking', 'fucker', 'fck', 'fuk', 'motherfucker', 'shit', 'bitch', 'cunt', 'dick', 'asshole', 'bastard',
  ],
  HARASSMENT: [
    'oc cho', 'oc lon', 'oc heo', 'oc trau', 'ngu nhu cho', 'ngu nhu bo', 'ngu nhu lon', 'suc vat', 'thu vat', 'thang ngu', 'con ngu', 'do ngu',
    'mat day', 'cut di', 'cut me', 'con cho cai', 'mat lon', 'ngu vl', 'ngu vcl', 'retard', 'idiot',
    exact('mẹ mày'), exact('bố mày'), exact('cha mày'), exact('mày chết'), exact('chết đi'), exact('thằng chó'), exact('đồ chó'),
  ],
  ADULT: ['sex', 'phim sex', 'chat sex', 'khieu dam', 'porn', 'jav', 'gai goi', 'gai bao', 'nude', 'khoa than', 'dit nhau', 'clip nong', 'onlyfans'],
  GAMBLING: [
    'nha cai', 'casino', 'tai xiu', 'xoc dia', 'game bai', 'no hu', 'ban ca doi thuong', 'keo nha cai', 'bet88', 'w88', 'fb88', '188bet', '1xbet',
    'kubet', 'jun88', 'hi88', 'new88', 'f8bet', 'shbet', exact('cá độ'), exact('lô đề'), exact('đánh đề'), exact('đánh lô'),
  ],
  DRUGS: ['ma tuy', 'can sa', 'thuoc lac', 'heroin', 'cocaine', 'ma tuy da', 'bay lac', 'weed', 'meth', 'ketamine', 'mua ke'],
  SCAM: [
    'ib', 'inbox', 'ib minh', 'ib em', 'nhan tin rieng', 'nt rieng', 'ket ban zalo', 'add zalo', 'zalo', 'telegram', 'tele', 'nhom kin', 'nhom vip',
    'keo vip', 'tin hieu vip', 'signal vip', 'giao dich ngoai san', 'mua ban ngoai san', 'ngoai san', 'chuyen khoan truoc', 'x2 tai khoan',
    'nhan uy thac', 'uy thac dau tu', 'nhan dau tu ho', 'dau tu ho', 'cam ket loi nhuan', 'cam ket lai', 'gui usdt cho', 'nap tien cho',
    'airdrop mien phi', 'nhan thuong ngay', 'lien he minh', 'lien he em', 'whatsapp', 'discord', exact('bao lãi'),
  ],
  MANIPULATION: [
    'bom gia', 'bom hang', 'keo gia', 'day gia', 'cung nhau mua', 'anh em vao lenh', 'ae vao lenh', 'ae vao het', 'chac chan len',
    'chac chan tang', 'chac an', 'dam bao lai', 'dam bao loi nhuan', 'pump', 'pump and dump', 'x100 chac chan', 'len 100x', 'lua ga',
    'to the moon chac chan', 'khong lo duoc', exact('bao lỗ'),
  ],
  IMPERSONATION: [
    'admin vncoin', 'nhan vien vncoin', 'cskh vncoin', 'ho tro vncoin', 'support vncoin', 'vncoin chinh thuc', 'doi ngu vncoin', 'toi la admin',
    'minh la admin', 'em la admin', 'ban quan tri san', 'nhan vien san',
  ],
  POLITICS: [
    'dang cong san', 'cong san', 'chinh phu', 'nha nuoc', 'bieu tinh', 'phan dong', 'chinh quyen', 'dan chu', 'nhan quyen', 'tong bi thu',
    'chu tich nuoc', 'thu tuong', 'quoc hoi', 'viet tan', 'ton giao', 'tham nhung', 'dao chinh', 'khung bo', 'bau cu',
  ],
};

/** Từ không được dùng trong @handle / tên hiển thị (mạo danh) — so trên chuỗi bỏ dấu, viết liền */
export const RESERVED_NAME_WORDS = [
  'vncoin', 'admin', 'administrator', 'cskh', 'support', 'hotro', 'official', 'chinhthuc', 'nhanvien', 'moderator', 'kiemduyet', 'binance', 'system',
  'staff', 'quantri',
] as const;

const BANK_WORDS =
  /\b(stk|so tai khoan|so tk|tk|ngan hang|nh|vietcombank|vcb|techcombank|tcb|mbbank|mb bank|mb|acb|bidv|vietinbank|agribank|tpbank|vpbank|sacombank|shb|hdbank|ocb|vib|msb|momo|zalopay|viettelpay|chuyen khoan|ck)\b/;
const SEED_WORDS = /\b(seed|seed phrase|cum tu khoi phuc|tu khoi phuc|mnemonic|recovery phrase|private key|khoa bi mat|12 tu|24 tu)\b/;

/** Tên miền luôn chặn (mời vào nhóm, rút gọn link) dù có trong danh sách cho phép */
const ALWAYS_BLOCKED_HOSTS = ['t.me', 'telegram.me', 'telegram.org', 'zalo.me', 'chat.zalo.me', 'discord.gg', 'discord.com', 'bit.ly', 'tinyurl.com', 'wa.me', 'shorturl.at', 'cutt.ly'];

const TLD = 'com|net|org|io|vn|me|co|xyz|app|gg|ly|to|info|biz|top|site|online|link|live|club|finance|exchange|pro|cc|tv|ai|so|us|uk|ru|cn|asia|website|store|shop|vip|fun|win|bet';
const URL_RE = new RegExp(`(?:https?:\\/\\/[^\\s]+|www\\.[^\\s]+|\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:${TLD})\\b(?:\\/[^\\s]*)?)`, 'gi');

const termValue = (t: Term) => (typeof t === 'string' ? t : t.v);

/** So 1 mục từ điển trên văn bản đã chuẩn hoá */
function matchTerm(p: Prepared, t: Term): boolean {
  if (typeof t !== 'string') return p.accented.includes(` ${t.v.normalize('NFC').toLowerCase()} `);
  const norm = foldVi(t)
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => squeeze(w))
    .join(' ');
  if (!norm) return false;
  if (p.line.includes(` ${norm} `)) return true;
  // Viết liền / chèn dấu chấm giữa các chữ: "d.i.t m.e" → "ditme", "đ.m" → "dm".
  // Cụm nhiều từ chỉ gộp khi ≥ 4 ký tự để tránh trùng ngẫu nhiên
  const glued = squeeze(norm.replace(/ /g, ''));
  return (glued.length >= 4 || !norm.includes(' ')) && p.compact.has(glued);
}

/* ---------------------------------- kiểm tra theo mẫu ---------------------------------- */

function piiHits(p: Prepared): string[] {
  const out: string[] = [];
  const raw = p.raw;
  // Email
  const email = raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  if (email) out.push(email[0]);
  // SĐT Việt Nam: 0 / +84 / 84 + đầu số di động, cho phép cách / chấm / gạch giữa các nhóm
  for (const m of raw.matchAll(/(?<![\d.,])(?:\+?84|0)(?:[ .\-]?\d){9}(?![\d])/g)) {
    const s = m[0];
    if (/^0\./.test(s)) continue; // số thập phân 0.xxx
    let d = s.replace(/\D/g, '');
    if (d.startsWith('84')) d = '0' + d.slice(2);
    if (d.length === 10 && /^0[35789]/.test(d)) out.push(s.trim());
  }
  // Dãy số dài (không dùng dấu chấm / phẩy như giá tiền): CCCD 12 số; 8–19 số cạnh từ khoá ngân hàng = số tài khoản
  const hasBankWord = BANK_WORDS.test(p.folded);
  for (const m of raw.matchAll(/(?<![\d.,])\d(?:[ \-]?\d){7,18}(?![\d.,]?\d)/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length === 12 && /^0\d{11}$/.test(d)) out.push(m[0]);
    else if (hasBankWord && d.length >= 8) out.push(m[0]);
  }
  // Khoá bí mật / mã giao dịch 64 hex, địa chỉ ví
  const key = raw.match(/\b(?:0x)?[a-f0-9]{64}\b/i);
  if (key) out.push(key[0].slice(0, 10) + '…');
  const wallet = raw.match(/\b0x[a-f0-9]{40}\b/i) ?? raw.match(/\bbc1[a-z0-9]{25,59}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b|\bT[1-9A-HJ-NP-Za-km-z]{33}\b/);
  if (wallet) out.push(wallet[0].slice(0, 10) + '…');
  // Seed phrase: có từ khoá + ≥ 12 từ tiếng Anh viết thường liên tiếp
  if (SEED_WORDS.test(p.folded)) {
    let run = 0;
    let best = 0;
    for (const w of raw.toLowerCase().split(/[\s,.;:\-]+/)) {
      run = /^[a-z]{3,8}$/.test(w) ? run + 1 : 0;
      best = Math.max(best, run);
    }
    if (best >= 12) out.push('seed phrase');
  }
  return out;
}

function hostOf(u: string): string {
  const s = u.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  return s.split(/[/?#:]/)[0]!.toLowerCase().replace(/\.+$/, '');
}

const hostAllowed = (host: string, allowed: readonly string[]) => allowed.some((a) => host === a || host.endsWith('.' + a));

function linkHits(p: Prepared, allowedDomains: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of p.raw.matchAll(URL_RE)) {
    const url = m[0].replace(/[),.!?]+$/, '');
    if (/^\d+(\.\d+)+$/.test(url)) continue; // số thập phân
    const host = hostOf(url);
    if (!host || /^\d/.test(host.split('.').pop() ?? '')) continue;
    if (hostAllowed(host, ALWAYS_BLOCKED_HOSTS) || !hostAllowed(host, allowedDomains)) out.push(url);
  }
  return out;
}

function spamHits(p: Prepared): string[] {
  const out: string[] = [];
  const letters = p.raw.replace(/\$[A-Za-z0-9]+|#[\p{L}\p{N}_]+/gu, '').match(/\p{L}/gu) ?? [];
  if (letters.length >= 20) {
    const upper = letters.filter((c) => c !== c.toLowerCase() && c === c.toUpperCase()).length;
    if (upper / letters.length > 0.7) out.push('VIẾT HOA');
  }
  const rep = p.raw.match(/(.)\1{5,}/u);
  if (rep && !/\d/.test(rep[1]!)) out.push(rep[0].slice(0, 8));
  const words = p.line.trim().split(' ');
  for (let i = 0; i + 4 < words.length; i++) {
    if (words[i] && words.slice(i, i + 5).every((w) => w === words[i])) {
      out.push(words[i]!);
      break;
    }
  }
  const { cashtags, hashtags } = parseTags(p.raw);
  if (cashtags.length > SQUARE_MAX_TAGS || hashtags.length > SQUARE_MAX_TAGS) out.push(`> ${SQUARE_MAX_TAGS} thẻ`);
  return out;
}

/** Hô hào lợi nhuận theo mẫu số: "lãi 10%/ngày", "x10 tài khoản" */
function manipulationPatterns(p: Prepared): string[] {
  const out: string[] = [];
  const a = p.folded.match(/(lai|loi nhuan)\s*\d+(?:[.,]\d+)?\s*%\s*(?:\/|moi|1|mot)\s*(ngay|tuan|thang)/);
  if (a) out.push(a[0]);
  const b = p.folded.match(/\bx\s?\d{1,4}\s*(tai khoan|von|lan)\b/);
  if (b) out.push(b[0]);
  return out;
}

/* ---------------------------------- API ---------------------------------- */

export const SQUARE_MAX_TAGS = 5;

export interface ModerationExtra {
  /** Từ chặn do quản trị thêm (chỉ BE) */
  blockWords?: readonly string[];
  /** Từ giữ lại chờ duyệt do quản trị thêm (chỉ BE) */
  reviewWords?: readonly string[];
  /** Tên miền được dẫn liên kết */
  allowedDomains?: readonly string[];
}

export const DEFAULT_ALLOWED_DOMAINS = ['binance.com', 'coinmarketcap.com', 'coingecko.com', 'tradingview.com', 'vncoin.vn'] as const;

/** Chạy bộ lọc. Kết quả BLOCK nếu có bất kỳ quy tắc chặn nào, REVIEW nếu chỉ có quy tắc giữ lại */
export function moderateText(text: string, extra: ModerationExtra = {}): ModResult {
  const p = prepare(text);
  const hits: ModHit[] = [];
  const add = (rule: ModRule, excerpt: string, action: ModAction = MOD_RULE_ACTION[rule]) => {
    if (!hits.some((h) => h.rule === rule && h.action === action)) hits.push({ rule, action, excerpt });
  };

  for (const [rule, terms] of Object.entries(DICT) as [ModRule, Term[]][]) {
    for (const t of terms) {
      if (matchTerm(p, t)) {
        add(rule, termValue(t));
        break;
      }
    }
  }
  for (const w of extra.blockWords ?? []) if (w.trim() && matchTerm(p, w)) add('CUSTOM', w, 'BLOCK');
  for (const w of extra.reviewWords ?? []) if (w.trim() && matchTerm(p, w)) add('CUSTOM', w, 'REVIEW');

  const pii = piiHits(p);
  if (pii.length) add('PII', pii[0]!);
  const links = linkHits(p, extra.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS);
  if (links.length) add('LINK', links[0]!);
  const manip = manipulationPatterns(p);
  if (manip.length) add('MANIPULATION', manip[0]!);
  const spam = spamHits(p);
  if (spam.length) add('SPAM', spam[0]!);

  const verdict: ModVerdict = hits.some((h) => h.action === 'BLOCK') ? 'BLOCK' : hits.length ? 'REVIEW' : 'ALLOW';
  return { verdict, hits };
}

/** Kiểm @handle / tên hiển thị: không được có từ mạo danh hay bất kỳ vi phạm nào (tên không thể "chờ duyệt") */
export function moderateName(name: string, extra: ModerationExtra = {}): ModResult {
  const r = moderateText(name, extra);
  const glued = foldVi(name).replace(/[^a-z0-9]/g, '');
  const reserved = RESERVED_NAME_WORDS.find((w) => glued.includes(w));
  const hits = r.hits.map((h) => ({ ...h, action: 'BLOCK' as const }));
  if (reserved && !hits.some((h) => h.rule === 'IMPERSONATION')) hits.push({ rule: 'IMPERSONATION', action: 'BLOCK', excerpt: reserved });
  return { verdict: hits.length ? 'BLOCK' : 'ALLOW', hits };
}

/** $COIN (chữ hoa, không trùng) và #chủ_đề (chữ thường, giữ dấu) trong bài */
export function parseTags(text: string): { cashtags: string[]; hashtags: string[] } {
  const cash = new Set<string>();
  for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) cash.add(m[1]!.toUpperCase());
  const hash = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\p{L}\p{N}_&])#([\p{L}\p{N}_]{2,30})/gu)) hash.add(m[1]!.toLowerCase());
  return { cashtags: [...cash], hashtags: [...hash] };
}
