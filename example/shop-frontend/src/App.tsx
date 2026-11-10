import React, { useState } from 'react';
import { ProductList } from './pages/ProductList';
import { CheckoutPage } from './pages/CheckoutPage';
import { OrderStatus } from './pages/OrderStatus';
import { OrderItem } from './types';

export default function App() {
  const [cart, setCart] = useState<OrderItem[]>([]);
  return (
    <main>
      <ProductList onAdd={(p) => setCart([...cart, { sku: p.sku, quantity: 1 }])} />
      <CheckoutPage cart={cart} />
      <OrderStatus orderId="demo" />
    </main>
  );
}
