@echo off
REM ==========================================================
REM  CHAY DEMO GIAO THONG DA NANG tren LAPTOP
REM  - Web dashboard + nhan dien camera + bat tay Mega
REM  Double-click file nay la chay. Dong cua so de dung.
REM ==========================================================
cd /d "%~dp0"

echo ==========================================================
echo   DEMO GIAO THONG DA NANG - dang khoi dong...
echo   Dashboard se mo tai: http://localhost:8090
echo   Nhan Ctrl+C 2 lan de dung.
echo ==========================================================

REM 1) Web dashboard chay nen
start "Traffic Web" /min python web/server.py --port 8090

REM 2) Cho web san sang roi mo trinh duyet
timeout /t 3 /nobreak >nul
start "" http://localhost:8090

REM 3) Nhan dien 2 camera: doc = index 1 (Logitech), ngang = index 2 (USB2.0 PC CAMERA)
REM    (cam laptop la index 0, KHONG dung)
python main.py --camera-v 1 --camera-h 2 --no-display --arduino 192.168.16.201 --width 640 --height 480 --imgsz 480

pause
