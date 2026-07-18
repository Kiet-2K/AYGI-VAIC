@echo off
cd /d "C:\Smart-Traffic-Monitoring-System\backend\app"
uvicorn main:app --reload --host 0.0.0.0 --port 8000
