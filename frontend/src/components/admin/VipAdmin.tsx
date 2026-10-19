import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { VipRules, VipRulesPatch, VipStatusDTO } from '@vss/shared';
import { useAdminAction, useAdminMe } from '../../lib/admin';
import { api } from '../../lib/api';
import { fmtFeePct } from '../../lib/fees';
import { Spinner } from '../common/ui';
import { Section } from './adminUi';

/** Cấp VIP phí Spot: bảng theo Binance, ngưỡng thật × hệ số; Vận hành thị trường chỉnh hệ số và tính lại ngay */
export function VipAdmin() {
  const { can } = useAdminMe();
  const editable = can('market.manage');
  const act = useAdminAction();
  const { data } = useQuery({
    queryKey: ['admin', 'vip'],
    queryFn: () => api<{ rules: VipRules; defaults: VipRules; overrides: VipRulesPatch; tiers: VipStatusDTO['tiers'] }>('/admin/vip/rules'),
  });
  const [scale, setScale] = useState('');
  useEffect(() => {
    if (data) setScale(String(data.rules.scale));
  }, [data]);
  if (!data) return <Spinner className="m-4" />;

  return (
    <Section
      title="Cấp VIP phí (Spot)"
      actions={
        editable && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[12px] text-tx-3">
              Hệ số ngưỡng
              <input className="input num h-8 w-24 text-[12px]" value={scale} onChange={(e) => setScale(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
            <button className="btn btn-brand h-8 text-[12px]" disabled={Number(scale) === data.rules.scale} onClick={() => void act('/admin/vip/rules', 'PUT', { scale: Number(scale) }, 'Đã lưu hệ số')}>
              Lưu
            </button>
            <button className="btn btn-ghost h-8 text-[12px]" onClick={() => void act('/admin/vip/rules', 'DELETE', undefined, 'Đã khôi phục mặc định')}>
              Mặc định
            </button>
            <button className="btn btn-ghost h-8 text-[12px]" onClick={() => void act<{ changed: number }>('/admin/vip/recompute', 'POST', {}, 'Đã tính lại cấp VIP')}>
              Tính lại ngay
            </button>
          </div>
        )
      }
    >
      <p className="text-[12px] text-tx-3">
        Như Binance: đạt cấp khi CẢ khối lượng Spot 30 ngày VÀ số BNB nắm giữ đủ ngưỡng; hệ thống tự tính lại lúc 00:00 UTC, phí chốt vào lệnh lúc đặt. Ngưỡng hiển thị đã nhân hệ
        số {data.rules.scale} (ngưỡng thật của Binance × hệ số, vì vốn ảo chỉ 10.000 USDT). VIP 0 dùng phí cơ bản ở mục Tham số giao dịch.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="tbl w-full min-w-[560px] text-[12.5px]">
          <thead>
            <tr className="h-8 text-left">
              <th className="px-2">Cấp</th>
              <th className="px-2 text-right">KL Spot 30 ngày (USDT)</th>
              <th className="px-2 text-right">BNB nắm giữ</th>
              <th className="px-2 text-right">Maker</th>
              <th className="px-2 text-right">Taker</th>
            </tr>
          </thead>
          <tbody>
            {data.tiers.map((t) => (
              <tr key={t.level} className="border-t border-line">
                <td className="px-2 py-1.5 font-medium">VIP {t.level}</td>
                <td className="num px-2 text-right">{t.level ? `≥ ${t.volumeUsdt.toLocaleString('en-US')}` : '—'}</td>
                <td className="num px-2 text-right">{t.level ? `≥ ${t.bnb.toLocaleString('en-US', { maximumFractionDigits: 4 })}` : '—'}</td>
                <td className="num px-2 text-right">{fmtFeePct(t.maker)}</td>
                <td className="num px-2 text-right">{fmtFeePct(t.taker)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
