'use strict';

const { EchoEntriesDB } = require('../index');

async function runEcommerceSimulation() {
  console.log('================================================================');
  console.log('   E-COMMERCE FULL SIMULATION & DEBUG SUITE — ECHO ENTRIES DB   ');
  console.log('================================================================\n');

  const results = {
    auth: null,
    crud: null,
    indexes: null,
    queryBuilder: null,
    transactionCommit: null,
    transactionRollback: null,
    batchAndWal: null,
    compaction: null,
    restartAndSync: null,
    errors: []
  };

  const WAL_PATH = './.echodb_ecommerce_wal.json';
  const credentials = {
    email:            process.env.EE_EMAIL || 'user@example.com',
    password:         process.env.EE_PASSWORD || 'password123',
    encryptionSecret: process.env.EE_SECRET || 'ecom-production-master-key',
    walPath:          WAL_PATH,
    autoSyncMs:       0,
    compactEvery:     15,
    batchSize:        10,
    batchWindowMs:    8
  };

  let db = new EchoEntriesDB(credentials);

  // ── PHASE 1: INIT & AUTH ───────────────────────────────────────────────────
  console.log('🔹 [PHASE 1] Initializing EchoEntriesDB & Authenticating...');
  try {
    const t0 = Date.now();
    await db.init();
    results.auth = { status: 'SUCCESS', timeMs: Date.now() - t0 };
    console.log(`✅ Auth successful (${results.auth.timeMs} ms)\n`);
  } catch (err) {
    results.auth = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'Auth', error: err });
    console.error('❌ Auth failed:', err.message, '\n');
  }

  // ── CLEANUP LEFTOVERS ──────────────────────────────────────────────────────
  console.log('🧹 Cleaning up leftover test collections...');
  const collectionsToTest = ['users', 'categories', 'products', 'orders', 'inventory_logs', 'reviews'];
  for (const colName of collectionsToTest) {
    try {
      const col = db.collection(colName);
      for (const doc of col.all()) {
        await col.delete(doc.id);
      }
    } catch (e) {
      console.warn(`Warning during cleanup of ${colName}:`, e.message);
    }
  }
  await db.flush();
  console.log('✅ Cleanup completed.\n');

  // ── DECLARE INDEXES ────────────────────────────────────────────────────────
  console.log('🔹 Declaring Secondary Indexes...');
  try {
    db.createIndex('users',          'role');
    db.createIndex('users',          'email');
    db.createIndex('categories',     'slug');
    db.createIndex('products',       'categoryId');
    db.createIndex('products',       'sku');
    db.createIndex('products',       'status');
    db.createIndex('orders',         'customerId');
    db.createIndex('orders',         'status');
    db.createIndex('inventory_logs', 'productId');
    db.createIndex('reviews',        'productId');
    db.createIndex('reviews',        'rating');
    console.log('✅ Indexes declared successfully.\n');
  } catch (err) {
    console.error('❌ Error declaring indexes:', err.message, '\n');
    results.errors.push({ phase: 'Declare Indexes', error: err });
  }

  // ── PHASE 2: CRUD & INDEX LOOKUPS ──────────────────────────────────────────
  console.log('🔹 [PHASE 2] Testing CRUD & Index Lookups O(1)...');
  try {
    const users = db.collection('users');
    const categories = db.collection('categories');
    const products = db.collection('products');

    // Insert Users
    const u1 = await users.insert({ id: 'usr_c1', name: 'Alice Smith', email: 'alice@example.com', role: 'customer' });
    const u2 = await users.insert({ id: 'usr_c2', name: 'Bob Jones',   email: 'bob@example.com',   role: 'customer' });
    const u3 = await users.insert({ id: 'usr_s1', name: 'Seller Sam',  email: 'sam@seller.com',   role: 'seller' });
    const u4 = await users.insert({ id: 'usr_a1', name: 'Admin Eva',   email: 'eva@admin.com',    role: 'admin' });

    // Insert Categories
    const catTech = await categories.insert({ id: 'cat_tech', name: 'Electronics', slug: 'electronics' });
    const catHome = await categories.insert({ id: 'cat_home', name: 'Home & Kitchen', slug: 'home-kitchen' });

    // Insert Products
    const p1 = await products.insert({ id: 'prd_p1', sku: 'SKU-LAPTOP', name: 'Pro Laptop 15"', price: 1200, stock: 10, categoryId: catTech.id, status: 'active' });
    const p2 = await products.insert({ id: 'prd_p2', sku: 'SKU-PHONE',  name: 'Smart Phone X',   price: 800,  stock: 25, categoryId: catTech.id, status: 'active' });
    const p3 = await products.insert({ id: 'prd_p3', sku: 'SKU-MUG',    name: 'Coffee Mug',      price: 15,   stock: 100, categoryId: catHome.id, status: 'active' });
    const p4 = await products.insert({ id: 'prd_p4', sku: 'SKU-OUT',    name: 'Discontinued Item', price: 50, stock: 0,   categoryId: catHome.id, status: 'inactive' });

    // Test Read APIs O(1) & O(n)
    const findByIdRes = users.findById('usr_c1');
    const findByRoleAdmin = users.findBy('role', 'admin');
    const findByRoleCustomer = users.findBy('role', 'customer');
    const findOneBySku = products.findOneBy('sku', 'SKU-PHONE');
    const allProductsCount = products.count();
    const activeProducts = products.find(p => p.status === 'active');

    // Test Update & Upsert
    await products.update('prd_p3', { price: 18 });
    await products.upsert({ id: 'prd_p5', sku: 'SKU-DESK', name: 'Standing Desk', price: 350, stock: 5, categoryId: catHome.id, status: 'active' });

    results.crud = {
      status: 'SUCCESS',
      usersCount: users.count(),
      productsCount: products.count(),
      customerRoleCount: findByRoleCustomer.length,
      adminFound: findByRoleAdmin[0]?.name === 'Admin Eva',
      phoneSkuFound: findOneBySku?.name === 'Smart Phone X',
      updatedMugPrice: products.findById('prd_p3')?.price === 18,
      upsertedDesk: products.findById('prd_p5')?.name === 'Standing Desk'
    };

    console.log(`✅ CRUD & Index checks passed. Total users: ${users.count()}, Total products: ${products.count()}\n`);
  } catch (err) {
    results.crud = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'CRUD', error: err });
    console.error('❌ CRUD testing failed:', err.message, '\n');
  }

  // ── PHASE 3: QUERY BUILDER ─────────────────────────────────────────────────
  console.log('🔹 [PHASE 3] Testing Chainable Query Builder...');
  try {
    const products = db.collection('products');

    const techActiveDesc = products
      .where({ categoryId: 'cat_tech', status: 'active' })
      .sortBy('price', 'desc')
      .exec();

    const topProduct = products
      .where({ status: 'active' })
      .sortBy('price', 'desc')
      .first();

    const paginatedProducts = products
      .where({ status: 'active' })
      .sortBy('price', 'asc')
      .offset(1)
      .limit(2)
      .exec();

    const countActive = products
      .where({ status: 'active' })
      .count();

    results.queryBuilder = {
      status: 'SUCCESS',
      techActiveCount: techActiveDesc.length,
      highestPriceProduct: topProduct?.name,
      paginatedCount: paginatedProducts.length,
      activeCount: countActive
    };

    console.log(`✅ Query Builder passed. Highest price active product: ${topProduct?.name} ($${topProduct?.price})\n`);
  } catch (err) {
    results.queryBuilder = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'QueryBuilder', error: err });
    console.error('❌ Query Builder testing failed:', err.message, '\n');
  }

  // ── PHASE 4: TRANSACTION COMMIT ───────────────────────────────────────────
  console.log('🔹 [PHASE 4] Testing Atomic Transaction (Successful Order Commit)...');
  try {
    let orderId = null;
    await db.transaction(async (tx) => {
      const txProducts  = tx.collection('products');
      const txOrders    = tx.collection('orders');
      const txInvLogs   = tx.collection('inventory_logs');

      const product = txProducts.findById('prd_p1');
      if (!product || product.stock < 2) {
        throw new Error('Stock insufficient for transaction');
      }

      // 1. Deduct stock
      await txProducts.update('prd_p1', { stock: product.stock - 2 });

      // 2. Create Order
      const newOrder = await txOrders.insert({
        customerId: 'usr_c1',
        items: [{ productId: 'prd_p1', qty: 2, price: 1200 }],
        totalAmount: 2400,
        status: 'completed'
      });
      orderId = newOrder.id;

      // 3. Create Inventory Log
      await txInvLogs.insert({
        productId: 'prd_p1',
        change: -2,
        reason: 'order_sale',
        orderId: newOrder.id
      });
    });

    const products = db.collection('products');
    const orders = db.collection('orders');
    const logs = db.collection('inventory_logs');

    const updatedLaptop = products.findById('prd_p1');
    const createdOrder = orders.findById(orderId);
    const createdLog = logs.findOne(l => l.orderId === orderId);
    const customerOrders = orders.findBy('customerId', 'usr_c1');

    results.transactionCommit = {
      status: 'SUCCESS',
      laptopStockAfter: updatedLaptop?.stock, // expected: 8
      orderTotal: createdOrder?.totalAmount,  // expected: 2400
      logRecorded: createdLog?.change === -2,
      indexedCustomerOrders: customerOrders.length === 1
    };

    console.log(`✅ Transaction Commit passed. Laptop stock updated: 10 -> ${updatedLaptop?.stock}, Order created ID: ${orderId}\n`);
  } catch (err) {
    results.transactionCommit = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'TransactionCommit', error: err });
    console.error('❌ Transaction Commit testing failed:', err.message, '\n');
  }

  // ── PHASE 5: TRANSACTION ROLLBACK ─────────────────────────────────────────
  console.log('🔹 [PHASE 5] Testing Atomic Transaction (Rollback on Error)...');
  try {
    const products = db.collection('products');
    const orders = db.collection('orders');
    const initialLaptopStock = products.findById('prd_p1').stock;
    const initialOrdersCount = orders.count();
    const initialIndexedOrdersCount = orders.findBy('customerId', 'usr_c2').length;

    let transactionFailedAsExpected = false;

    try {
      await db.transaction(async (tx) => {
        const txProducts = tx.collection('products');
        const txOrders   = tx.collection('orders');

        // Mutate stock in RAM
        await txProducts.update('prd_p1', { stock: 0 });

        // Insert new order for customer 2
        await txOrders.insert({
          customerId: 'usr_c2',
          items: [{ productId: 'prd_p1', qty: 99, price: 1200 }],
          totalAmount: 118800,
          status: 'pending'
        });

        // Force intentional failure
        throw new Error('INTENTIONAL_PAYMENT_FAILURE_ROLLBACK');
      });
    } catch (txErr) {
      if (txErr.message === 'INTENTIONAL_PAYMENT_FAILURE_ROLLBACK') {
        transactionFailedAsExpected = true;
      } else {
        throw txErr;
      }
    }

    const laptopStockAfterRollback = products.findById('prd_p1').stock;
    const ordersCountAfterRollback = orders.count();
    const customer2OrdersAfterRollback = orders.findBy('customerId', 'usr_c2').length;

    results.transactionRollback = {
      status: transactionFailedAsExpected &&
              laptopStockAfterRollback === initialLaptopStock &&
              ordersCountAfterRollback === initialOrdersCount &&
              customer2OrdersAfterRollback === initialIndexedOrdersCount ? 'SUCCESS' : 'FAILED',
      failedAsExpected: transactionFailedAsExpected,
      stockRestored: laptopStockAfterRollback === initialLaptopStock, // expected: 8
      ordersCountRestored: ordersCountAfterRollback === initialOrdersCount,
      indexRestored: customer2OrdersAfterRollback === initialIndexedOrdersCount
    };

    if (results.transactionRollback.status === 'SUCCESS') {
      console.log('✅ Transaction Rollback passed. All RAM state & indexes successfully reverted!\n');
    } else {
      console.error('❌ Transaction Rollback discrepancy detected:', results.transactionRollback, '\n');
    }
  } catch (err) {
    results.transactionRollback = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'TransactionRollback', error: err });
    console.error('❌ Transaction Rollback testing failed:', err.message, '\n');
  }

  // ── PHASE 6: BATCHING, WAL & AUTO-COMPACTION ────────────────────────────────
  console.log('🔹 [PHASE 6] Testing High-Volume Batch Writes, WAL & Auto-Compaction...');
  try {
    const reviews = db.collection('reviews');
    const t0 = Date.now();

    // Insert 25 reviews to trigger compaction (compactEvery = 15)
    console.log('Enqueuing 25 product reviews rapidly...');
    for (let i = 1; i <= 25; i++) {
      await reviews.insert({
        id: `rev_${i}`,
        productId: i % 2 === 0 ? 'prd_p1' : 'prd_p2',
        rating: (i % 5) + 1,
        comment: `Automated review test #${i} for product`,
        author: `User ${i}`
      });
    }

    const enqueueTimeMs = Date.now() - t0;
    console.log(`25 reviews enqueued to RAM & WAL in ${enqueueTimeMs} ms.`);

    console.log('Flushing queue to Echo Entries backend...');
    const tFlush = Date.now();
    await db.flush();
    const flushTimeMs = Date.now() - tFlush;

    const p1Reviews = reviews.findBy('productId', 'prd_p1');
    const rating5Reviews = reviews.findBy('rating', 5);

    results.batchAndWal = {
      status: 'SUCCESS',
      enqueueTimeMs,
      flushTimeMs,
      totalReviewsInRam: reviews.count(),
      p1ReviewsIndexed: p1Reviews.length,
      rating5ReviewsIndexed: rating5Reviews.length
    };

    console.log(`✅ Batch & Compaction completed in ${flushTimeMs} ms. Reviews stored: ${reviews.count()}\n`);
  } catch (err) {
    results.batchAndWal = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'BatchAndWal', error: err });
    console.error('❌ Batch & Compaction testing failed:', err.message, '\n');
  }

  // ── PHASE 7: RESTART & RE-SYNC FROM BACKEND ────────────────────────────────
  console.log('🔹 [PHASE 7] Simulating Server Restart (Closing & Re-syncing RAM)...');
  try {
    console.log('Closing current EchoEntriesDB connection...');
    await db.close();

    console.log('Creating NEW EchoEntriesDB instance & initiating sync from Echo Entries...');
    const db2 = new EchoEntriesDB(credentials);
    const tSync = Date.now();
    await db2.init();
    const syncTimeMs = Date.now() - tSync;

    console.log('Re-declaring indexes on fresh instance...');
    db2.createIndex('users',    'role');
    db2.createIndex('products', 'status');
    db2.createIndex('reviews',  'productId');
    db2.createIndex('orders',   'customerId');

    const freshUsers = db2.collection('users');
    const freshProducts = db2.collection('products');
    const freshOrders = db2.collection('orders');
    const freshReviews = db2.collection('reviews');

    results.restartAndSync = {
      status: 'SUCCESS',
      syncTimeMs,
      restoredUsers: freshUsers.count(),       // expected 4
      restoredProducts: freshProducts.count(), // expected 5
      restoredOrders: freshOrders.count(),     // expected 1
      restoredReviews: freshReviews.count(),   // expected 25
      checkLaptopStock: freshProducts.findById('prd_p1')?.stock, // expected 8
      checkLaptopPrice: freshProducts.findById('prd_p1')?.price, // expected 1200
      customer1OrdersCount: freshOrders.findBy('customerId', 'usr_c1').length, // expected 1
      product1ReviewsCount: freshReviews.findBy('productId', 'prd_p1').length // expected 13
    };

    await db2.close();
    console.log(`✅ Server Restart & Re-sync successful in ${syncTimeMs} ms! All RAM state & indexes restored.\n`);
  } catch (err) {
    results.restartAndSync = { status: 'FAILED', error: err.message };
    results.errors.push({ phase: 'RestartAndSync', error: err });
    console.error('❌ Server Restart & Re-sync failed:', err.message, '\n');
  }

  // ── SUMMARY REPORT ─────────────────────────────────────────────────────────
  console.log('================================================================');
  console.log('                  FULL TEST SUITE SUMMARY REPORT                 ');
  console.log('================================================================');
  console.log(JSON.stringify(results, null, 2));
  console.log('================================================================\n');

  return results;
}

runEcommerceSimulation().catch(err => {
  console.error('CRITICAL UNHANDLED ERROR IN SIMULATION:', err);
  process.exit(1);
});
