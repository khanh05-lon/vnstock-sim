import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import type { RulesPatch } from '@vss/shared';
import { useAdminAction, useAdminRules } from '../../lib/admin';
import { cn, fmtInt } from '../../lib/format';
import { Spinner } from '../common/ui';
import { ReasonModal, Section } from './adminUi';

/** 1 ô tham số: đường dẫn trong RULES, nhãn, đơn vị hiển thị và hệ số đổi (0.0015 ↔ 0,15%) */
interface Field {
  path: string;
  label: string;
  unit: string;
  scale: number;
  group: string;
  hint?: string;
}

const FIELDS: Field[] = [
  { group: 'Phí & thuế', path: 'feeRate', label: 'Phí giao dịch mỗi chiều', unit: '%', scale: 100, hint: 'Áp dụng cho lệnh đặt sau khi lưu' },
  { group: 'Phí & thuế', path: 'sellTaxRate', label: 'Thuế TNCN khi bán', unit: '%', scale: 100 },
  { group: 'Phí & thuế', path: 'dividendTaxRate', label: 'Thuế cổ tức / lãi trái phiếu bằng tiền', unit: '%', scale: 100 },
  { group: 'Biên độ giá', path: 'priceLimitPct.HOSE', label: 'HOSE', unit: '%', scale: 1, hint: 'Áp dụng từ phiên giao dịch kế tiếp' },
  { group: 'Biên độ giá', path: 'priceLimitPct.HNX', label: 'HNX', unit: '%', scale: 1 },
  { group: 'Biên độ giá', path: 'priceLimitPct.UPCOM', label: 'UPCOM', unit: '%', scale: 1 },
  { group: 'Biên độ giá', path: 'bondLimitPct', label: 'Trái phiếu niêm yết', unit: '%', scale: 1 },
  { group: 'Khối lượng tối đa mỗi lệnh', path: 'maxOrderQty.HOSE', label: 'HOSE', unit: 'CP', scale: 1 },
  { group: 'Khối lượng tối đa mỗi lệnh', path: 'maxOrderQty.HNX', label: 'HNX', unit: 'CP', scale: 1 },
  { group: 'Khối lượng tối đa mỗi lệnh', path: 'maxOrderQty.UPCOM', label: 'UPCOM', unit: 'CP', scale: 1 },
  { group: 'Tài khoản & tiền', path: 'initialCapital', label: 'Vốn ảo khi mở tài khoản', unit: 'đ', scale: 1, hint: 'Áp dụng cho tài khoản mới và khi đặt lại' },
  { group: 'Tài khoản & tiền', path: 'advanceFeeRateDaily', label: 'Phí ứng trước tiền bán', unit: '%/ngày', scale: 100 },
  { group: 'Tài khoản & tiền', path: 'depositRateYear', label: 'Lãi tiền gửi không kỳ hạn', unit: '%/năm', scale: 100 },
  { group: 'Ký quỹ (margin)', path: 'margin.interestRateYear', label: 'Lãi vay ký quỹ', unit: '%/năm', scale: 100 },
  { group: 'Ký quỹ (margin)', path: 'margin.initialRatio', label: 'Tỷ lệ ký quỹ ban đầu', unit: '%', scale: 100 },
  { group: 'Ký quỹ (margin)', path: 'margin.callRatio', label: 'Tỷ lệ duy trì (cảnh báo)', unit: '%', scale: 100 },
  { group: 'Ký quỹ (margin)', path: 'margin.forceRatio', label: 'Tỷ lệ xử lý (bán giải chấp)', unit: '%', scale: 100 },
  { group: 'Ký quỹ (margin)', path: 'margin.defaultCreditLimit', label: 'Hạn mức vay mặc định', unit: 'đ', scale: 1 },
];

const getPath = (o: unknown, path: string): number => path.split('.').reduce((a: unknown, k) => (a as Record<string, unknown>)?.[k], o) as number;

/** Hiển thị số theo đơn vị (0.0015 → "0.15") — làm tròn bỏ sai số dấu phẩy động */
const toText = (v: number, f: Field) => {
  const x = Math.round(v * f.scale * 1e6) / 1e6;
  return f.unit === 'đ' || f.unit === 'CP' ? fmtInt(x) : String(x);
};

const parse = (s: string) => Number(s.replace(/,/g, '').trim());

export function RulesEditor() {
  const { data, isLoading } = useAdminRules();
  const act = useAdminAction();
  const [form, setForm] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(FIELDS.map((f) => [f.path, toText(getPath(data.rules, f.path), f)])));
  }, [data]);

  const changes = useMemo(() => {
    if (!data) return [] as { f: Field; value: number }[];
    const out: { f: Field; value: number }[] = [];
    for (const f of FIELDS) {
      const raw = form[f.path];
      if (raw == null || raw.trim() === '') continue;
      const n = parse(raw);
      if (!Number.isFinite(n)) continue;
      const value = Math.round((n / f.scale) * 1e8) / 1e8;
      if (Math.abs(value - getPath(data.rules, f.path)) > 1e-9) out.push({ f, value });
    }
    return out;
  }, [form, data]);

  if (isLoading || !data) {
    return (
      <Section title="Tham số giao dịch">
        <Spinner />
      </Section>
    );
  }

  const invalid = FIELDS.some((f) => form[f.path] != null && !Number.isFinite(parse(form[f.path])));
  const groups = [...new Set(FIELDS.map((f) => f.group))];

  const save = async () => {
    const patch: Record<string, unknown> = {};
    for (const { f, value } of changes) {
      const [a, b] = f.path.split('.');
      if (b) patch[a] = { ...((patch[a] as object) ?? {}), [b]: value };
      else patch[a] = value;
    }
    await act('/admin/rules', 'PUT', patch as RulesPatch, `Đã lưu ${changes.length} tham số`);
  };

  return (
    <Section
      title="Tham số giao dịch"
      className="xl:col-span-2"
      actions={
        <>
          <button className="btn btn-ghost h-8" onClick={() => setResetOpen(true)} disabled={!Object.keys(data.overrides).length}>
            <RotateCcw size={14} /> Mặc định
          </button>
          <button className="btn btn-brand h-8" disabled={!changes.length || invalid} onClick={() => void save()}>
            <Save size={14} /> Lưu {changes.length ? `(${changes.length})` : ''}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => (
          <fieldset key={g} className="space-y-2">
            <legend className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-tx-3">{g}</legend>
            {FIELDS.filter((f) => f.group === g).map((f) => {
              const def = getPath(data.defaults, f.path);
              const cur = getPath(data.rules, f.path);
              const changed = changes.some((c) => c.f.path === f.path);
              return (
                <label key={f.path} className="block">
                  <span className="flex items-baseline justify-between gap-2 text-[12.5px]">
                    <span className="text-tx-2">{f.label}</span>
                    {Math.abs(cur - def) > 1e-9 && <span className="text-[11px] text-ref">mặc định {toText(def, f)}</span>}
                  </span>
                  <span className="mt-1 flex items-center gap-2">
                    <input
                      className={cn('input num h-8 text-right', changed && 'border-brand')}
                      inputMode="decimal"
                      value={form[f.path] ?? ''}
                      onChange={(e) => setForm((s) => ({ ...s, [f.path]: e.target.value }))}
                    />
                    <span className="w-14 shrink-0 text-[12px] text-tx-3">{f.unit}</span>
                  </span>
                  {f.hint && <span className="mt-0.5 block text-[11px] text-tx-3">{f.hint}</span>}
                </label>
              );
            })}
          </fieldset>
        ))}
      </div>
      <p className="mt-4 text-[12px] text-tx-3">
        Lô chẵn {fmtInt(data.rules.lotSize)} CP, loại lệnh theo sàn và T+{data.settlementDays} là quy định cố định. Phí / thuế được chốt theo từng lệnh lúc đặt — đổi biểu phí
        không ảnh hưởng lệnh đang chờ. Mọi thay đổi ghi vào nhật ký quản trị và áp dụng ngay cho mọi trình duyệt.
      </p>
      <ReasonModal
        open={resetOpen}
        title="Khôi phục tham số mặc định"
        description="Mọi tham số quay về giá trị gốc theo quy định tham khảo của HOSE / HNX / UPCOM."
        confirmLabel="Khôi phục"
        requireReason={false}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          if (await act('/admin/rules', 'DELETE', undefined, 'Đã khôi phục tham số mặc định')) setResetOpen(false);
        }}
      />
    </Section>
  );
}

