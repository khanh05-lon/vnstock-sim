/**
 * Sao lưu / khôi phục dữ liệu nghiệp vụ từ dòng lệnh (dùng khi ứng dụng đang TẮT, vd. cứu hộ).
 *
 *   npm run backup -w backend                          # xuất JSON vào BACKUP_DIR (mặc định backend/data/backups)
 *   npm run backup -w backend -- --out D:/sao-luu      # xuất vào thư mục khác
 *   npm run restore -w backend -- <file.json>          # chạy thử (không ghi gì) rồi hỏi lại
 *   npm run restore -w backend -- <file.json> --yes    # khôi phục thật (tự sao lưu dữ liệu hiện tại trước)
 *
 * Kết nối CSDL theo backend/.env: có DATABASE_URL → PostgreSQL, không có → PGlite tại DATA_DIR.
 * PGlite chỉ mở được bởi 1 tiến trình — phải tắt app trước khi chạy.
 */
import fs from 'node:fs';
import { config } from '../src/config';
import { Database } from '../src/db';
import { migrate } from '../src/migrate';
import { RestoreError, exportBackup, parseBackup, restoreBackup, writeBackupFile } from '../src/admin/backup';

const args = process.argv.slice(2);
const cmd = args[0];

async function open(): Promise<Database> {
  if (config.databaseUrl) return Database.connect(config.databaseUrl, { max: 2 });
  if (!fs.existsSync(config.dataDir)) throw new Error(`Không thấy CSDL PGlite tại ${config.dataDir}`);
  return Database.open(config.dataDir);
}

async function tradeDateOf(db: Database): Promise<string> {
  const r = await db.one<{ d: string }>('SELECT max(trade_date)::text AS d FROM price_snapshots');
  return r?.d ?? '';
}

async function main() {
  if (cmd !== 'export' && cmd !== 'restore') {
    console.log('Cách dùng: tsx scripts/backup.ts export [--out <thư mục>] | restore <file.json> [--yes]');
    process.exit(1);
  }
  const db = await open();
  try {
    await migrate(db);
    if (cmd === 'export') {
      const i = args.indexOf('--out');
      const dir = i >= 0 && args[i + 1] ? args[i + 1] : config.backupDir;
      const b = await exportBackup(db, { exportedBy: 'dòng lệnh', tradeDate: await tradeDateOf(db) });
      const file = writeBackupFile(dir, 'vnstock-backup', b);
      console.log(`Đã xuất bản sao lưu: ${file}`);
      console.log(Object.entries(b.counts).map(([k, v]) => `  ${k}: ${v}`).join('\n'));
      return;
    }
    const file = args[1];
    if (!file || !fs.existsSync(file)) throw new Error('Chỉ rõ file sao lưu cần khôi phục');
    const backup = parseBackup(fs.readFileSync(file));
    const dry = await restoreBackup(db, backup, { dryRun: true });
    console.log(`Bản sao lưu ngày ${backup.exportedAt} (bởi ${backup.exportedBy}), phiên bản ${backup.version}`);
    for (const t of dry.tables) console.log(`  ${t.name}: ${t.rows} dòng${t.ignoredColumns.length ? ` (bỏ qua cột: ${t.ignoredColumns.join(', ')})` : ''}`);
    for (const w of dry.warnings) console.log(`  ! ${w}`);
    if (!args.includes('--yes')) {
      console.log('\nChạy thử thành công, CHƯA ghi gì. Thêm --yes để khôi phục thật (dữ liệu hiện tại sẽ bị thay thế).');
      return;
    }
    const auto = writeBackupFile(config.backupDir, 'auto-before-restore', await exportBackup(db, { exportedBy: 'dòng lệnh (trước khi khôi phục)', tradeDate: await tradeDateOf(db) }));
    console.log(`Đã tự sao lưu dữ liệu hiện tại: ${auto}`);
    await restoreBackup(db, backup, { dryRun: false });
    console.log('Đã khôi phục xong. Khởi động lại ứng dụng.');
  } catch (err) {
    console.error(err instanceof RestoreError ? `Không khôi phục được: ${err.message}` : err);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void main();
