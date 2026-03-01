"""
TinyWin — SQLAlchemy models
"""
from datetime import datetime, date
from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, Date, ForeignKey
from sqlalchemy.orm import relationship
from database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    name = Column(String(100), default="")
    is_verified = Column(Boolean, default=False)
    verification_code = Column(String(6), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    subscription = relationship("Subscription", back_populates="user", uselist=False)
    usage_records = relationship("UsageRecord", back_populates="user")
    progress = relationship("Progress", back_populates="user", uselist=False)


class Subscription(Base):
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    plan = Column(String(20), default="free")  # free / monthly / yearly
    is_active = Column(Boolean, default=False)
    started_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="subscription")

    @property
    def is_premium(self) -> bool:
        if self.plan == "free" or not self.is_active:
            return False
        if self.expires_at and self.expires_at < datetime.utcnow():
            return False
        return True


class UsageRecord(Base):
    __tablename__ = "usage"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    usage_date = Column(Date, default=date.today, nullable=False)
    decompose_count = Column(Integer, default=0)
    split_count = Column(Integer, default=0)

    user = relationship("User", back_populates="usage_records")


class Progress(Base):
    __tablename__ = "progress"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    state_json = Column(Text, default="{}")
    daily_json = Column(Text, default="{}")
    settings_json = Column(Text, default="{}")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    user = relationship("User", back_populates="progress")


class Payment(Base):
    __tablename__ = "payments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    amount = Column(Integer, nullable=False)  # in rubles
    plan = Column(String(20), nullable=False)
    status = Column(String(20), default="pending")  # pending / succeeded / canceled
    yookassa_id = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
