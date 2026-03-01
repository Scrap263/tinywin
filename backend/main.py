"""
TinyWin — FastAPI Main Application
Run: uvicorn main:app --reload --port 8000
"""
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from database import init_db
import auth
import ai
import progress
import payments

# ── App ──
app = FastAPI(
    title="TinyWin API",
    description="Маленькие победы каждый день — Backend API",
    version="1.0.0",
)

# ── Routers ──
app.include_router(auth.router)
app.include_router(ai.router)
app.include_router(progress.router)
app.include_router(payments.router)

# ── Static files (frontend) ──
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"

# Serve static assets (CSS, JS)
if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ── Serve frontend ──
@app.get("/")
def serve_index():
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return FileResponse(str(index_path))
    return {"message": "TinyWin API is running. Frontend not found at /frontend/"}


@app.get("/pricing")
def serve_pricing():
    return FileResponse(str(FRONTEND_DIR / "pricing.html"))


@app.get("/terms")
def serve_terms():
    return FileResponse(str(FRONTEND_DIR / "terms.html"))


@app.get("/contacts")
def serve_contacts():
    return FileResponse(str(FRONTEND_DIR / "contacts.html"))


# ── Startup ──
@app.on_event("startup")
def on_startup():
    init_db()
    print("[OK] TinyWin backend started")
    print(f"[DIR] Frontend dir: {FRONTEND_DIR}")
    print("[API] API docs: http://localhost:8000/docs")
