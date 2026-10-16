import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
      <div className="text-6xl font-extrabold text-brand">404</div>
      <div className="text-lg font-semibold">Không tìm thấy trang</div>
      <p className="text-tx-3">Đường dẫn không tồn tại hoặc đã bị thay đổi.</p>
      <Link to="/thi-truong" className="btn btn-brand mt-2">
        Về thị trường
      </Link>
    </div>
  );
}
