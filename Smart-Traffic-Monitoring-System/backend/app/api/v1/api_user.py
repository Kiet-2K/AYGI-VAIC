from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from core.security import hash_password, verify_password
from db.base import get_db
from models.user import User
from utils.jwt_handler import get_current_user

router = APIRouter()


class PasswordUpdateRequest(BaseModel):
    old_password: str
    new_password: str = Field(min_length=8)


class ProfileUpdateRequest(BaseModel):
    username: str | None = None
    email: str | None = None
    phone_number: str | None = None


@router.put(
    "/password",
    summary="Thay đổi mật khẩu",
    description="API cập nhật mật khẩu của user. Yêu cầu xác thực mật khẩu cũ và JWT authentication.",
)
async def update_password(
    request: PasswordUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's password using the app's async database session."""
    if not verify_password(request.old_password, current_user.password):
        raise HTTPException(status_code=400, detail="Mật khẩu hiện tại không đúng!")

    current_user.password = hash_password(request.new_password)
    try:
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Đã xảy ra lỗi khi cập nhật mật khẩu. Vui lòng thử lại sau.",
        ) from exc

    return {"message": "Cập nhật mật khẩu thành công!"}


@router.put(
    "/profile",
    summary="Cập nhật thông tin cá nhân",
    description="API cập nhật profile của user (username, email, phone_number). Username, email và số điện thoại phải là duy nhất. Yêu cầu JWT authentication.",
)
async def update_profile(
    request: ProfileUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's profile with async SQLAlchemy operations."""
    updates = request.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="Không có thông tin nào để cập nhật!")

    for field_name, value in updates.items():
        if value == getattr(current_user, field_name):
            continue

        existing = await db.execute(
            select(User).where(getattr(User, field_name) == value)
        )
        if existing.scalar_one_or_none() is not None:
            labels = {
                "username": "Tên đăng nhập",
                "email": "Email",
                "phone_number": "Số điện thoại",
            }
            raise HTTPException(
                status_code=400,
                detail=f"{labels[field_name]} đã được sử dụng!",
            )
        setattr(current_user, field_name, value)

    try:
        await db.commit()
        await db.refresh(current_user)
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Tên đăng nhập, email hoặc số điện thoại đã được sử dụng!",
        ) from exc
    except Exception as exc:
        await db.rollback()
        raise HTTPException(
            status_code=500,
            detail="Đã xảy ra lỗi khi cập nhật thông tin. Vui lòng thử lại sau.",
        ) from exc

    return {"message": "Cập nhật thông tin thành công!"}