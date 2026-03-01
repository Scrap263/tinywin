"""
TinyWin — Authentication (register, login, JWT, email verification)
"""
import random
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
import bcrypt
import jwt
import uuid

from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

from config import (
    JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRE_HOURS,
    SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM,
    GOOGLE_CLIENT_ID,
)
from database import get_db
from models import User, Subscription, Progress

router = APIRouter(prefix="/api/auth", tags=["auth"])
security = HTTPBearer(auto_error=False)


# ── Schemas ──

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    name: str = ""


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class GoogleAuthRequest(BaseModel):
    credential: str


class VerifyRequest(BaseModel):
    email: EmailStr
    code: str


class ResendRequest(BaseModel):
    email: EmailStr


class UserResponse(BaseModel):
    id: int
    email: str
    name: str
    plan: str
    is_premium: bool
    is_verified: bool


class TokenResponse(BaseModel):
    token: str
    user: UserResponse


class MessageResponse(BaseModel):
    message: str


# ── Helpers ──

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def create_token(user_id: int) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> int:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return int(payload["sub"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Токен истёк")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Невалидный токен")


def generate_code() -> str:
    return str(random.randint(100000, 999999))


def send_verification_email(to_email: str, code: str):
    """Send 6-digit verification code via SMTP."""
    if not SMTP_USER or not SMTP_PASSWORD:
        print(f"[MAIL] SMTP not configured. Code for {to_email}: {code}")
        return  # Skip sending if SMTP not configured

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"TinyWin — код подтверждения: {code}"
    msg["From"] = SMTP_FROM
    msg["To"] = to_email

    html = f"""
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 400px; margin: 0 auto; padding: 32px; background: #0a1a14; color: #e0e0e0; border-radius: 16px;">
        <h1 style="color: #4ade80; font-size: 24px; margin-bottom: 8px;">TinyWin</h1>
        <p style="color: #888; font-size: 14px; margin-bottom: 24px;">Маленькие победы каждый день</p>
        <p style="font-size: 15px;">Ваш код подтверждения:</p>
        <div style="background: #1a2f23; border: 1px solid #4ade8033; border-radius: 12px; padding: 20px; text-align: center; margin: 16px 0;">
            <span style="font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #4ade80;">{code}</span>
        </div>
        <p style="font-size: 13px; color: #666;">Код действителен 30 минут. Если вы не регистрировались в TinyWin, проигнорируйте это письмо.</p>
    </div>
    """

    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT) as server:
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM, to_email, msg.as_string())
        print(f"[MAIL] Verification code sent to {to_email}")
    except Exception as e:
        print(f"[MAIL] Error sending to {to_email}: {e}")
        # Don't fail registration if email fails
        print(f"[MAIL] Fallback — code for {to_email}: {code}")


def get_user_response(user: User) -> UserResponse:
    sub = user.subscription
    return UserResponse(
        id=user.id,
        email=user.email,
        name=user.name or "",
        plan=sub.plan if sub else "free",
        is_premium=sub.is_premium if sub else False,
        is_verified=user.is_verified,
    )


# ── Dependency: current user ──

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    if not credentials:
        raise HTTPException(status_code=401, detail="Необходима авторизация")
    user_id = decode_token(credentials.credentials)
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    return user


# ── Routes ──

@router.post("/register", response_model=TokenResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    # Check if exists
    existing = db.query(User).filter(User.email == req.email.lower()).first()
    if existing:
        raise HTTPException(status_code=400, detail="Email уже зарегистрирован")

    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Пароль должен быть минимум 6 символов")

    # Generate verification code
    code = generate_code()

    # Create user (unverified)
    user = User(
        email=req.email.lower(),
        password_hash=hash_password(req.password),
        name=req.name,
        is_verified=False,
        verification_code=code,
    )
    db.add(user)
    db.flush()

    # Create free subscription
    sub = Subscription(user_id=user.id, plan="free", is_active=True)
    db.add(sub)

    # Create empty progress
    progress = Progress(user_id=user.id)
    db.add(progress)

    db.commit()
    db.refresh(user)

    # Send verification email
    send_verification_email(user.email, code)

    token = create_token(user.id)
    return TokenResponse(token=token, user=get_user_response(user))


@router.post("/verify", response_model=TokenResponse)
def verify_email(req: VerifyRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    if user.is_verified:
        token = create_token(user.id)
        return TokenResponse(token=token, user=get_user_response(user))

    if not user.verification_code or user.verification_code != req.code.strip():
        raise HTTPException(status_code=400, detail="Неверный код")

    user.is_verified = True
    user.verification_code = None
    db.commit()
    db.refresh(user)

    token = create_token(user.id)
    return TokenResponse(token=token, user=get_user_response(user))


@router.post("/resend", response_model=MessageResponse)
def resend_code(req: ResendRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")

    if user.is_verified:
        return MessageResponse(message="Email уже подтверждён")

    code = generate_code()
    user.verification_code = code
    db.commit()

    send_verification_email(user.email, code)
    return MessageResponse(message="Код отправлен повторно")


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email.lower()).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")

    token = create_token(user.id)
    return TokenResponse(token=token, user=get_user_response(user))

@router.get("/config")
def get_auth_config():
    return {"google_client_id": GOOGLE_CLIENT_ID}


@router.get("/me", response_model=UserResponse)
def me(user: User = Depends(get_current_user)):
    return get_user_response(user)


@router.post("/google", response_model=TokenResponse)
def google_auth(req: GoogleAuthRequest, db: Session = Depends(get_db)):
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=400, detail="Google Auth не настроен")

    try:
        idinfo = id_token.verify_oauth2_token(
            req.credential, google_requests.Request(), GOOGLE_CLIENT_ID
        )
        email = idinfo.get("email")
        name = idinfo.get("name", "")
        if not email:
            raise HTTPException(status_code=400, detail="Отсутствует email")
        email = email.lower()
    except ValueError:
        raise HTTPException(status_code=400, detail="Невалидный токен Google")

    user = db.query(User).filter(User.email == email).first()
    if not user:
        # Automatic DB creation on Google login
        pw = hash_password(str(uuid.uuid4()))
        user = User(
            email=email,
            password_hash=pw,
            name=name,
            is_verified=True,  # Google emails are verified
        )
        db.add(user)
        db.flush()

        sub = Subscription(user_id=user.id, plan="free", is_active=True)
        db.add(sub)

        progress = Progress(user_id=user.id)
        db.add(progress)

        db.commit()
        db.refresh(user)
    else:
        # If user registered explicitly but didn't verify, doing Google login verifies them.
        if not user.is_verified:
            user.is_verified = True
            db.commit()

    token = create_token(user.id)
    return TokenResponse(token=token, user=get_user_response(user))
