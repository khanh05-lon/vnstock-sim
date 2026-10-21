/**
 * Tải logo thật của coin (nguồn: CDN ảnh của Binance — cùng nguồn giá của sàn) về frontend/public/coins/<TÀI SẢN>.png
 * và ghi danh sách logo đang có vào frontend/src/components/common/coinIcons.gen.ts:
 *   npm run coins:icons -w backend                 # các cặp mặc định + USDT, chỉ tải logo còn thiếu
 *   npm run coins:icons -w backend -- PENDLE JUP   # thêm tài sản vừa niêm yết
 *   npm run coins:icons -w backend -- --force      # tải lại tất cả
 * Lưu logo trong repo để web không phụ thuộc ảnh bên ngoài lúc chạy; tài sản chưa có logo hiện chữ cái đầu.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SYMBOLS, RULES } from '@vss/shared';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.join(root, 'frontend/public/coins');
const manifest = path.join(root, 'frontend/src/components/common/coinIcons.gen.ts');
const source = (asset: string) => `https://bin.bnbstatic.com/static/assets/logos/${asset}.png`;

const args = process.argv.slice(2);
const force = args.includes('--force');
const extra = args.filter((a) => !a.startsWith('--')).map((a) => a.toUpperCase());
if (extra.some((a) => !/^[A-Z0-9]{1,20}$/.test(a))) throw new Error('Mã tài sản chỉ gồm chữ in hoa và số');

const quotes = DEFAULT_SYMBOLS.map((s) => s.slice(0, -RULES.quoteAsset.length));
const assets = [...new Set([...quotes, RULES.quoteAsset, ...extra])];
fs.mkdirSync(dir, { recursive: true });

let fetched = 0;
for (const asset of assets) {
  const file = path.join(dir, `${asset}.png`);
  if (!force && fs.existsSync(file)) continue;
  const res = await fetch(source(asset));
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !type.startsWith('image/')) {
    console.warn(`Bỏ qua ${asset}: không có logo (${res.status} ${type})`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // PNG bắt đầu bằng 89 50 4E 47; logo coin vài chục KB là cùng
  if (buf.subarray(0, 4).toString('hex') !== '89504e47' || buf.length > 300_000) {
    console.warn(`Bỏ qua ${asset}: tệp không phải PNG hợp lệ (${buf.length} byte)`);
    continue;
  }
  fs.writeFileSync(file, buf);
  fetched++;
}

const have = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .sort();
fs.writeFileSync(
  manifest,
  `// Tự sinh bởi \`npm run coins:icons -w backend\` — đừng sửa tay\n` +
    `/** Tài sản có logo thật trong frontend/public/coins (nguồn ảnh: Binance) */\n` +
    `export const COIN_ICONS: ReadonlySet<string> = new Set(${JSON.stringify(have)});\n`,
);
console.log(`Đã tải ${fetched} logo; có ${have.length} logo trong ${dir}`);
