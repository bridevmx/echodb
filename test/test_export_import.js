'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EchoEntriesDB } = require('../index');

async function runTests() {
  console.log('🧪 Starting EchoDB Export & Import Test Suite...\n');

  const walPath = path.resolve('./.echodb_test_export_import_wal.json');
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  const db = new EchoEntriesDB({
    email:            'test@example.com',
    password:         'test-pass-1234',
    encryptionSecret: 'test-secret-2026',
    walPath,
    autoSyncMs:       0
  });

  // Mock HTTP requests so tests run completely offline, fast and reliably
  let eeIdCounter = 1;
  db._http.login = async () => ({ user: { id: 'mock_user_123' }, session: { token: 'mock_token' } });
  db._http.request = async (method, path, body) => ({
    data: [{ id: `ee_row_${eeIdCounter++}`, ...body }]
  });
  db._fetchAllRows = async () => [];

  await db.init();

  // 1. Setup collections and test data
  const users = db.collection('users');
  const products = db.collection('products');

  await users.clear();
  await products.clear();

  db.createIndex('users', 'email');
  db.createIndex('products', 'category');

  await users.insert({ id: 'u1', name: 'Alice', email: 'alice@test.com', role: 'admin' });
  await users.insert({ id: 'u2', name: 'Bob',   email: 'bob@test.com',   role: 'dev' });

  await products.insert({ id: 'p1', title: 'Laptop', category: 'electronics', price: 999 });
  await products.insert({ id: 'p2', title: 'Desk',   category: 'furniture',   price: 250 });

  // ── Test 1: Collection.exportJSON() ─────────────────────────────────────────
  console.log('✔ Test 1: Collection.exportJSON() (string & object modes)');
  const colJsonStr = users.exportJSON({ pretty: true });
  assert.strictEqual(typeof colJsonStr, 'string');
  const colParsed = JSON.parse(colJsonStr);
  assert.strictEqual(colParsed.collection, 'users');
  assert.strictEqual(colParsed.count, 2);
  assert.strictEqual(colParsed.documents.length, 2);
  assert.strictEqual(colParsed.documents[0]._col, 'users');

  const colObj = users.exportJSON({ stringify: false, excludeMeta: true });
  assert.strictEqual(typeof colObj, 'object');
  assert.strictEqual(colObj.documents[0].name, 'Alice');
  assert.strictEqual(colObj.documents[0]._col, undefined); // metadata stripped
  assert.strictEqual(colObj.documents[0]._v, undefined);

  // ── Test 2: Database.exportJSON() ───────────────────────────────────────────
  console.log('✔ Test 2: Database.exportJSON() (multi-collection & filter)');
  const dbJsonStr = db.exportJSON({ pretty: true });
  const dbParsed = JSON.parse(dbJsonStr);
  assert.strictEqual(dbParsed.version, 1);
  assert(dbParsed.collections.users !== undefined);
  assert(dbParsed.collections.products !== undefined);
  assert.strictEqual(dbParsed.collections.users.length, 2);
  assert.strictEqual(dbParsed.collections.products.length, 2);

  const filteredExport = db.exportJSON({ collections: ['products'], stringify: false });
  assert.strictEqual(filteredExport.collections.users, undefined);
  assert.strictEqual(filteredExport.collections.products.length, 2);

  // ── Test 3: Collection.clear() ──────────────────────────────────────────────
  console.log('✔ Test 3: Collection.clear()');
  const deletedCount = await users.clear();
  assert.strictEqual(deletedCount, 2);
  assert.strictEqual(users.count(), 0);
  assert.strictEqual(users.findBy('email', 'alice@test.com').length, 0); // index updated

  // ── Test 4: Collection.importJSON() ─────────────────────────────────────────
  console.log('✔ Test 4: Collection.importJSON() (upsert & overwrite)');
  const importResult = await users.importJSON(colJsonStr);
  assert.strictEqual(importResult.imported, 2);
  assert.strictEqual(users.count(), 2);
  assert.strictEqual(users.findBy('email', 'alice@test.com').length, 1); // index rebuilt

  // Test overwrite mode
  await users.importJSON([
    { id: 'u3', name: 'Charlie', email: 'charlie@test.com', role: 'qa' }
  ], { mode: 'overwrite' });
  assert.strictEqual(users.count(), 1);
  assert.strictEqual(users.findById('u1'), null);
  assert.strictEqual(users.findById('u3')?.name, 'Charlie');
  assert.strictEqual(users.findBy('email', 'charlie@test.com').length, 1);

  // ── Test 5: Database.importJSON() atomic import ─────────────────────────────
  console.log('✔ Test 5: Database.importJSON() multi-collection import');
  const dumpToImport = {
    collections: {
      users: [
        { id: 'u1', name: 'Alice', email: 'alice@test.com', role: 'admin' },
        { id: 'u2', name: 'Bob',   email: 'bob@test.com',   role: 'dev' }
      ],
      products: [
        { id: 'p3', title: 'Mouse', category: 'electronics', price: 29 }
      ]
    }
  };

  const dbImportResult = await db.importJSON(dumpToImport, { mode: 'upsert' });
  assert.strictEqual(dbImportResult.imported.users, 2);
  assert.strictEqual(dbImportResult.imported.products, 1);
  assert.strictEqual(dbImportResult.total, 3);

  assert.strictEqual(users.count(), 3); // Charlie + Alice + Bob
  assert.strictEqual(products.count(), 3); // Laptop + Desk + Mouse
  assert.strictEqual(products.findBy('category', 'electronics').length, 2); // Laptop + Mouse

  // ── Test 6: Database.importJSON() atomic rollback on error ──────────────────
  console.log('✔ Test 6: Database.importJSON() atomic rollback on duplicate in insert mode');
  try {
    await db.importJSON({
      collections: {
        users: [
          { id: 'u99', name: 'Zoe', email: 'zoe@test.com', role: 'dev' }
        ],
        products: [
          { id: 'p1', title: 'Duplicate Laptop', category: 'electronics' } // duplicate key error!
        ]
      }
    }, { mode: 'insert' });
    assert.fail('Should have thrown duplicate error');
  } catch (err) {
    // Verify Zoe was NOT inserted due to transaction rollback
    assert.strictEqual(users.findById('u99'), null);
    assert.strictEqual(users.findBy('email', 'zoe@test.com').length, 0);
  }

  // Cleanup
  console.log('Cleaning up collections...');
  await users.clear();
  await products.clear();
  console.log('Closing db...');
  await db.close();
  console.log('DB closed.');

  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  console.log('\n🎉 ALL EXPORT & IMPORT TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
