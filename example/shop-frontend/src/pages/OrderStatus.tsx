import React, { useEffect, useState } from 'react';
import { getOrder } from '../api/orders';
import { Order } from '../types';

export function OrderStatus({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);

  useEffect(() => {
    getOrder(orderId).then(setOrder);
  }, [orderId]);

  return <p>{order ? `Status: ${order.status}` : "Loading..."}</p>;
}
