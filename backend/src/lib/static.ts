import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';

/**
 * Phục vụ frontend đã build (vite build) từ cùng máy chủ API:
 *  - /assets/* có hash trong tên file → cache 1 năm
 *  - mọi đường dẫn GET khác (không phải /api, /socket.io) → index.html (SPA, react-router)
 * Trả thêm hash SHA-256 của các <script> inline trong index.html để đưa vào CSP.
 */
export function serveFrontend(dir: string) {
  const indexFile = path.join(dir, 'index.html');
  if (!fs.existsSync(indexFile)) throw new Error(`FRONTEND_DIST=${dir} không có index.html — hãy chạy \`npm run build\``);
  const html = fs.readFileSync(indexFile, 'utf8');
  const inlineScriptHashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`,
  );

  const router = Router();
  router.use('/assets', express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '365d', index: false }));
  router.use('/assets', (_req, res) => void res.status(404).end());
  router.use(express.static(dir, { index: false, maxAge: '1h' }));
  router.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  return { router, inlineScriptHashes };
}
