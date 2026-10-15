/**
 * Giữ N dòng log gần nhất của tiến trình (stdout + stderr) trong bộ nhớ để trang Quản trị xem nhanh.
 * Chỉ phục vụ demo / chẩn đoán; log đầy đủ vẫn ra stdout để hệ thống thu log bên ngoài lưu trữ.
 */
export interface LogLine {
  time: string;
  stream: 'out' | 'err';
  text: string;
}

const MAX_LINES = 400;
const lines: LogLine[] = [];
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

function record(stream: 'out' | 'err', chunk: unknown) {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  for (const raw of text.split('\n')) {
    const t = raw.replace(ANSI, '').trimEnd();
    if (!t) continue;
    lines.push({ time: new Date().toISOString(), stream, text: t.length > 2000 ? `${t.slice(0, 2000)}…` : t });
  }
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
}

let installed = false;
export function installLogBuffer() {
  if (installed) return;
  installed = true;
  for (const [name, stream] of [
    ['out', process.stdout],
    ['err', process.stderr],
  ] as const) {
    const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
    (stream as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
      try {
        record(name, chunk);
      } catch {
        /* không để việc ghi đệm làm hỏng log */
      }
      return original(chunk, ...rest);
    };
  }
}

export function recentLogs(limit = 200): LogLine[] {
  return lines.slice(-limit);
}

installLogBuffer();
