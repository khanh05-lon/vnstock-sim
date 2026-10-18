import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api, errMsg } from '../../lib/api';
import { cleanDecimal } from '../../lib/format';
import { fmtVndNum, useBank, useInvalidateP2P } from '../../lib/p2p';
import { Modal } from '../common/ui';

/** So tên chủ tài khoản kiểu ngân hàng: bỏ dấu, in hoa, gộp khoảng trắng */
const bankName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

export interface TransferPreset {
  toAccountNo: string;
  amount: string;
  memo: string;
  /** Tên chủ tài khoản dự kiến (để người chuyển đối chiếu) */
  holderName?: string;
}

/**
 * Chuyển khoản trong ngân hàng giả lập (bên ngoài sàn). Tra tên chủ tài khoản trước khi chuyển như app ngân hàng thật.
 * Sàn KHÔNG biết lệnh chuyển này thuộc đơn P2P nào: người mua phải tự bấm "Tôi đã thanh toán" sau khi chuyển.
 */
export function TransferDialog({ open, preset, onClose, onDone }: { open: boolean; preset?: TransferPreset; onClose(): void; onDone?(): void }) {
  const { data: bank } = useBank();
  const invalidate = useInvalidateP2P();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [holder, setHolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Chỉ nạp dữ liệu điền sẵn lúc mở hộp (trang cha render lại mỗi giây vì đồng hồ đếm ngược, không được ghi đè thứ người dùng đang sửa)
  const presetKey = preset ? `${preset.toAccountNo}|${preset.amount}|${preset.memo}` : '';
  useEffect(() => {
    if (!open) return;
    const [no = '', amt = '', m = ''] = presetKey.split('|');
    setTo(no);
    setAmount(amt);
    setMemo(m);
  }, [open, presetKey]);

  useEffect(() => {
    setHolder(null);
    if (!/^\d{10}$/.test(to)) return;
    let alive = true;
    api<{ holderName: string } | null>(`/bank/lookup/${to}`)
      .then((r) => alive && setHolder(r?.holderName ?? ''))
      .catch(() => alive && setHolder(''));
    return () => {
      alive = false;
    };
  }, [to]);

  const submit = async () => {
    setBusy(true);
    try {
      await api('/bank/transfers', { method: 'POST', body: { toAccountNo: to, amount, memo } });
      toast.success(`Đã chuyển ${fmtVndNum(amount)} ₫ tới ${holder ?? to}`);
      invalidate();
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const insufficient = !!bank && !!amount && Number(amount) > Number(bank.balanceVnd);
  const mismatch = !!preset?.holderName && !!holder && bankName(holder) !== bankName(preset.holderName);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chuyển khoản (ngân hàng giả lập)"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Huỷ
          </button>
          <button className="btn btn-brand" disabled={busy || !holder || !amount || Number(amount) <= 0 || insufficient} onClick={() => void submit()}>
            Xác nhận chuyển
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {bank && (
          <div className="flex justify-between rounded-md bg-bg-2 px-3 py-2 text-[12px]">
            <span className="text-tx-3">
              Từ tài khoản {bank.accountNo} · {bank.bankName}
            </span>
            <span className="num font-semibold">{fmtVndNum(bank.balanceVnd)} ₫</span>
          </div>
        )}
        <label className="block">
          <span className="label">Số tài khoản nhận</span>
          <input className="input num mt-1" inputMode="numeric" maxLength={10} value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} />
          {holder === '' && <span className="mt-1 block text-[12px] text-down">Không tìm thấy tài khoản</span>}
          {holder && <span className="mt-1 block text-[12px] text-up">Chủ tài khoản: {holder}</span>}
          {mismatch && <span className="mt-1 block text-[12px] text-down">Tên chủ tài khoản khác với thông tin trên đơn ({preset!.holderName}) — kiểm tra lại</span>}
        </label>
        <label className="block">
          <span className="label">Số tiền (VNĐ)</span>
          <input className="input num mt-1" inputMode="numeric" value={amount} aria-invalid={insufficient} onChange={(e) => setAmount(cleanDecimal(e.target.value).split('.')[0]!)} />
          {amount && <span className="mt-1 block text-[12px] text-tx-3">{fmtVndNum(amount)} ₫</span>}
          {insufficient && <span className="mt-1 block text-[12px] text-down">Số dư ngân hàng không đủ</span>}
        </label>
        <label className="block">
          <span className="label">Nội dung chuyển khoản</span>
          <input className="input mt-1" maxLength={100} value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}
