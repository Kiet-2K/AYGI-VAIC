import { Navigate, Outlet } from "react-router-dom";

export default function ProtectedRoute() {
  // Đọc token lúc render (không phải lúc load module) để guard cập nhật
  // ngay sau khi đăng nhập, tránh bị redirect ngược về /login.
  const authed = Boolean(localStorage.getItem("access_token"));
  return authed ? <Outlet /> : <Navigate to="/login" replace />;
}
