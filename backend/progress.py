"""
TinyWin — User progress sync
"""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import User, Progress
from auth import get_current_user

router = APIRouter(prefix="/api/user", tags=["user"])


class ProgressData(BaseModel):
    state: dict = {}
    daily: dict = {}
    settings: dict = {}


class ProgressResponse(BaseModel):
    state: dict
    daily: dict
    settings: dict


@router.get("/progress", response_model=ProgressResponse)
def get_progress(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    progress = db.query(Progress).filter(Progress.user_id == user.id).first()
    if not progress:
        return ProgressResponse(state={}, daily={}, settings={})

    return ProgressResponse(
        state=json.loads(progress.state_json or "{}"),
        daily=json.loads(progress.daily_json or "{}"),
        settings=json.loads(progress.settings_json or "{}"),
    )


@router.post("/progress", response_model=ProgressResponse)
def save_progress(
    data: ProgressData,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    progress = db.query(Progress).filter(Progress.user_id == user.id).first()
    if not progress:
        progress = Progress(user_id=user.id)
        db.add(progress)

    progress.state_json = json.dumps(data.state, ensure_ascii=False)
    progress.daily_json = json.dumps(data.daily, ensure_ascii=False)
    progress.settings_json = json.dumps(data.settings, ensure_ascii=False)
    db.commit()

    return ProgressResponse(state=data.state, daily=data.daily, settings=data.settings)
