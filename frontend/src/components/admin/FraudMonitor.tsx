import { useState } from 'react';
import { FRAUD_RULES, ROLE_LABEL, isStaff, type FraudAccount } from '@vss/shared';
import { useAdminAction, useAdminMe, useFraudReport } from '../../lib/admin';
import { fmtDateTime } from '../../lib/format';
import { Empty, Spinner } from '../common/ui';
import { Pill, ReasonModal, Section } from './adminUi';

/** Email + vai trò + trạng thái bảng xếp hạng + nút loại / đưa lại */
function AccountCell({ a, onToggle }: { a: FraudAccount; onToggle?: (a: FraudAccount) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span>{a.email}</span>
      {isStaff(a.role) && <Pill tone="info">{ROLE_LABEL[a.role]}</Pill>}
      {a.status !== 'ACTIVE' && <Pill tone="bad">{a.status === 'LOCKED' ? 'Đang khoá' : 'Đã xoá'}</Pill>}
      {a.leaderboardBanned && <Pill tone="warn">Đã loại khỏi xếp hạng</Pill>}
      {onToggle && !isStaff(a.role) && (
        <button className="text-[12px] text-brand hover:underline" onClick={() => onToggle(a)}>
          {a.leaderboardBanned ? 'Đưa lại xếp hạng' : 'Loại khỏi xếp hạng'}
        </button>
      )}
    </div>
  );
}

/** Giám sát gian lận bảng xếp hạng: nhiều tài khoản cùng IP, tự đặt lại liên tục, spam lệnh */
export function FraudMonitor() {
  const { data, isLoading } = useFraudReport();
  const { can } = useAdminMe();
  const act = useAdminAction();
  const [target, setTarget] = useState<FraudAccount | null>(null);
  const onToggle = can('users.lock') ? setTarget : undefined;
  const R = FRAUD_RULES;

  if (isLoading || !data) return <Spinner className="m-6" />;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-tx-3">
        Bảng xếp hạng vốn đã loại mọi tài khoản nhân viên. Báo cáo dưới đây chỉ là dấu hiệu, cần xem kỹ (vd. nhiều người dùng chung mạng ở trường, công ty) trước khi loại một
        tài khoản. Loại / đưa lại bắt buộc lý do và ghi vào nhật ký quản trị. Cập nhật lúc {fmtDateTime(data.generatedAt)}.
      </p>

      <Section title={`Nhiều tài khoản đăng nhập cùng IP (${R.windowDays} ngày, từ ${R.sameIpMin} tài khoản)`} pad={false}>
        {!data.sameIp.length ? (
          <Empty title="Không có nhóm nào" />
        ) : (
          <table className="tbl w-full text-[12.5px]">
            <thead>
              <tr className="h-8 text-left">
                <th className="px-4">IP</th>
                <th className="px-2">Tài khoản</th>
                <th className="px-4 text-right">Lần cuối</th>
              </tr>
            </thead>
            <tbody>
              {data.sameIp.map((g) => (
                <tr key={g.ip} className="border-t border-line align-top">
                  <td className="num px-4 py-2">{g.ip}</td>
                  <td className="space-y-1 whitespace-normal px-2 py-2">
                    {g.accounts.map((a) => (
                      <AccountCell key={a.id} a={a} onToggle={onToggle} />
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-tx-2">{fmtDateTime(g.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <div className="grid gap-3 xl:grid-cols-2">
        <Section title={`Tự đặt lại tài khoản liên tục (≥ ${R.resetMin} lần / ${R.windowDays} ngày)`} pad={false}>
          {!data.frequentResets.length ? (
            <Empty title="Không có tài khoản nào" />
          ) : (
            <table className="tbl w-full text-[12.5px]">
              <tbody>
                {data.frequentResets.map((x) => (
                  <tr key={x.account.id} className="border-t border-line">
                    <td className="whitespace-normal px-4 py-2">
                      <AccountCell a={x.account} onToggle={onToggle} />
                    </td>
                    <td className="px-2 text-right font-semibold">{x.resets} lần</td>
                    <td className="whitespace-nowrap px-4 text-right text-tx-2">{fmtDateTime(x.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section
          title={`Đặt / huỷ lệnh dồn dập (${R.spamWindowMin} phút: ≥ ${R.spamPlaceMin} lệnh, hoặc ≥ ${R.spamCancelMinPlaces} lệnh huỷ ≥ ${R.spamCancelRatio * 100}%)`}
          pad={false}
        >
          {!data.orderSpam.length ? (
            <Empty title="Không có tài khoản nào" />
          ) : (
            <table className="tbl w-full text-[12.5px]">
              <tbody>
                {data.orderSpam.map((x) => (
                  <tr key={x.account.id} className="border-t border-line">
                    <td className="whitespace-normal px-4 py-2">
                      <AccountCell a={x.account} onToggle={onToggle} />
                    </td>
                    <td className="num px-2 text-right">
                      đặt {x.placed} · huỷ {x.cancelled}
                    </td>
                    <td className="num px-4 text-right font-semibold">{Math.round(x.cancelRatio * 100)}% huỷ</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      </div>

      <Section title="Đang bị loại khỏi bảng xếp hạng" pad={false}>
        {!data.banned.length ? (
          <Empty title="Chưa loại tài khoản nào" />
        ) : (
          <table className="tbl w-full text-[12.5px]">
            <tbody>
              {data.banned.map((b) => (
                <tr key={b.id} className="border-t border-line align-top">
                  <td className="whitespace-normal px-4 py-2">
                    <AccountCell a={b} onToggle={onToggle} />
                  </td>
                  <td className="max-w-[360px] whitespace-normal px-2 py-2 text-tx-2">{b.reason}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right text-tx-2">{b.at ? fmtDateTime(b.at) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <ReasonModal
        open={!!target}
        danger={!target?.leaderboardBanned}
        title={target ? `${target.leaderboardBanned ? 'Đưa lại' : 'Loại'} ${target.email} ${target.leaderboardBanned ? 'vào' : 'khỏi'} bảng xếp hạng` : ''}
        description={
          target?.leaderboardBanned
            ? 'Tài khoản sẽ xuất hiện lại trên bảng xếp hạng công khai.'
            : 'Tài khoản vẫn giao dịch bình thường, chỉ không xuất hiện trên bảng xếp hạng công khai. Ghi rõ dấu hiệu gian lận đã xác minh.'
        }
        confirmLabel={target?.leaderboardBanned ? 'Đưa lại' : 'Loại khỏi xếp hạng'}
        onClose={() => setTarget(null)}
        onConfirm={async (reason) => {
          if (!target) return;
          const ok = await act(
            `/admin/users/${target.id}/leaderboard`,
            'POST',
            { banned: !target.leaderboardBanned, reason },
            target.leaderboardBanned ? `Đã đưa ${target.email} lại bảng xếp hạng` : `Đã loại ${target.email} khỏi bảng xếp hạng`,
          );
          if (ok) setTarget(null);
        }}
      />
    </div>
  );
}
