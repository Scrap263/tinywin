"""
TinyWin — Configuration
"""
import os

# ── DeepSeek AI ──
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "sk-6d164dd41bc44ee0afc81cc94b7afd7f")
DEEPSEEK_API_URL = os.getenv("DEEPSEEK_API_URL", "https://api.deepseek.com/chat/completions")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

# ── JWT Auth ──
JWT_SECRET = os.getenv("JWT_SECRET", "tinywin-secret-change-me-in-production-2026")
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 72  # token lives 3 days

# ── Free tier limits (per month) ──
FREE_DECOMPOSE_PER_MONTH = 3
FREE_SPLIT_PER_MONTH = 2

# ── Database ──
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./tinywin.db")

# ── YooKassa (fill when you have credentials) ──
YOOKASSA_SHOP_ID = os.getenv("YOOKASSA_SHOP_ID", "")
YOOKASSA_SECRET_KEY = os.getenv("YOOKASSA_SECRET_KEY", "")

# ── Subscription prices (RUB) ──
PRICE_MONTHLY = 399
PRICE_YEARLY = 3290

# ── SMTP (email verification) ──
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
SMTP_USER = os.getenv("SMTP_USER", "cemenjpek@gmail.com")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "mwfgiehlzapjtdru")
SMTP_FROM = os.getenv("SMTP_FROM", "cemenjpek@gmail.com")

# ── Google Auth ──
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")


