import React, { useEffect, useState } from 'react';
import { listProducts } from '../api/products';
import { Product } from '../types';

export function ProductList({ onAdd }: { onAdd: (p: Product) => void }) {
  const [products, setProducts] = useState<Product[]>([]);

  useEffect(() => {
    listProducts().then(setProducts);
  }, []);

  return (
    <ul>
      {products.map((p) => (
        <li key={p.sku}>
          {p.name} - {p.price} <button onClick={() => onAdd(p)}>Add</button>
        </li>
      ))}
    </ul>
  );
}
