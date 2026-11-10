const Order = require('../models/Order');
const inventoryClient = require('../clients/inventoryClient');

// body: { customerEmail: string, items: [{ sku: string, quantity: number }] }
exports.createOrder = async (req, res) => {
  const { customerEmail, items } = req.body;

  const reservation = await inventoryClient.reserveStock(items);
  const order = await Order.create({
    customerEmail,
    items,
    total: reservation.total,
    status: reservation.ok ? 'CONFIRMED' : 'REJECTED',
  });

  res.status(201).json(order);
};

exports.getOrder = async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(order);
};
