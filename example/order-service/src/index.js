const express = require('express');
const mongoose = require('mongoose');
const ordersRouter = require('./routes/orders');
const productsRouter = require('./routes/products');

const app = express();
app.use(express.json());

app.use('/api/orders', ordersRouter);
app.use('/api/products', productsRouter);

mongoose.connect(process.env.MONGO_URL || 'mongodb://localhost:27017/shop');
app.listen(process.env.PORT || 4000, () => console.log('order-service on 4000'));
