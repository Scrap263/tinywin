"""
TinyWin — AI Proxy (DeepSeek) with monthly usage limits
"""
from datetime import date
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func, extract
import httpx

from config import (
    DEEPSEEK_API_KEY, DEEPSEEK_API_URL, DEEPSEEK_MODEL,
    FREE_DECOMPOSE_PER_MONTH, FREE_SPLIT_PER_MONTH,
)
from database import get_db
from models import User, UsageRecord
from auth import get_current_user

router = APIRouter(prefix="/api/ai", tags=["ai"])

# ── System Prompts ──

SYSTEM_PROMPT = """Ты — ассистент для людей с СДВГ и исполнительной дисфункцией. Твоя единственная задача — разбить задачу пользователя на микро-шаги.

СТРОГИЕ ПРАВИЛА:
1. Каждый шаг — ОДНО физическое действие (встань, возьми, положи, открой, нажми, подойди).
2. Шаг должен занимать НЕ БОЛЕЕ 30 секунд.
3. Начинай с самого простого действия — "Встань", "Подойди к...", "Посмотри на...".
4. Используй повелительное наклонение (ты-форма).
5. НЕ группируй действия — одно действие = один шаг.
6. НЕ нумеруй шаги.
7. Будь тёплым и поддерживающим, но максимально лаконичным.
8. Последний шаг — позитивное подкрепление результата.
9. Генерируй 8–20 шагов в зависимости от сложности задачи.
10. Отвечай ТОЛЬКО списком шагов, каждый на отдельной строке.
11. Без нумерации, без тире, без маркеров, без лишнего текста.
12. Каждый шаг — простое короткое предложение на русском языке."""

SPLIT_SYSTEM_PROMPT = """Ты — ассистент для людей с СДВГ. Пользователь застрял на конкретном шаге и ему нужно разбить его на ещё более мелкие части.

ПРАВИЛА:
1. Разбей один шаг на 2–4 ещё более простых микро-шага.
2. Каждый микро-шаг — одно ФИЗИЧЕСКОЕ действие (максимально атомарное).
3. Используй повелительное наклонение.
4. Первый шаг может быть "Просто подумай о том, чтобы..." — чтобы снизить порог входа.
5. Отвечай ТОЛЬКО списком шагов, каждый на отдельной строке, без нумерации, без маркеров."""


# ── Schemas ──

class DecomposeRequest(BaseModel):
    task: str


class SplitRequest(BaseModel):
    step: str
    task_context: str


class AIResponse(BaseModel):
    steps: list[str]
    remaining: int


# ── Helpers ──

def get_monthly_usage(db: Session, user_id: int) -> dict:
    """Sum decompose_count and split_count for current month."""
    today = date.today()
    result = db.query(
        func.coalesce(func.sum(UsageRecord.decompose_count), 0),
        func.coalesce(func.sum(UsageRecord.split_count), 0),
    ).filter(
        UsageRecord.user_id == user_id,
        extract("year", UsageRecord.usage_date) == today.year,
        extract("month", UsageRecord.usage_date) == today.month,
    ).first()
    return {"decompose": result[0], "split": result[1]}


def get_or_create_daily_record(db: Session, user_id: int) -> UsageRecord:
    """Get or create today's usage record (for incrementing)."""
    today = date.today()
    record = db.query(UsageRecord).filter(
        UsageRecord.user_id == user_id,
        UsageRecord.usage_date == today,
    ).first()
    if not record:
        record = UsageRecord(user_id=user_id, usage_date=today)
        db.add(record)
        db.flush()
    return record


def check_limit(user: User, monthly: dict, request_type: str):
    """Check if user can make this request. Raises HTTPException if limit reached."""
    sub = user.subscription
    if sub and sub.is_premium:
        return  # unlimited

    if request_type == "decompose":
        if monthly["decompose"] >= FREE_DECOMPOSE_PER_MONTH:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "limit_reached",
                    "message": f"Лимит бесплатных декомпозиций исчерпан ({FREE_DECOMPOSE_PER_MONTH}/мес). Перейди на Premium для безлимитного доступа.",
                    "limit": FREE_DECOMPOSE_PER_MONTH,
                    "used": monthly["decompose"],
                },
            )
    elif request_type == "split":
        if monthly["split"] >= FREE_SPLIT_PER_MONTH:
            raise HTTPException(
                status_code=429,
                detail={
                    "error": "limit_reached",
                    "message": f"Лимит бесплатных дроблений исчерпан ({FREE_SPLIT_PER_MONTH}/мес). Перейди на Premium.",
                    "limit": FREE_SPLIT_PER_MONTH,
                    "used": monthly["split"],
                },
            )


def parse_steps(text: str) -> list[str]:
    return [
        line.strip()
        for raw in text.split("\n")
        if (line := raw.lstrip("0123456789.-*•–—> ").strip()) and 2 < len(line) < 200
    ]


async def call_deepseek(system_prompt: str, user_message: str) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            DEEPSEEK_API_URL,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            },
            json={
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "temperature": 0.7,
                "max_tokens": 1024,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Ошибка ИИ: {resp.text[:200]}")

    data = resp.json()
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise HTTPException(status_code=502, detail="Пустой ответ от ИИ")
    return content


# ── Routes ──

@router.post("/decompose", response_model=AIResponse)
async def decompose(
    req: DecomposeRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not req.task.strip():
        raise HTTPException(status_code=400, detail="Задача не может быть пустой")

    monthly = get_monthly_usage(db, user.id)
    check_limit(user, monthly, "decompose")

    content = await call_deepseek(SYSTEM_PROMPT, f'Задача: "{req.task.strip()}"')
    steps = parse_steps(content)

    if len(steps) < 2:
        raise HTTPException(status_code=502, detail="ИИ вернул слишком мало шагов")

    # Increment today's record
    record = get_or_create_daily_record(db, user.id)
    record.decompose_count += 1
    db.commit()

    sub = user.subscription
    is_premium = sub and sub.is_premium
    remaining = 999 if is_premium else max(0, FREE_DECOMPOSE_PER_MONTH - (monthly["decompose"] + 1))

    return AIResponse(steps=steps, remaining=remaining)


@router.post("/split", response_model=AIResponse)
async def split_step(
    req: SplitRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not req.step.strip():
        raise HTTPException(status_code=400, detail="Шаг не может быть пустым")

    monthly = get_monthly_usage(db, user.id)
    check_limit(user, monthly, "split")

    prompt = (
        f'Контекст задачи: "{req.task_context}"\n'
        f'Шаг, на котором пользователь застрял: "{req.step}"\n\n'
        f'Разбей этот шаг на 2–4 более простых микро-шага.'
    )
    content = await call_deepseek(SPLIT_SYSTEM_PROMPT, prompt)
    steps = parse_steps(content)

    if len(steps) < 2:
        steps = [
            f"Просто подумай о том, чтобы {req.step.lower()}",
            "А теперь просто сделай первое движение",
        ]

    record = get_or_create_daily_record(db, user.id)
    record.split_count += 1
    db.commit()

    sub = user.subscription
    is_premium = sub and sub.is_premium
    remaining = 999 if is_premium else max(0, FREE_SPLIT_PER_MONTH - (monthly["split"] + 1))

    return AIResponse(steps=steps, remaining=remaining)
