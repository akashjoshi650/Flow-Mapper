import sqlite3
from typing import List

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="inventory-service")
db = sqlite3.connect("inventory.db", check_same_thread=False)


class ReserveItem(BaseModel):
    sku: str
    quantity: int


class ReserveRequest(BaseModel):
    items: List[ReserveItem]


class ReserveResponse(BaseModel):
    ok: bool
    total: float


@app.get("/products")
def list_products():
    rows = db.execute("SELECT sku, name, price, qty FROM products").fetchall()
    return [{"sku": r[0], "name": r[1], "price": r[2], "qty": r[3]} for r in rows]


@app.get("/stock/{sku}")
def get_stock(sku: str):
    row = db.execute("SELECT qty FROM products WHERE sku = ?", (sku,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Unknown sku")
    return {"sku": sku, "qty": row[0]}


@app.post("/stock/reserve", response_model=ReserveResponse)
def reserve_stock(body: ReserveRequest):
    total = 0.0
    for item in body.items:
        row = db.execute("SELECT price, qty FROM products WHERE sku = ?", (item.sku,)).fetchone()
        if row is None or row[1] < item.quantity:
            return ReserveResponse(ok=False, total=0)
        total += row[0] * item.quantity
    for item in body.items:
        db.execute("UPDATE products SET qty = qty - ? WHERE sku = ?", (item.quantity, item.sku))
    db.commit()
    return ReserveResponse(ok=True, total=total)


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
