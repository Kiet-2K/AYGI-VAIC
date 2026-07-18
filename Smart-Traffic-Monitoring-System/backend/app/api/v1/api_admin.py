import asyncio
from fastapi import APIRouter, Depends, HTTPException, WebSocketDisconnect, status, WebSocket
from utils.jwt_handler import get_current_user, get_current_user_ws
from models.user import User
from utils.system_metrics import get_system_metrics


router = APIRouter(prefix="/admin")


@router.get(
    path= "/resources",
    summary="Lấy thông tin tài nguyên hệ thống",
    description="API trả về metrics hệ thống (CPU, RAM, Disk, Network). Chỉ admin (role_id = 0) mới có quyền truy cập."
)
async def get_resources(current_user: User = Depends(get_current_user)):
    """Return basic system metrics. Admin only (role_id = 0)."""
    if current_user.role_id != 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ admin mới được phép truy cập tài nguyên hệ thống.",
        )
    return get_system_metrics()

@router.websocket(
    path= "/ws/resources",
    name="WebSocket thông báo hệ thống cho admin"
)
async def websocket_resources(websocket: WebSocket, current_user: User = Depends(get_current_user_ws)):
    """
    WebSocket endpoint để gửi thông tin tài nguyên hệ thống theo thời gian thực cho admin.
    
    Args:
        current_user: User đã được xác thực (tự động inject bởi FastAPI)
        
    Authentication:
        Yêu cầu JWT token trong Authorization header (Bearer ...)
    """
    if current_user.role_id != 0:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Chỉ admin mới được phép truy cập tài nguyên hệ thống.",
        )
        
    await websocket.accept()
    
    try:
        while True:
            metrics = get_system_metrics()
            await websocket.send_json(metrics)
            await asyncio.sleep(2) 
    except WebSocketDisconnect:
        pass