from langchain_groq import ChatGroq
import os
from dotenv import load_dotenv

load_dotenv()

class SettingChatBot:
    GROQ_API_KEY = os.getenv("GROQ_API_KEY")

    LLM = ChatGroq(
        model="llama-3.3-70b-versatile",
        temperature=0.6,
        max_tokens=1024,
        api_key=GROQ_API_KEY
    )
