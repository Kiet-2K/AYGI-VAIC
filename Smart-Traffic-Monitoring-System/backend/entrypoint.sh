#!/bin/sh
set -e

# main.py uses absolute imports such as `from api import v1`, so the runtime
# working directory must be backend/app (the same convention as local Uvicorn).
cd /backend/app

# Start Telegram bot in the background when configured.
if [ -f "bot_tele.py" ]; then
  echo "Starting Telegram bot..."
  python -u bot_tele.py &
fi

# Start FastAPI.
echo "Starting FastAPI server..."
exec uvicorn main:app --host 0.0.0.0 --port 8000
