import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BadgeCheck, Clock, IdCard, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  KYC_FUND_SOURCES,
  KYC_LEVEL_LABEL,
  KYC_OCCUPATIONS,
  KYC_PURPOSES,
  P2P_RULES,
  type P2PRules,
  kycLevel1Schema,
  kycLevel2Schema,
  type KycLevel,
  type MyKycDTO,
} from '@vss/shared';
import { Empty, Spinner } from '../components/common/ui';
import { api, errMsg } from '../lib/api';
import { cn, fmtDateTime } from '../lib/format';
import { useMyKyc } from '../lib/kyc';
import { fmtVndNum, useP2PConfig } from '../lib/p2p';
import { useAuth } from '../store/auth';
import { useQueryClient } from '@tanstack/react-query';

/** Quyền lợi từng cấp theo tham số P2P đang áp dụng (Quản trị chỉnh được) */
const levelsOf = (R: Pick<P2PRules, 'kycLevel1DailyVnd' | 'kycLevel2DailyVnd'>): { level: KycLevel; title: string; needs: string; gets: string[] }[] => [
  { level: 0, title: 'Chưa xác minh', needs: 'Email', gets: ['Giao dịch Spot bằng vốn ảo', 'Xem chợ P2P'] },
  {
    level: 1,
    title: 'Xác minh danh tính',
    needs: 'Họ tên, ngày sinh, quốc tịch, giấy tờ tuỳ thân',
    gets: ['Giao dịch P2P', `Hạn mức P2P ${fmtVndNum(R.kycLevel1DailyVnd)} ₫ / ngày`, 'Tài khoản nhận tiền đứng tên chính chủ'],
  },
  {
    level: 2,
    title: 'Xác minh nâng cao',
    needs: 'Địa chỉ cư trú, nghề nghiệp, nguồn tiền, mục đích',
    gets: [`Hạn mức P2P ${fmtVndNum(R.kycLevel2DailyVnd)} ₫ / ngày`, 'Được đăng ký làm thương nhân P2P'],
  },
];

/** Xác minh danh tính (KYC) theo cấp — sàn mô phỏng: thông tin khai báo giả lập, không tải ảnh giấy tờ */
export default function KycPage() {
  const user = useAuth((s) => s.user);
  const { data, isLoading } = useMyKyc();
  const { data: cfg } = useP2PConfig();
  const LEVELS = levelsOf(cfg?.rules ?? P2P_RULES);

  useEffect(() => {
    document.title = 'Xác minh danh tính · VNCoin';
    return () => void (document.title = 'VNCoin · Sàn giao dịch coin mô phỏng');
  }, []);

  if (user?.role && user.role !== 'USER') return <Empty title="Tài khoản nhân viên không cần xác minh KYC khách hàng" />;
  if (isLoading || !data) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const app1 = data.applications.find((a) => a.level === 1);
  const app2 = data.applications.find((a) => a.level === 2);
  const used = Number(data.p2pUsedToday);
  const limit = Number(data.p2pDailyLimit);

  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-5 sm:px-6">
      <h1 className="text-[26px] font-bold tracking-tight">Xác minh danh tính</h1>
      <p className="mt-1 max-w-[75ch] text-[13px] text-tx-2">
        Như các sàn thật, VNCoin xác minh danh tính (KYC) theo cấp: cấp càng cao hạn mức P2P càng lớn. Hồ sơ do bộ phận Tuân thủ duyệt.
      </p>
      <div role="note" className="mt-3 flex items-start gap-2 rounded-md border border-ref/30 bg-ref/10 px-3 py-2 text-[12px] text-ref">
        <AlertTriangle size={15} className="mt-0.5 shrink-0" />
        Đây là sàn mô phỏng: hãy dùng thông tin giả lập. Không nhập số căn cước / hộ chiếu thật.
      </div>

      <section className="mt-4 grid gap-3 md:grid-cols-[1.2fr_1fr]">
        <div className="rounded-xl border border-line bg-bg-1 p-5">
          <div className="flex items-center gap-2 text-[13px] text-tx-3">
            <ShieldCheck size={16} className="text-brand" /> Cấp hiện tại
          </div>
          <div className="mt-2 flex items-center gap-2 text-[22px] font-bold">
            {data.level > 0 && <BadgeCheck size={22} className="text-brand" />}
            Cấp {data.level} · {KYC_LEVEL_LABEL[data.level]}
          </div>
          {data.name && <div className="mt-1 text-[13px] text-tx-2">Họ tên đã xác minh: {data.name}</div>}
          {data.restricted && <div className="mt-2 text-[13px] text-down">Tài khoản đang bị hạn chế giao dịch. Vui lòng liên hệ CSKH.</div>}
        </div>
        <div className="rounded-xl border border-line p-5">
          <div className="text-[13px] text-tx-3">Hạn mức P2P hôm nay (00:00 UTC đặt lại)</div>
          {limit > 0 ? (
            <>
              <div className="num mt-2 text-[18px] font-semibold">
                {fmtVndNum(used)} / {fmtVndNum(limit)} ₫
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-3">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} />
              </div>
            </>
          ) : (
            <div className="mt-2 text-[13px] text-tx-2">Chưa dùng được P2P. Xác minh danh tính cấp 1 để mở.</div>
          )}
        </div>
      </section>

      <section className="mt-4 grid gap-3 md:grid-cols-3" aria-label="Các cấp xác minh">
        {LEVELS.map((l) => (
          <div key={l.level} className={cn('rounded-xl border p-4', data.level === l.level ? 'border-brand bg-brand/5' : 'border-line')}>
            <div className="flex items-center justify-between">
              <span className="font-semibold">
                Cấp {l.level} · {l.title}
              </span>
              {data.level >= l.level && <BadgeCheck size={16} className="text-brand" />}
            </div>
            <div className="mt-1 text-[12px] text-tx-3">Cần: {l.needs}</div>
            <ul className="mt-2 space-y-1 text-[13px] text-tx-2">
              {l.gets.map((g) => (
                <li key={g}>• {g}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {data.level === 0 && <LevelSection level={1} app={app1} />}
      {data.level === 1 && <LevelSection level={2} app={app2} />}
      {data.level === 2 && (
        <section className="mt-4 panel p-5 text-[13px]">
          <div className="flex items-center gap-2 font-semibold">
            <BadgeCheck size={18} className="text-brand" /> Bạn đã hoàn tất xác minh nâng cao
          </div>
          <p className="mt-1 text-tx-2">
            Bạn có thể giao dịch P2P với hạn mức cao và <Link to="/p2p/thuong-nhan" className="text-brand hover:underline">đăng ký làm thương nhân</Link>.
          </p>
        </section>
      )}
    </div>
  );
}

function LevelSection({ level, app }: { level: 1 | 2; app: MyKycDTO['applications'][number] | undefined }) {
  if (app?.status === 'PENDING') {
    return (
      <section className="mt-4 panel flex items-start gap-3 p-5 text-[13px]">
        <Clock size={18} className="mt-0.5 shrink-0 text-ref" />
        <div>
          <div className="font-semibold">Hồ sơ cấp {level} đang chờ duyệt</div>
          <p className="mt-1 text-tx-2">Nộp lúc {fmtDateTime(app.createdAt)}. Bộ phận Tuân thủ sẽ duyệt và báo kết quả qua email.</p>
        </div>
      </section>
    );
  }
  return (
    <section className="mt-4 panel p-5">
      <h2 className="flex items-center gap-2 text-[15px] font-semibold">
        <IdCard size={18} className="text-brand" /> {level === 1 ? 'Xác minh danh tính (cấp 1)' : 'Xác minh nâng cao (cấp 2)'}
      </h2>
      {app?.status === 'REJECTED' && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-down/10 px-3 py-2 text-[13px] text-down">
          <XCircle size={15} className="mt-0.5 shrink-0" />
          <span>
            Hồ sơ trước bị từ chối: {app.rejectReason}. Sửa thông tin và nộp lại.
          </span>
        </div>
      )}
      {level === 1 ? <Level1Form /> : <Level2Form />}
    </section>
  );
}

function useSubmit(path: string) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const submit = async (body: unknown) => {
    setBusy(true);
    try {
      await api(path, { method: 'POST', body });
      toast.success('Đã nộp hồ sơ, chờ bộ phận Tuân thủ duyệt');
      void qc.invalidateQueries({ queryKey: ['kyc'] });
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, submit };
}

function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <label className="block text-[13px]">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {error && <span className="mt-1 block text-[12px] text-down">{error}</span>}
    </label>
  );
}

function Level1Form() {
  const user = useAuth((s) => s.user);
  const { busy, submit } = useSubmit('/kyc/level1');
  const [f, setF] = useState({ fullName: user?.fullName ?? '', dateOfBirth: '', nationality: 'Việt Nam', idType: 'CCCD' as 'CCCD' | 'PASSPORT', idNumber: '', idIssuedDate: '', isPep: false });
  const [tried, setTried] = useState(false);
  const parsed = kycLevel1Schema.safeParse(f);
  const errs: Record<string, string> = {};
  if (!parsed.success) for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const show = (k: string) => (tried ? errs[k] : undefined);

  return (
    <form
      className="mt-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (parsed.success) void submit(parsed.data);
      }}
    >
      <Field label="Họ và tên theo giấy tờ" error={show('fullName')}>
        <input className="input" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} autoComplete="off" />
      </Field>
      <Field label="Ngày sinh" error={show('dateOfBirth')}>
        <input type="date" className="input" value={f.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
      </Field>
      <Field label="Quốc tịch" error={show('nationality')}>
        <input className="input" value={f.nationality} onChange={(e) => set('nationality', e.target.value)} />
      </Field>
      <Field label="Loại giấy tờ">
        <select className="input" value={f.idType} onChange={(e) => set('idType', e.target.value as 'CCCD' | 'PASSPORT')}>
          <option value="CCCD">Căn cước công dân</option>
          <option value="PASSPORT">Hộ chiếu</option>
        </select>
      </Field>
      <Field label={f.idType === 'CCCD' ? 'Số CCCD (12 chữ số, giả lập)' : 'Số hộ chiếu (giả lập)'} error={show('idNumber')}>
        <input className="input num" value={f.idNumber} autoComplete="off" onChange={(e) => set('idNumber', e.target.value.toUpperCase().replace(/\s/g, ''))} />
      </Field>
      <Field label="Ngày cấp" error={show('idIssuedDate')}>
        <input type="date" className="input" value={f.idIssuedDate} onChange={(e) => set('idIssuedDate', e.target.value)} />
      </Field>
      <label className="flex items-start gap-2 text-[13px] sm:col-span-2">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={f.isPep} onChange={(e) => set('isPep', e.target.checked)} />
        <span>
          Tôi là người có ảnh hưởng chính trị (PEP) hoặc người thân / cộng sự thân thiết của họ
          <span className="block text-[12px] text-tx-3">Ví dụ: cán bộ lãnh đạo cấp cao, đại biểu, lãnh đạo doanh nghiệp nhà nước. Hồ sơ PEP được thẩm định thêm.</span>
        </span>
      </label>
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <p className="text-[12px] text-tx-3">Số giấy tờ được mã hoá; nhân viên chỉ thấy 4 số cuối. Họ tên này sẽ là tên chủ tài khoản nhận tiền P2P.</p>
        <button className="btn btn-brand" disabled={busy}>
          Nộp hồ sơ
        </button>
      </div>
    </form>
  );
}

function Level2Form() {
  const { busy, submit } = useSubmit('/kyc/level2');
  const [f, setF] = useState({ address: '', occupation: KYC_OCCUPATIONS[0] as string, fundSource: KYC_FUND_SOURCES[0] as string, purpose: KYC_PURPOSES[0] as string });
  const [tried, setTried] = useState(false);
  const parsed = kycLevel2Schema.safeParse(f);
  const err = tried && !parsed.success ? parsed.error.issues[0]?.message : undefined;
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const select = (k: 'occupation' | 'fundSource' | 'purpose', opts: readonly string[]) => (
    <select className="input" value={f[k]} onChange={(e) => set(k, e.target.value)}>
      {opts.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
  return (
    <form
      className="mt-4 grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (parsed.success) void submit(parsed.data);
      }}
    >
      <div className="sm:col-span-2">
        <Field label="Địa chỉ cư trú (giả lập)">
          <input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
      </div>
      <Field label="Nghề nghiệp">{select('occupation', KYC_OCCUPATIONS)}</Field>
      <Field label="Nguồn tiền">{select('fundSource', KYC_FUND_SOURCES)}</Field>
      <Field label="Mục đích giao dịch">{select('purpose', KYC_PURPOSES)}</Field>
      <div className="flex items-end justify-end gap-3">
        {err && <span className="text-[12px] text-down">{err}</span>}
        <button className="btn btn-brand" disabled={busy}>
          Nộp hồ sơ
        </button>
      </div>
    </form>
  );
}
