from api.v1 import state
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from schemas.ChatRequest import ChatRequest 
from schemas.ChatResponse import ChatResponse
from services.chat_services.ChatBotAgent import ChatBotAgent
from utils.jwt_handler import get_current_user, get_current_user_ws
from fastapi import Depends


router = APIRouter()

@router.on_event("startup")
def start_up():
    if not hasattr(state, 'agent') or state.agent is None:
        print("Đang khởi tạo Chat Agent...")
        try:
            state.agent = ChatBotAgent()
            print("Khởi tạo Chat Agent thành công")
        except Exception as e:
            print(f"Không thể khởi tạo Chat Agent: {e}")
            state.agent = None

@router.post(
    path='/chat',
    response_model=ChatResponse,
    summary="Chat với AI Assistant",
    description="API gửi tin nhắn tới AI Chatbot và nhận phản hồi. AI có thể trả lời về giao thông, cung cấp hình ảnh và thông tin liên quan. Yêu cầu JWT authentication."
)
async def chat(request: ChatRequest, current_user = Depends(get_current_user)):
    data = await state.agent.get_response(request.message, id= current_user.id)
    return ChatResponse(
        message=data["message"],
        image=data["image"]
    )   
    
@router.post(
    path='/chat_no_auth',
    response_model=ChatResponse,
    summary="Chat với AI (không xác thực)",
    description="API gửi tin nhắn tới AI Chatbot KHÔNG yêu cầu authentication. Dùng cho demo hoặc public access. Mặc định sử dụng user_id = 1."
)
async def chat_no_auth(request: ChatRequest):
    data = await state.agent.get_response(request.message, id= 9999)
    return ChatResponse(
        message=data["message"],
        image=data["image"]
    )
    
@router.websocket(
    path = "/ws/chat",
    name="WebSocket Chat"
)
async def websocket_chat(
    websocket: WebSocket,
    current_user = Depends(get_current_user_ws)
):
    """
    WebSocket endpoint cho AI ChatBot Agent.
    
    Args:
        current_user: User đã được xác thực (tự động inject bởi FastAPI)
    
    Flow:
    - Client gửi JSON: {"message": "..."}
    - Server trả JSON: {"message": "...", "image": "..."}
    
    Authentication:
        Yêu cầu token qua query params (?token=...), cookie (access_token), hoặc header (Authorization: Bearer ...)
    """
    await websocket.accept()
    
    try:
        while True:
            data = await websocket.receive_json()
            user_message = data.get("message", "")
            if not user_message:
                await websocket.send_json({"message": "Bạn chưa nhập tin nhắn.", "image": None})
                continue

            response = await state.agent.get_response(user_message, id=current_user.id)
            await websocket.send_json({
                "message": response["message"],
                "image": response["image"]
            })

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
        try:
            await websocket.send_json({
                "message": f"Lỗi: {str(e)}",
                "image": None
            })
        except:
            pass
        await websocket.close()