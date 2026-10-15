import nodemailer from 'nodemailer';
import type { AppConfig } from '../config';
import { log } from './logger';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  /** 'smtp' gửi thật; 'log' chỉ ghi nội dung ra log (khi chưa cấu hình SMTP) */
  readonly kind: 'smtp' | 'log';
  send(msg: MailMessage): Promise<void>;
}

export function createMailer(cfg: Pick<AppConfig, 'smtp' | 'mailFrom'>): Mailer {
  if (!cfg.smtp) {
    return {
      kind: 'log',
      async send(msg) {
        log.warn('[mail] SMTP chưa cấu hình — email KHÔNG được gửi, nội dung ghi ra log', { to: msg.to, subject: msg.subject, text: msg.text });
      },
    };
  }
  const { host, port, secure, user, pass } = cfg.smtp;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    kind: 'smtp',
    async send(msg) {
      const info = await transport.sendMail({ from: cfg.mailFrom, ...msg });
      log.info('[mail] đã gửi', { to: msg.to, subject: msg.subject, messageId: info.messageId });
    },
  };
}
