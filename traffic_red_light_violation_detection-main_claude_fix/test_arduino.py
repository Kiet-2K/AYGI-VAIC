"""
test_arduino.py – Kiểm tra kết nối TCP với Arduino Mega (bộ điều khiển đèn)

Gửi thử PING / COUNT / VIOLATION / STATS, rồi lắng nghe trạng thái đèn (LIGHT)
mà Mega chủ động đẩy về khi đổi pha.

Cách dùng:
  python test_arduino.py --host 192.168.1.200
  python test_arduino.py --host 192.168.1.200 --violation 51A12345
"""

import socket
import json
import time
import argparse


def send_cmd(sock, cmd_dict):
    msg = json.dumps(cmd_dict) + "\n"
    sock.sendall(msg.encode("utf-8"))
    print(f"  → Gửi: {msg.strip()}")

    sock.settimeout(5.0)
    try:
        resp = b""
        while b"\n" not in resp:
            chunk = sock.recv(256)
            if not chunk:
                break
            resp += chunk
        print(f"  ← Nhận: {resp.decode('utf-8', errors='replace').strip()}")
    except socket.timeout:
        print("  ← (timeout – không nhận phản hồi)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="192.168.1.200")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--violation", default=None, help="Biển số để gửi test vi phạm")
    args = ap.parse_args()

    print(f"Kết nối tới Arduino Mega: {args.host}:{args.port}")
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(10.0)
        sock.connect((args.host, args.port))
        print("✓ Kết nối thành công!\n")

        # PING (Mega trả PONG + đẩy LIGHT hiện tại)
        print("1. Gửi PING:")
        send_cmd(sock, {"cmd": "PING"})
        time.sleep(0.5)

        # COUNT – gửi số xe để Mega chỉnh thời gian đèn thích ứng
        print("\n2. Gửi COUNT (dọc nhiều xe hơn ngang):")
        send_cmd(sock, {"cmd": "COUNT", "vertical": 8, "horizontal": 2})
        time.sleep(1)

        print("\n3. Gửi COUNT (cân bằng):")
        send_cmd(sock, {"cmd": "COUNT", "vertical": 5, "horizontal": 5})
        time.sleep(1)

        # VI PHẠM (Mega kêu còi + relay)
        if args.violation:
            print(f"\n4. Gửi vi phạm: {args.violation}")
            send_cmd(sock, {
                "cmd": "VIOLATION",
                "plate": args.violation,
                "type": "car",
                "ts": time.strftime("%Y%m%d_%H%M%S")
            })
            time.sleep(1)

        # STATS
        print("\n5. Yêu cầu thống kê:")
        send_cmd(sock, {"cmd": "STATS"})

        # Lắng nghe trạng thái đèn Mega đẩy về trong 12s (thấy đèn đổi pha)
        print("\n6. Lắng nghe LIGHT từ Mega (12s)...")
        sock.settimeout(12.0)
        try:
            buf = b""
            t_end = time.time() + 12
            while time.time() < t_end:
                chunk = sock.recv(256)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    s = line.decode("utf-8", errors="replace").strip()
                    if '"LIGHT"' in s:
                        print(f"  ← ĐÈN: {s}")
        except socket.timeout:
            pass

        sock.close()
        print("\n✓ Test hoàn tất!")

    except (socket.error, ConnectionRefusedError) as e:
        print(f"\n❌ Kết nối thất bại: {e}")
        print("   Kiểm tra:")
        print(f"   1. Arduino Mega đã cấp nguồn và upload code chưa?")
        print(f"   2. Cáp Ethernet đã cắm chưa?")
        print(f"   3. IP Arduino trong sketch có phải {args.host} không?")
        print(f"   4. PC và Arduino cùng mạng LAN không?")
        print(f"      PC IP: chạy 'ipconfig' để xem")


if __name__ == "__main__":
    main()
