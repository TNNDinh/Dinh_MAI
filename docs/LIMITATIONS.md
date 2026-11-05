# Hạn chế đã biết

Tài liệu này gom mọi hạn chế của Multi-AI Development Studio (sau Phase 10) vào một chỗ, để biết trước app **chưa làm gì** và **cần cẩn thận gì**. Chi tiết kỹ thuật nằm trong [ARCHITECTURE.md](ARCHITECTURE.md), mục 11.

Quy ước: mọi thứ chưa làm đều được ghi rõ ở đây hoặc trong giao diện. App không giả lập phản hồi AI hay việc tạo ảnh.

## 1. Quan trọng nhất

| Hạn chế | Hệ quả |
|---|---|
| **Chưa chạy thử với API thật.** Môi trường phát triển không có key. Các adapter được kiểm tra bằng server loopback nói đúng định dạng của từng hãng (OpenAI; Anthropic và Gemini chỉ qua unit test mock). | Lần đầu dùng key thật có thể lộ ra hành vi riêng của từng provider. Lỗi được chuẩn hóa và nút Test connection để dễ thấy chuyện này. |
| **Smoke test chứng minh giao thức và cách tính tiền, không chứng minh chất lượng mô hình.** | Chất lượng kết quả của agent phụ thuộc mô hình bạn chọn. |
| **Chưa ký số (code signing).** | Windows SmartScreen sẽ cảnh báo khi chạy lần đầu. |
| **Chỉ có Windows x64. Chưa có tự cập nhật.** | Muốn lên bản mới phải cài lại. |
| **Cần cài git riêng.** | Không có git thì trang Source Control báo thiếu, các tính năng khác vẫn chạy. |
| **Giá không bao giờ được đoán.** Bạn tự nhập giá mỗi token và giá mỗi ảnh (riêng OpenRouter có giá từ API). | Gọi chưa có giá được ghi là "chưa biết", không tính vào ngân sách. Ngân sách chỉ chặn được phần đã biết giá. |

## 2. An toàn và quyền hạn

- **Chính sách lệnh là hàng rào, không phải sandbox của hệ điều hành.** Lệnh được duyệt hoặc tự cho phép chạy với quyền Windows của bạn. Việc kiểm tra đọc chữ trong lệnh, không nhìn được script bên trong làm gì.
- Danh sách tự cho phép (`npm test`, `npm run build`, `node <script>.js`, `tsc`, `vitest`…) chạy **không hỏi**, mà những lệnh đó thực thi code trong dự án, có thể do agent vừa viết. Muốn hỏi mỗi lần, đặt quyền lệnh của agent là "ask".
- Lệnh bạn tự gõ không bị hỏi, nhưng các chặn cứng (công cụ đĩa, xóa đệ quy thư mục hệ thống, `shutdown`, sửa registry…) vẫn áp dụng.
- Sandbox file dùng đường dẫn thật (symlink, junction trỏ ra ngoài bị từ chối), nhưng còn một khoảng hở rất nhỏ giữa lúc kiểm tra và lúc ghi (TOCTOU).
- Quyền mạng của agent chỉ được lưu, **chưa có công cụ mạng nào** để áp dụng.
- Agent không đọc hay ghi được file bí mật (`.env`, file key) và không động vào `.git`.
- Duyệt (approval) hết hạn sau 15 phút (lệnh) hoặc 12 giờ (bước human-approval), tính là từ chối. Đóng app thì các yêu cầu đang chờ mất, không có gì chạy khi chưa được trả lời.
- API key lưu bằng DPAPI. Nếu máy không có mã hóa thì app từ chối lưu, không bao giờ lưu dạng thường.
- Lịch sử Playground lưu trong local storage của cửa sổ, **không mã hóa**, chỉ nằm trên máy này.

## 3. Điều phối agent (Phase 5)

- Ngân sách được kiểm tra trước mỗi lần gọi mô hình và trước khi khởi chạy task, nên một lần gọi đang chạy có thể vượt ngân sách một chút.
- Không tạm dừng giữa chừng một lần gọi. Stop sẽ hủy lần gọi đó (ghi là cancelled, 0 token, không tốn tiền) và task chưa xong quay về to-do.
- Lần gọi bị hủy hoặc lỗi ghi 0 token, vì không biết đã dùng bao nhiêu trước khi hủy.
- Run chỉ nhận task có chủ (role hoặc agent). Task thủ công chưa gán vẫn nằm trên bảng.
- Không có cài đặt mặc định toàn app cho ngân sách hay số vòng review. Đặt theo từng dự án và từng run.
- **Tab Chat bên phải chỉ đọc.** Đó là dòng tin của team (phản hồi và change request của agent, cắt còn 600 ký tự), dựng từ log từng task. Không có phòng chat trực tiếp giữa agent, và bạn điều khiển agent qua task chứ không qua chat.
- Agent chưa có công cụ git (chỉ đọc/ghi trong dự án, không động vào `.git`).

## 4. Workspace, editor, terminal (Phase 6)

- **Terminal là bộ chạy lệnh, không phải shell tương tác** (không có node-pty): stdin đóng, chương trình chờ nhập hoặc vẽ toàn màn hình sẽ không chạy, đầu ra bị cắt. Giao diện có ghi rõ.
- Monaco chỉ có tô màu cú pháp cơ bản (Monarch), **không có IntelliSense hay gạch lỗi** (không có language service cho TypeScript/JSON). Trang Workspace nặng khoảng 6 MB, chỉ tải khi mở.
- Chỉ mục ngữ cảnh (`find_context`) dựng từ code (tên, export, tiêu đề, comment đầu), **không phải tìm kiếm ngữ nghĩa** và không do LLM viết. Cập nhật bằng nút Index.
- Tìm kiếm nhận regex do bạn nhập mà không chống ReDoS (chỉ ảnh hưởng phiên của bạn). Bỏ qua `node_modules`, `dist` và file nhị phân.
- Khóa file theo agent + task, hạn 10 phút. Lần lưu của bạn bị từ chối (báo xung đột) nếu agent đã đổi file trong lúc đó.
- Theo dõi thay đổi bên ngoài: chỉ theo dõi **một dự án** đang hiển thị, bỏ qua `.git`, `node_modules` và các thư mục ẩn, giới hạn 200 đường dẫn mỗi đợt. Nếu nền tảng không theo dõi được thì nút Refresh vẫn dùng được. Đổi tên file bởi chương trình khác được thấy là "xóa + tạo mới".

## 5. Ảnh và Asset Library (Phase 7)

- Tạo ảnh chỉ có với **OpenAI, Google Gemini và server tương thích OpenAI**. Anthropic, OpenRouter, DeepSeek, Groq, Ollama không có API ảnh trong app. Đã kiểm tra với server loopback, **chưa với API thật**.
- Kích thước yêu cầu chỉ là gợi ý, mỗi mô hình chọn cỡ gần nhất nó hỗ trợ. Muốn đúng cỡ dùng công cụ Resize.
- Nền trong suốt: gpt-image làm được tự nhiên. Mô hình khác thì app xin nền đơn sắc rồi tách nền, chỉ ổn với nền phẳng đồng nhất (nền chuyển màu, bóng đổ, nền trùng màu chủ thể sẽ không sạch).
- Công cụ sửa ảnh (resize, trim, bỏ nền) là code của app, kết quả luôn là **PNG**. Xử lý ảnh chạy đồng bộ trên main process, ảnh rất lớn (đến giới hạn 50 megapixel) có thể làm đơ cửa sổ một lúc.
- Biến thể và chỉnh sửa cần provider có API edit (gpt-image, dall-e-2, server tương thích OpenAI), mô hình khác từ chối kèm thông báo.
- Không có kiểm tra phong cách hay nội dung ảnh, app không quét hay kiểm duyệt ảnh. Bộ lọc của provider áp dụng và lời từ chối được hiển thị là lỗi.
- Import ảnh có sẵn: một lần quét liệt kê tối đa 500 ảnh, bỏ file trên 25 MB, không bao giờ nhập file bí mật. Loại ảnh được đoán từ đường dẫn nếu bạn không chọn.
- Image Generator agent biến một task thành một ảnh và dùng nguyên văn task làm prompt. Agent khác muốn có ảnh phải gọi công cụ `generate_image`, công cụ này cần một Image Generator agent sẵn sàng trong team (dùng connection và mô hình của nó).

## 6. Workflow editor (Phase 8)

- 8 loại bước: agent, image, review, test, condition, loop, human approval, debate.
- Review, condition, test lấy kết quả từ lời gọi công cụ `submit_verdict` / `submit_decision` hoặc mã thoát của lệnh. Mô hình không gọi công cụ thì bước **thất bại**, không đoán từ văn bản.
- Vòng lặp chỉ cho phép nối ngược vào cổng "again". Chu trình khác bị coi là lỗi và workflow không chạy.
- Debate tốn `người tham gia × (1 + số vòng) + 1` lần gọi mô hình (editor hiển thị ước lượng).
- Role được xác định theo team của dự án **tại lúc bắt đầu run**, workflow dùng chung chạy với team của dự án được chọn.
- Sửa workflow trong lúc đang chạy không đổi run đó (đồ thị đã được sao chép). Resume tiếp tục bản đã lưu.
- Công cụ chỉnh sửa: lịch sử undo 100 bước, clipboard copy/paste chỉ sống trong phiên, Tidy bỏ qua các nối "again" và cạnh tạo chu trình.
- Chưa có lần chạy workflow nào với API thật.

## 7. Git, checkpoint, tự động hóa, preview, recovery (Phase 9)

- **Git chỉ local.** Không push, pull, fetch, clone, không có credential. Git chạy với hook tắt, môi trường sạch, không pager. Thư mục nằm trong một repo khác không được coi là repo riêng.
- Stage theo file (không stage từng hunk), không có giao diện merge, rebase hay xử lý xung đột. Đổi nhánh bị từ chối nếu sẽ ghi đè thay đổi cục bộ. File bí mật không bao giờ được commit hay đưa vào checkpoint.
- **Checkpoint không phải bản sao lưu**: nằm trong `.git` của chính dự án. Không chứa file bị git bỏ qua (ví dụ `node_modules`). Giữ 25 checkpoint tự động mới nhất và 10 checkpoint an toàn mỗi dự án. Khôi phục bị từ chối khi đang có run.
- **Tự động build/test** chỉ chạy lệnh tìm được trong file của dự án (scripts trong package.json, Cargo.toml, go.mod, dự án .NET, test Python). Không có thì không có nút. Chỉ nhận ra đầu ra của tsc, MSBuild/dotnet, rustc, gcc/clang/javac/mypy/eslint (dạng unix), Go, node:test, vitest/jest, pytest, cargo test, go test. Định dạng khác chỉ hiện đầu ra thô. Số liệu test lấy từ việc đọc văn bản, không phải API của bộ chạy test.
- **Live Preview chỉ cho dự án web.** Unity, Godot và engine khác không được khởi chạy. URL của dev server lấy từ những gì server in ra, server không in gì thì không hiển thị được. Chỉ phục vụ trên 127.0.0.1.
- **Auto Recovery**: mặc định tắt, bật theo từng dự án.
  - Chỉ xử lý task **thất bại**. Task "thành công" nhưng làm hỏng build thì chưa phát hiện. Stop hoặc dừng do ngân sách không rollback.
  - Journal nằm trong bộ nhớ, tối đa 2 MB mỗi file và 20 MB mỗi task, file lớn hơn được liệt kê là "không rollback".
  - **File bị lệnh `run_command` đổi (npm install, build, sinh code) không được hoàn tác.**
  - File bị người khác đổi sau lần ghi cuối của task thì được để nguyên.

## 8. Đóng gói (Phase 10)

- Không ký số, không tự cập nhật, chỉ Windows x64 (xem mục 1).
- Bản portable giải nén ra thư mục tạm mỗi lần khởi động. Dữ liệu vẫn nằm trong `%APPDATA%`. Gỡ cài đặt giữ lại dữ liệu người dùng.
- Cửa sổ min/max/close gốc của Windows không nằm trong ảnh chụp tự động (`capturePage` không chụp được), cần xem bằng mắt qua `npm run dev`.
- Việc chia panel và nhớ bố cục có cài đặt nhưng smoke test không kiểm tra.

## 9. Dữ liệu

- Xóa một dự án sẽ xóa luôn task, run, `llm_calls` của nó nên số tiền tích lũy giảm. Nên **archive** thay vì xóa.
- Xóa connection xóa key nhưng giữ lịch sử dùng ("(deleted connection)"). Xóa agent giữ dòng usage với liên kết agent bị xóa, hiển thị dưới "no agent".
- Lịch sử Playground của connection hoặc agent đã xóa vẫn còn trong local storage đến khi xóa dữ liệu trình duyệt.
- Đổi role của agent không đổi prompt và quyền của nó.

## 10. Chưa làm

| Hạng mục | Ghi chú |
|---|---|
| Phòng chat trực tiếp giữa các agent | Hiện chỉ có dòng tin chỉ đọc |
| Công cụ git cho agent | Agent chưa đọc/ghi được trong `.git` |
| Công cụ mạng cho agent | Quyền có nhưng chưa có công cụ |
| Push, pull, clone, merge, rebase | Git chỉ local |
| Ký số, tự cập nhật, macOS/Linux | Chỉ Windows x64 |
| Auto Recovery cho task "thành công nhưng làm hỏng" và hoàn tác lệnh shell | |
| Terminal tương tác (pty) | |
| IntelliSense trong editor | |
| Kiểm chứng với API thật của tất cả provider | Cần key thật |
