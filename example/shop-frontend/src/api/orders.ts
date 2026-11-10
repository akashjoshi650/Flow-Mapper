import { api } from './client';
import { CreateOrderRequest, Order } from '../types';

export async function createOrder(payload: CreateOrderRequest): Promise<Order> {
  const res = await api.post<Order>('/orders', payload);
  return res.data;
}

export async function getOrder(id: string): Promise<Order> {
  const res = await api.get<Order>(`/orders/${id}`);
  return res.data;
}
