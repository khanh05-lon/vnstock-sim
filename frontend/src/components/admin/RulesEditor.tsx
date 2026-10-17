import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { Big, type RulesPatch, type TradingRules } from '@vss/shared';
import { useAdminAction, useAdminMe, useAdminRules } from '../../lib/admin';
import { cn } from '../../lib/format';
import { Spinner } from '../common/ui';
import { ReasonModal, Section } from './adminUi';

/** 1 ô tham số: khoá trong RULES, nhãn, đơn vị hiển thị và hệ số đổi (0.001 ↔ 0,1%) */
interface Field {
  key: keyof RulesPatch;
  label: string;
  unit: string;
  scale: number;
  hint?: string;
}

const FIELDS: Field[] = [
  { key: 'makerFee', label: 'Phí maker', unit: '%', scale: 100, hint: 'Lệnh nằm chờ trên sổ rồi được khớp' },
  { key: 'takerFee', label: 'Phí taker', unit: '%', scale: 100, hint: 'Lệnh khớp ngay với sổ lệnh' },
  { key: 'bnbDiscount', label: 'Giảm phí khi trả bằng BNB', unit: '%', scale: 100 },
  { key: 'initialUsdt', label: 'Vốn ảo khi mở tài khoản', unit: 'USDT', scale: 1, hint: 'Áp dụng cho tài khoản mới và khi đặt lại' },
];

const toText = (v: string, f: Field) => new Big(v).times(f.scale).toFixed();
const fromText = (s: string, f: Field) => {
  const t = s.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  return new Big(t).div(f.scale).toFixed();
};

export function RulesEditor() {
  const { data, isLoading } = useAdminRules();
  const act = useAdminAction();
  const canEdit = useAdminMe().can('market.manage');
  const [form, setForm] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    setForm(Object.fromEntries(FIELDS.map((f) => [f.key, toText(data.rules[f.key as keyof TradingRules] as string, f)])));
  }, [data]);

  const changes = useMemo(() => {
    if (!data) return [] as { f: Field; value: string }[];
    const out: { f: Field; value: string }[] = [];
    for (const f of FIELDS) {
      const v = fromText(form[f.key] ?? '', f);
      if (v != null && !new Big(v).eq(data.rules[f.key as keyof TradingRules] as string)) out.push({ f, value: v });
    }
    return out;
  }, [form, data]);

  if (isLoading || !data) {
    return (
      <Section title="Biểu phí">
        <Spinner />
      </Section>
    );
  }

  const invalid = FIELDS.some((f) => form[f.key] && fromText(form[f.key]!, f) == null);

  const save = async () => {
    const patch = Object.fromEntries(changes.map((c) => [c.f.key, c.value])) as RulesPatch;
    await act('/admin/rules', 'PUT', patch, `Đã lưu ${changes.length} tham số`);
  };

  return (
    <Section
      title="Biểu phí và vốn ảo"
      className="xl:col-span-2"
      actions={
        <>
          <button className="btn btn-ghost h-8" onClick={() => setResetOpen(true)} disabled={!canEdit || !Object.keys(data.overrides).length}>
            <RotateCcw size={14} /> Mặc định
          </button>
          <button className="btn btn-brand h-8" disabled={!canEdit || !changes.length || invalid} onClick={() => void save()} title={canEdit ? undefined : 'Chỉ Vận hành thị trường được sửa biểu phí'}>
            <Save size={14} /> Lưu {changes.length ? `(${changes.length})` : ''}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2 xl:grid-cols-4">
        {FIELDS.map((f) => {
          const def = data.defaults[f.key as keyof TradingRules] as string;
          const cur = data.rules[f.key as keyof TradingRules] as string;
          const changed = changes.some((c) => c.f.key === f.key);
          return (
            <label key={f.key} className="block">
              <span className="flex items-baseline justify-between gap-2 text-[12.5px]">
                <span className="text-tx-2">{f.label}</span>
                {!new Big(cur).eq(def) && <span className="text-[11px] text-ref">mặc định {toText(def, f)}</span>}
              </span>
              <span className="mt-1 flex items-center gap-2">
                <input
                  className={cn('input num h-8 text-right', changed && 'border-brand')}
                  inputMode="decimal"
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                />
                <span className="w-12 shrink-0 text-[12px] text-tx-3">{f.unit}</span>
              </span>
              {f.hint && <span className="mt-0.5 block text-[11px] text-tx-3">{f.hint}</span>}
            </label>
          );
        })}
      </div>
      <p className="mt-4 text-[12px] text-tx-3">
        Mặc định theo biểu phí Spot của Binance cho người dùng thường (maker 0,1%, taker 0,1%, giảm 25% khi trả bằng BNB). Phí được chốt theo từng lệnh lúc đặt, đổi biểu phí
        không ảnh hưởng lệnh đang chờ. Bộ lọc giá / khối lượng của từng cặp lấy từ Binance, xem ở mục Cặp giao dịch.
      </p>
      <ReasonModal
        open={resetOpen}
        title="Khôi phục biểu phí mặc định"
        description="Phí maker / taker, mức giảm BNB và vốn ảo quay về giá trị mặc định."
        confirmLabel="Khôi phục"
        requireReason={false}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          if (await act('/admin/rules', 'DELETE', undefined, 'Đã khôi phục biểu phí mặc định')) setResetOpen(false);
        }}
      />
    </Section>
  );
}
