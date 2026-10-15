// Chạy data-service bằng Python trong .venv (tự tạo venv + cài thư viện ở lần đầu).
//   node data-service/run.mjs           → khởi động API ở cổng DATA_SERVICE_PORT (mặc định 8001)
//   node data-service/run.mjs setup     → chỉ tạo venv và cài requirements.txt
//   node data-service/run.mjs test      → chạy unit test Python
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const win = process.platform === 'win32';
const venvPy = path.join(dir, '.venv', win ? 'Scripts/python.exe' : 'bin/python');
const cmd = process.argv[2] ?? 'serve';

function run(exe, args) {
  const r = spawnSync(exe, args, { cwd: dir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function systemPython() {
  const candidates = win ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [exe, pre] of candidates) {
    const r = spawnSync(exe, [...pre, '--version'], { encoding: 'utf8' });
    if (r.status === 0) return [exe, pre];
  }
  console.error('[data-service] không tìm thấy Python 3 — cài Python ≥ 3.10 rồi chạy lại');
  process.exit(1);
}

function setup() {
  if (!fs.existsSync(venvPy)) {
    const [exe, pre] = systemPython();
    console.log('[data-service] tạo môi trường ảo .venv ...');
    run(exe, [...pre, '-m', 'venv', '.venv']);
  }
  console.log('[data-service] cài thư viện (requirements.txt) ...');
  run(venvPy, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt']);
}

if (cmd === 'setup') {
  setup();
} else if (cmd === 'test') {
  if (!fs.existsSync(venvPy)) setup();
  run(venvPy, ['-m', 'unittest', 'discover', '-s', 'tests', '-t', '.']);
} else {
  if (!fs.existsSync(venvPy)) setup();
  const port = process.env.DATA_SERVICE_PORT ?? '8001';
  const child = spawn(venvPy, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', port], { cwd: dir, stdio: 'inherit' });
  const stop = () => child.kill();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
}
