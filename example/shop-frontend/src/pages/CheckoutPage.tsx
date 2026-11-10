import React, { useState } from 'react';
import { createOrder } from '../api/orders';
import { OrderItem } from '../types';

export function CheckoutPage({ cart }: { cart: OrderItem[] }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const submit = async () => {
    const order = await createOrder({ customerEmail: email, items: cart });
    setMessage(`Order ${order.id} is ${order.status}`);
  };

  return (
    <div>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <button onClick={submit}>Place order</button>
      <p>{message}</p>
    </div>
  );
}
