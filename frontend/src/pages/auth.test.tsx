import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { mockFetch, renderApp } from '../test/render';
import { MfaStep } from './AuthPage';
import ForgotPasswordPage from './ForgotPasswordPage';
import ResetPasswordPage from './ResetPasswordPage';

describe('Quên mật khẩu', () => {
  it('báo lỗi email sai định dạng, không gọi API', async () => {
    const calls = mockFetch({});
    renderApp(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'khong-phai-email' } });
    fireEvent.click(screen.getByRole('button', { name: /gửi link/i }));
    expect(await screen.findByText(/email không hợp lệ/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('gửi yêu cầu rồi hiện hướng dẫn kiểm tra hộp thư (không tiết lộ email có tồn tại hay không)', async () => {
    const calls = mockFetch({ '/api/auth/forgot-password': () => ({ json: { ok: true } }) });
    renderApp(<ForgotPasswordPage />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Lan@Example.test ' } });
    fireEvent.click(screen.getByRole('button', { name: /gửi link/i }));
    expect(await screen.findByText(/kiểm tra hộp thư/i)).toBeTruthy();
    expect(calls[0]).toMatchObject({ method: 'POST', body: { email: 'lan@example.test' } });
  });
});

describe('Đặt lại mật khẩu', () => {
  it('thiếu token → báo link không còn hiệu lực', () => {
    renderApp(<ResetPasswordPage />, '/reset-password');
    expect(screen.getByText(/link không còn hiệu lực/i)).toBeTruthy();
  });

  it('mật khẩu nhập lại không khớp → báo lỗi tại chỗ', async () => {
    const calls = mockFetch({});
    const { container } = renderApp(<ResetPasswordPage />, `/reset-password?token=${'a'.repeat(43)}`);
    const [pw, confirm] = container.querySelectorAll('input[type="password"]');
    fireEvent.change(pw, { target: { value: 'matkhau123' } });
    fireEvent.change(confirm, { target: { value: 'matkhau124' } });
    fireEvent.click(screen.getByRole('button', { name: /lưu mật khẩu mới/i }));
    expect(await screen.findByText(/không khớp/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('token hết hạn (400 RESET_TOKEN_INVALID) → chuyển sang màn hình yêu cầu link mới', async () => {
    mockFetch({
      '/api/auth/reset-password': () => ({ status: 400, json: { error: { code: 'RESET_TOKEN_INVALID', message: 'Link hết hạn' } } }),
    });
    const { container } = renderApp(<ResetPasswordPage />, `/reset-password?token=${'a'.repeat(43)}`);
    const [pw, confirm] = container.querySelectorAll('input[type="password"]');
    fireEvent.change(pw, { target: { value: 'matkhau123' } });
    fireEvent.change(confirm, { target: { value: 'matkhau123' } });
    fireEvent.click(screen.getByRole('button', { name: /lưu mật khẩu mới/i }));
    expect(await screen.findByText(/đã hết hạn/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /yêu cầu link mới/i }).getAttribute('href')).toBe('/forgot-password');
  });
});

describe('Bước nhập mã 2FA khi đăng nhập', () => {
  it('chỉ nhận chữ số, đủ 6 số mới bấm được; gửi kèm vé tạm', async () => {
    const calls = mockFetch({ '/api/auth/login/2fa': () => ({ json: { token: 't', user: { id: '1', email: 'a@b.c', fullName: 'A' } } }) });
    const done = vi.fn();
    renderApp(<MfaStep mfaToken={'x'.repeat(30)} onDone={done} onCancel={() => undefined} />);
    const input = screen.getByRole('textbox');
    const button = screen.getByRole('button', { name: /xác nhận/i }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: '12a3' } });
    expect((input as HTMLInputElement).value).toBe('123');
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '123456' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls[0].body).toEqual({ mfaToken: 'x'.repeat(30), code: '123456' });
  });

  it('chuyển sang mã khôi phục', () => {
    renderApp(<MfaStep mfaToken={'x'.repeat(30)} onDone={() => undefined} onCancel={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /dùng mã khôi phục/i }));
    expect((screen.getByRole('textbox') as HTMLInputElement).placeholder).toBe('xxxx-xxxx');
  });
});
