"""
TinyWin — Payments (YooKassa + SBP) — placeholder for now
"""
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from config import YOOKASSA_SHOP_ID, YOOKASSA_SECRET_KEY, PRICE_MONTHLY, PRICE_YEARLY
from database import get_db
from models import User, Subscription, Payment
from auth import get_current_user

router = APIRouter(prefix="/api/payments", tags=["payments"])


class CreatePaymentRequest(BaseModel):
    plan: str  # "monthly" or "yearly"


class PaymentResponse(BaseModel):
    payment_url: str
    payment_id: str


class SubscriptionResponse(BaseModel):
    plan: str
    is_premium: bool
    expires_at: str | None


@router.get("/subscription", response_model=SubscriptionResponse)
def get_subscription(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = user.subscription
    return SubscriptionResponse(
        plan=sub.plan if sub else "free",
        is_premium=sub.is_premium if sub else False,
        expires_at=sub.expires_at.isoformat() if sub and sub.expires_at else None,
    )


@router.post("/create", response_model=PaymentResponse)
def create_payment(
    req: CreatePaymentRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if req.plan not in ("monthly", "yearly"):
        raise HTTPException(status_code=400, detail="Неверный тариф")

    if not YOOKASSA_SHOP_ID or not YOOKASSA_SECRET_KEY:
        raise HTTPException(
            status_code=503,
            detail="Платежная система ещё не настроена. Скоро будет доступна!",
        )

    amount = PRICE_MONTHLY if req.plan == "monthly" else PRICE_YEARLY

    # ── YooKassa integration ──
    # When you have credentials, uncomment and use:
    #
    # from yookassa import Configuration, Payment as YPayment
    # Configuration.account_id = YOOKASSA_SHOP_ID
    # Configuration.secret_key = YOOKASSA_SECRET_KEY
    #
    # payment = YPayment.create({
    #     "amount": {"value": str(amount), "currency": "RUB"},
    #     "confirmation": {
    #         "type": "redirect",
    #         "return_url": "https://yourdomain.com/payment-success",
    #     },
    #     "capture": True,
    #     "description": f"TinyWin Premium — {req.plan}",
    #     "metadata": {"user_id": user.id, "plan": req.plan},
    #     "payment_method_data": {"type": "sbp"},  # СБП!
    # })
    #
    # db_payment = Payment(
    #     user_id=user.id,
    #     amount=amount,
    #     plan=req.plan,
    #     status="pending",
    #     yookassa_id=payment.id,
    # )
    # db.add(db_payment)
    # db.commit()
    #
    # return PaymentResponse(
    #     payment_url=payment.confirmation.confirmation_url,
    #     payment_id=payment.id,
    # )

    raise HTTPException(status_code=503, detail="Платежи скоро будут доступны")


@router.post("/webhook")
async def payment_webhook(request: Request, db: Session = Depends(get_db)):
    """
    YooKassa sends webhooks when payment status changes.
    Configure webhook URL in YooKassa dashboard: https://yourdomain.com/api/payments/webhook
    """
    body = await request.json()
    event_type = body.get("event")
    payment_obj = body.get("object", {})
    yookassa_id = payment_obj.get("id")

    if event_type == "payment.succeeded" and yookassa_id:
        db_payment = db.query(Payment).filter(Payment.yookassa_id == yookassa_id).first()
        if db_payment and db_payment.status != "succeeded":
            db_payment.status = "succeeded"

            # Activate subscription
            sub = db.query(Subscription).filter(Subscription.user_id == db_payment.user_id).first()
            if sub:
                sub.plan = db_payment.plan
                sub.is_active = True
                sub.started_at = datetime.utcnow()
                if db_payment.plan == "monthly":
                    sub.expires_at = datetime.utcnow() + timedelta(days=30)
                elif db_payment.plan == "yearly":
                    sub.expires_at = datetime.utcnow() + timedelta(days=365)

            db.commit()

    return {"status": "ok"}
