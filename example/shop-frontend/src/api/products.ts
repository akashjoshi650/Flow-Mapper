import { Product } from '../types';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:4000/api';

export async function listProducts(): Promise<Product[]> {
  const res = await fetch(`${API_URL}/products`);
  return res.json();
}
