import os
from dotenv import load_dotenv
import numpy as np

load_dotenv()
DATABASE_USERNAME = os.getenv("DATABASE_USERNAME")
DATABASE_PASSWORD = os.getenv("DATABASE_PASSWORD")
DATABASE_PORT = os.getenv("DATABASE_PORT")
DATABASE_HOST = os.getenv("DATABASE_HOST")
DATABASE_NAME = os.getenv("DATABASE_NAME")
class SettingServer:
    PROJECT_NAME = "FastAPI CRUD with JWT"
    DATABASE_URL = f"postgresql+asyncpg://{DATABASE_USERNAME}:{DATABASE_PASSWORD}@{DATABASE_HOST}:{DATABASE_PORT}/{DATABASE_NAME}"
    # DATABASE_URL = 'postgresql+psycopg_async://neondb_owner:npg_JEOMv5puo3wz@ep-mute-glade-ad2qnbo9-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
    JWT_SECRET = os.getenv("JWT_SECRET_KEY")
    JWT_ALGORITHM = os.getenv("JWT_ALGORITHM")
    ACCESS_TOKEN_EXPIRE_DAYS = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS"))

class SettingMetricTransport:
    REGIONS = [
        np.array([[230, 400], [90, 260], [350, 200], [600, 320], [600, 400]]),
    ]

    PATH_VIDEOS = [
        "./video_test/Văn Phú.mp4",
    ]

    METER_PER_PIXELS = [0.15]
    MODELS_PATH = r'./ai_models/test_onnx/best_fp32_static_640.onnx'

    DEVICE = 'cpu'

class SettingChatBot:
    from langchain_groq import ChatGroq

    GROQ_API_KEY = os.getenv("GROQ_API_KEY")

    LLM = ChatGroq(model="llama-3.3-70b-versatile",
                   temperature=0.6,
                   max_tokens=1024,
                   api_key=GROQ_API_KEY)

class SettingNetwork:
    BASE_URL_API = os.getenv("PUBLIC_API_URL") or "http://localhost:8000"
    URL_FRONTEND = os.getenv("PUBLIC_FRONTEND_URL") or "http://localhost:5173"

settings_server = SettingServer()
settings_metric_transport = SettingMetricTransport()
settings_chat_bot = SettingChatBot()
settings_network = SettingNetwork()
setting_chatbot = SettingChatBot()

# ================= Traffic Thresholds (per-road) =================
# v: average speed threshold (km/h) - >= v => fast, else slow
# c1: vehicle count threshold for busy
# c2: vehicle count threshold for congested

from typing import Dict, TypedDict


class RoadThreshold(TypedDict):
    v: int
    c1: int
    c2: int


TRAFFIC_THRESHOLDS: Dict[str, RoadThreshold] = {
    "Đường Láng": {"v": 13, "c1": 17, "c2": 26},
    "Ngã Tư Sở": {"v": 17, "c1": 45, "c2": 57},
    "Nguyễn Trãi": {"v": 30, "c1": 25, "c2": 35},
    "Văn Phú": {"v": 15, "c1": 18, "c2": 26},
}

DEFAULT_THRESHOLD: RoadThreshold = {"v": 15, "c1": 15, "c2": 25}


def get_threshold_for_road(road_name: str) -> RoadThreshold:
    return TRAFFIC_THRESHOLDS.get(road_name, DEFAULT_THRESHOLD)
