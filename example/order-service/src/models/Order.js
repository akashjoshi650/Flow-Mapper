const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  customerEmail: { type: String, required: true },
  items: [{ sku: String, quantity: Number }],
  total: Number,
  status: { type: String, enum: ['PENDING', 'CONFIRMED', 'REJECTED'], default: 'PENDING' },
});

module.exports = mongoose.model('Order', orderSchema);
