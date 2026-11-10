const axios = require('axios');

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:5000';

exports.reserveStock = async (items) => {
  const res = await axios.post(`${INVENTORY_URL}/stock/reserve`, { items });
  return res.data; // { ok: boolean, total: number }
};

exports.fetchProducts = async () => {
  const res = await axios.get(`${INVENTORY_URL}/products`);
  return res.data;
};
