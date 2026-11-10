export interface OrderItem {
  sku: string;
  quantity: number;
}

export interface CreateOrderRequest {
  customerEmail: string;
  items: OrderItem[];
}

export interface Order {
  id: string;
  customerEmail: string;
  items: OrderItem[];
  total: number;
  status: 'PENDING' | 'CONFIRMED' | 'REJECTED';
}

export interface Product {
  sku: string;
  name: string;
  price: number;
  qty: number;
}
