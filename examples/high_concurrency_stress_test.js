'use strict';

const { EchoEntriesDB } = require('../index');

async function runHighConcurrencyStressTest() {
  console.log('================================================================');
  console.log('  500 CONCURRENT USERS HIGH-LOAD STRESS TEST — ECHO ENTRIES DB  ');
  console.log('================================================================\n');

  const WAL_PATH = './.echodb_stress_wal.json';
  const credentials = {
    email:            process.env.EE_EMAIL || 'user@example.com',
    password:         process.env.EE_PASSWORD || 'password123',
    encryptionSecret: process.env.EE_SECRET || 'stress-test-secret',
    walPath:          WAL_PATH,
    autoSyncMs:       0,
    compactEvery:     50,
    batchSize:        20,
    batchWindowMs:    10
  };

  const db = new EchoEntriesDB(credentials);
  await db.init();

  // Clean up previous stress test collections
  const testCols = ['users', 'products', 'orders', 'inventory_logs', 'reviews'];
  for (const cName of testCols) {
    const col = db.collection(cName);
    for (const doc of col.all()) await col.delete(doc.id);
  }
  await db.flush();

  // Set up secondary indexes
  db.createIndex('users',          'role');
  db.createIndex('products',       'categoryId');
  db.createIndex('products',       'status');
  db.createIndex('orders',         'customerId');
  db.createIndex('orders',         'status');
  db.createIndex('inventory_logs', 'productId');
  db.createIndex('reviews',        'productId');

  // Seed initial data: 500 users, 50 products across 5 categories
  console.log('🌱 Seeding initial data (500 users, 50 catalog items)...');
  const usersCol = db.collection('users');
  const productsCol = db.collection('products');

  const seedT0 = Date.now();
  for (let i = 1; i <= 500; i++) {
    await usersCol.insert({
      id: `usr_${i}`,
      name: `User ${i}`,
      email: `user${i}@shop.com`,
      role: i <= 10 ? 'admin' : 'customer'
    });
  }

  const INITIAL_STOCK_PER_ITEM = 30;
  for (let p = 1; p <= 50; p++) {
    await productsCol.insert({
      id: `prd_${p}`,
      sku: `SKU-${1000 + p}`,
      name: `Premium Item ${p}`,
      price: Math.floor(Math.random() * 500) + 10,
      stock: INITIAL_STOCK_PER_ITEM,
      categoryId: `cat_${(p % 5) + 1}`,
      status: 'active'
    });
  }
  console.log(`✅ Seeding done in ${Date.now() - seedT0} ms.\n`);

  // Metrics trackers
  const stats = {
    totalReadOps: 0,
    totalWriteOps: 0,
    totalTransactions: 0,
    successfulPurchases: 0,
    rejectedOutofStock: 0,
    reviewsSubmitted: 0,
    readLatencies: [],
    writeLatencies: [],
    errors: []
  };

  console.log('🚀 Launching 500 Simulated Concurrent User Sessions...');
  const CONCURRENT_USERS = 500;
  const tStart = Date.now();

  const userSimulations = Array.from({ length: CONCURRENT_USERS }, async (_, index) => {
    const userId = `usr_${index + 1}`;

    try {
      // Action 1: Read O(1)
      const tR1 = Date.now();
      const categoryId = `cat_${(index % 5) + 1}`;
      productsCol.findBy('categoryId', categoryId);
      stats.readLatencies.push(Date.now() - tR1);
      stats.totalReadOps++;

      // Action 2: Query Builder
      const tR2 = Date.now();
      productsCol
        .where({ status: 'active' })
        .sortBy('price', 'desc')
        .limit(5)
        .exec();
      stats.readLatencies.push(Date.now() - tR2);
      stats.totalReadOps++;

      // Action 3: Purchase Transaction
      const targetProductId = `prd_${(index % 15) + 1}`;
      const tTx = Date.now();
      stats.totalTransactions++;

      try {
        await db.transaction(async (tx) => {
          const txProducts = tx.collection('products');
          const txOrders   = tx.collection('orders');
          const txInvLogs  = tx.collection('inventory_logs');

          const prd = txProducts.findById(targetProductId);
          if (!prd || prd.stock < 1) {
            throw new Error('OUT_OF_STOCK');
          }

          await txProducts.update(targetProductId, { stock: prd.stock - 1 });

          const order = await txOrders.insert({
            customerId: userId,
            items: [{ productId: targetProductId, qty: 1, price: prd.price }],
            totalAmount: prd.price,
            status: 'completed'
          });

          await txInvLogs.insert({
            productId: targetProductId,
            change: -1,
            reason: 'concurrent_sale',
            orderId: order.id
          });
        });

        stats.successfulPurchases++;
        stats.writeLatencies.push(Date.now() - tTx);
        stats.totalWriteOps += 3;

      } catch (purchaseErr) {
        if (purchaseErr.message === 'OUT_OF_STOCK') {
          stats.rejectedOutofStock++;
        } else {
          stats.errors.push({ userId, action: 'purchase', error: purchaseErr.message });
        }
      }

      // Action 4: Review submission
      const tRvw = Date.now();
      const reviewsCol = db.collection('reviews');
      await reviewsCol.insert({
        productId: targetProductId,
        authorId: userId,
        rating: Math.floor(Math.random() * 5) + 1,
        comment: `User ${userId} feedback`
      });
      stats.writeLatencies.push(Date.now() - tRvw);
      stats.totalWriteOps++;
      stats.reviewsSubmitted++;

      // Action 5: Fetch reviews
      const tR3 = Date.now();
      reviewsCol.findBy('productId', targetProductId);
      stats.readLatencies.push(Date.now() - tR3);
      stats.totalReadOps++;

    } catch (sessionErr) {
      stats.errors.push({ userId, error: sessionErr.message });
    }
  });

  await Promise.all(userSimulations);
  const simulationDurationMs = Date.now() - tStart;

  console.log('🔄 Flushing WAL queue to Echo Entries backend...');
  const tFlush = Date.now();
  await db.flush();
  const flushDurationMs = Date.now() - tFlush;

  // Detailed Analysis of Stock Math
  console.log('\n🔍 DEBUG ANALYSIS OF INVENTORY & TRANSACTIONS:');
  let totalStockRemaining = 0;
  for (let p = 1; p <= 50; p++) {
    const prd = productsCol.findById(`prd_${p}`);
    totalStockRemaining += prd.stock;
  }

  const ordersCol = db.collection('orders');
  const inventoryLogsCol = db.collection('inventory_logs');
  const totalOrdersCreated = ordersCol.count();
  const totalLogsCreated = inventoryLogsCol.count();
  const totalStockSold = (50 * INITIAL_STOCK_PER_ITEM) - totalStockRemaining;

  console.log(`- Expected Stock Sold (Initial 1500 - Remaining ${totalStockRemaining}): ${totalStockSold}`);
  console.log(`- Reported Successful Purchases (stats.successfulPurchases):         ${stats.successfulPurchases}`);
  console.log(`- Total Orders Actual Count in DB:                                   ${totalOrdersCreated}`);
  console.log(`- Total Inventory Logs Actual Count in DB:                            ${totalLogsCreated}`);

  const stockMathValid = (totalStockSold === stats.successfulPurchases) && (totalOrdersCreated === stats.successfulPurchases);

  const avgReadMs = (stats.readLatencies.reduce((a, b) => a + b, 0) / stats.readLatencies.length).toFixed(3);
  const avgWriteMs = (stats.writeLatencies.reduce((a, b) => a + b, 0) / stats.writeLatencies.length).toFixed(3);

  console.log('\n================================================================');
  console.log('           500 CONCURRENT USERS STRESS TEST REPORT              ');
  console.log('================================================================');
  console.log(`👥 Concurrent Users Simulated:     ${CONCURRENT_USERS}`);
  console.log(`⏱️ Total Execution Time (RAM/WAL): ${simulationDurationMs} ms`);
  console.log(`☁️ Backend Flush Duration (EE):    ${flushDurationMs} ms`);
  console.log(`📖 Total Read Operations:          ${stats.totalReadOps} (Avg latency: ${avgReadMs} ms)`);
  console.log(`✍️ Total Write Operations:         ${stats.totalWriteOps} (Avg latency: ${avgWriteMs} ms)`);
  console.log(`🛒 Total Purchase Transactions:    ${stats.totalTransactions}`);
  console.log(`  ├── Successful Purchases:       ${stats.successfulPurchases}`);
  console.log(`  └── Rejected (Out of Stock):    ${stats.rejectedOutofStock}`);
  console.log(`📝 Reviews Submitted:              ${stats.reviewsSubmitted}`);
  console.log(`📦 Total Stock Sold:               ${totalStockSold} units`);
  console.log(`📦 Remaining Stock in Inventory:   ${totalStockRemaining} units`);
  console.log(`🧮 Inventory Math Integrity:       ${stockMathValid ? '✅ PERFECT MATCH (Zero negative stock, zero over-selling)' : '❌ DISCREPANCY DETECTED'}`);
  console.log(`🚨 Total Errors Encountered:        ${stats.errors.length}`);
  console.log('================================================================\n');

  await db.close();

  return { simulationDurationMs, flushDurationMs, stats, stockMathValid };
}

runHighConcurrencyStressTest().catch(err => {
  console.error('CRITICAL UNHANDLED ERROR IN STRESS TEST:', err);
  process.exit(1);
});
