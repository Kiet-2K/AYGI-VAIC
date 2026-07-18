# Nhật ký phát triển AI

> Tệp nội bộ của workspace chính. Không đồng bộ sang thư mục khác và không đưa lên GitHub nếu chưa có sự cho phép rõ ràng.

## Nguyên tắc ghi log

- Ghi trung thực các yêu cầu, quyết định kỹ thuật, thay đổi mã nguồn, lỗi và kết quả kiểm chứng.
- Không tuyên bố một thay đổi đã hoàn thành nếu chưa thực hiện hoặc chưa kiểm chứng.
- Không ghi secret, token, mật khẩu, thông tin xác thực hoặc dữ liệu cá nhân không cần thiết.
- Đường dẫn máy, nội dung trao đổi và thông tin nhận dạng có thể được rút gọn hoặc che khi không ảnh hưởng đến ý nghĩa kỹ thuật.
- Có thể chỉnh sửa hoặc che thêm nội dung theo yêu cầu của chủ dự án; việc chỉnh sửa không được làm sai lệch sự kiện kỹ thuật.
- Nội dung trao đổi chỉ được tóm tắt ở mức cần thiết, không mặc định sao chép nguyên văn toàn bộ cuộc trò chuyện.

## 2026-07-18 — Thiết lập quy tắc workspace và nhật ký

### Yêu cầu và quyết định

- Xác định workspace phát triển chính là `D:\SMTF\smart-traffic-light-digital-twin`.
- Mọi hoạt động viết code, thử nghiệm, xử lý lỗi và kiểm chứng mặc định phải diễn ra tại workspace này.
- Các bản sao, workspace khác và repository từ xa không được đồng bộ hoặc cập nhật nếu chưa có chỉ thị rõ ràng cho từng lần thực hiện.
- Nhật ký phát triển được lưu nội bộ bằng Markdown và tập trung vào hoạt động phát triển.
- Chủ dự án chủ động đặt ranh giới rõ ràng giữa môi trường thử nghiệm và bản công bố, giúp hạn chế việc vô tình phát tán mã chưa sẵn sàng.

### Thay đổi đã thực hiện

- Tạo tệp `AI_DEVELOPMENT_LOG.md` làm nhật ký nội bộ.
- Thêm `AI_DEVELOPMENT_LOG.md` vào `.gitignore` để giảm nguy cơ bị commit hoặc push ngoài ý muốn.
- Lưu quy tắc workspace và quyền đồng bộ vào bộ nhớ cộng tác để áp dụng cho các phiên sau.

### Kiểm chứng

- Đã đọc cấu hình `.gitignore` hiện tại trước khi chỉnh sửa.
- Đã thêm đúng một quy tắc ignore dành cho tệp nhật ký.
## 2026-07-18 — Đồng bộ repository và thay đổi nhật ký vi phạm

### Yêu cầu và quyết định

- Chủ dự án cho phép đồng bộ workspace chính sang repository lồng `D:\SMTF\SmartTrafficSimulator` và push lên GitHub.
- Dashboard được giữ ở dạng tóm tắt số lượng; danh sách chi tiết nằm ở trang nhật ký mở trong tab mới.
- Nhật ký vi phạm chỉ hiển thị minh họa model xe có sẵn; không tạo ảnh crop camera mới.
- Giữ `ALL_RED` cơ bản một giây theo yêu cầu mới nhất; không áp dụng bộ đệm đỏ cố định ba giây trước khi sang xanh.

### Thay đổi và kiểm chứng

- Đồng bộ backend/frontend và các tệp cấu hình công khai sang repository lồng, loại trừ dependency, build output, database/evidence runtime và cache.
- Backend tests: 13/13 passed.
- Frontend typecheck và production build: passed.
- Focused signal/adaptive tests: 21/21 passed.
- Full frontend soak suite vẫn còn các bài timeout/giới hạn fairness trên môi trường kiểm thử; không ghi nhận là đã hoàn tất toàn bộ.

### Quyền công bố

- Theo chỉ thị rõ ràng ngày 2026-07-18, bản đồng bộ này được phép commit và push lên remote GitHub của repository lồng.
