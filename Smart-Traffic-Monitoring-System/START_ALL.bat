@echo off
cd /d "C:\Smart-Traffic-Monitoring-System\backend"
echo Starting Smart Traffic Monitoring System Backend...
echo =================================================
python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
pause
