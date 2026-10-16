import { useState } from 'react';
import { Link } from 'react-router-dom';
import { EyeOff, Medal, Trophy } from 'lucide-react';
import { Empty, Spinner, Tabs } from '../components/common/ui';
import { cn, fmtPct, fmtTime, fmtUsd, signTone, toneText } from '../lib/format';
import { useLeaderboard, type LeaderboardPeriod } from '../lib/queries';
import { useAuth } from '../store/auth';

const MEDAL = ['text-[#f5c542]', 'text-[#c0c7d2]', 'text-[#d38b4c]'];

export default function LeaderboardPage() {
  const [period, setPeriod] = useState<LeaderboardPeriod>('1M');
  const { data, isLoading } = useLeaderboard(period);
  const loggedIn = useAuth((s) => !!s.token);

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-3 p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-[20px] font-bold">
            <Trophy size={20} className="text-brand" /> Bảng xếp hạng nhà đầu tư
          </h1>
          <p className="text-[12px] text-tx-3">Xếp theo tỷ suất lợi nhuận trên vốn ảo, cập nhật mỗi phút. Chỉ hiện tên hiển thị — không bao giờ hiện email.</p>
        </div>
        <Tabs
          value={period}
          onChange={setPeriod}
          items={[
            { value: '1W', label: '7 ngày' },
            { value: '1M', label: '30 ngày' },
            { value: '3M', label: '3 tháng' },
            { value: 'ALL', label: 'Từ đầu' },
          ]}
        />
      </div>

      {data?.me && (
        <div className="panel flex flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-[13px]">
          <span className="text-tx-3">Bạn ({data.me.name})</span>
          {data.me.hidden ? (
            <span className="flex items-center gap-1.5 text-tx-2">
              <EyeOff size={14} /> Đang ẩn khỏi bảng xếp hạng — bật lại trong Cài đặt tài khoản → Thông báo &amp; riêng tư
            </span>
          ) : (
            <span>
              Hạng <b className="num text-[16px]">{data.me.rank}</b> / {data.total.toLocaleString('en-US')}
            </span>
          )}
          <span className={cn('num font-semibold', toneText[signTone(data.me.returnPct)])}>{fmtPct(data.me.returnPct)}</span>
          <span className="num text-tx-2">Tổng tài sản {fmtUsd(data.me.nav)} USDT</span>
        </div>
      )}
      {!loggedIn && (
        <div className="panel px-4 py-3 text-[13px] text-tx-2">
          <Link to="/register" className="font-semibold text-brand hover:underline">
            Mở tài khoản
          </Link>{' '}
          để nhận 10.000 USDT vốn ảo và tham gia bảng xếp hạng.
        </div>
      )}

      <section className="panel overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : !data?.rows.length ? (
          <Empty title="Chưa có nhà đầu tư nào đủ điều kiện" hint="Cần có ít nhất 1 lệnh khớp để vào bảng xếp hạng." />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl num w-full min-w-[640px] text-[13px]">
              <thead>
                <tr className="h-9 text-left">
                  <th className="w-16 px-4">Hạng</th>
                  <th className="px-2">Nhà đầu tư</th>
                  <th className="px-2 text-right">Lợi nhuận</th>
                  <th className="px-2 text-right">Tổng tài sản (USDT)</th>
                  <th className="px-2 text-right">Lệnh khớp</th>
                  <th className="px-4 text-right">Coin nắm nhiều nhất</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.rank} className={cn('h-11 border-t border-line', r.isMe && 'bg-brand/8')}>
                    <td className="px-4 font-bold">
                      {r.rank <= 3 ? (
                        <span className="flex items-center gap-1">
                          <Medal size={16} className={MEDAL[r.rank - 1]} /> {r.rank}
                        </span>
                      ) : (
                        r.rank
                      )}
                    </td>
                    <td className="px-2 font-medium">
                      {r.name} {r.isMe && <span className="chip ml-1 h-5 bg-brand/15 px-1.5 text-[10px] text-brand">Bạn</span>}
                    </td>
                    <td className={cn('px-2 text-right font-semibold', toneText[signTone(r.returnPct)])}>{fmtPct(r.returnPct)}</td>
                    <td className="px-2 text-right">{fmtUsd(r.nav)}</td>
                    <td className="px-2 text-right">{r.trades.toLocaleString('en-US')}</td>
                    <td className="px-4 text-right">
                      {r.topSymbol ? (
                        <Link to={`/trade/${r.topSymbol}USDT`} className="font-semibold hover:text-brand">
                          {r.topSymbol}
                        </Link>
                      ) : (
                        <span className="text-tx-3">Tiền mặt</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <p className="border-t border-line px-4 py-2 text-[11px] text-tx-3">Cập nhật lúc {fmtTime(data.updatedAt)} · {data.total.toLocaleString('en-US')} nhà đầu tư · Vốn ảo, không phải khuyến nghị đầu tư.</p>}
      </section>
    </div>
  );
}
