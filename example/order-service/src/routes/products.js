const express = require('express');
const inventoryClient = require('../clients/inventoryClient');

const router = express.Router();

// The frontend never talks to inventory-service directly; this endpoint proxies it.
router.get('/', async (req, res) => {
  const products = await inventoryClient.fetchProducts();
  res.json(products);
});

module.exports = router;
