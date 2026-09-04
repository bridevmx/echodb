'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EchoEntriesDB } = require('../index');

const PB_ID_REGEX = /^[a-z0-9]{15}$/;

async function runPocketBaseParityTests() {
  console.log('🧪 Starting EchoDB PocketBase Parity Test Suite...\n');

  const walPath = path.resolve('./.echodb_test_pb_parity_wal.json');
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  const db = new EchoEntriesDB({
    memoryOnly: true
  });

  await db.init();

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: 15-character PocketBase IDs & Validation
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 1: PocketBase 15-character ID generation & strict validation');
  const customers = db.collection('customers');

  // Auto-generation
  const autoDoc = await customers.insert({ name: 'Auto Customer', phone: '5500000001' });
  assert.strictEqual(typeof autoDoc.id, 'string');
  assert.strictEqual(autoDoc.id.length, 15);
  assert(PB_ID_REGEX.test(autoDoc.id), `ID '${autoDoc.id}' must match ^[a-z0-9]{15}$`);

  // Manual valid ID
  const manualId = 'c8x3z2a1b9q0p12';
  const manualDoc = await customers.insert({ id: manualId, name: 'Manual Customer', phone: '5500000002' });
  assert.strictEqual(manualDoc.id, manualId);

  // Manual invalid IDs (uppercase, symbols, wrong length)
  const invalidIds = ['short', 'c8X3Z2A1B9Q0P12', 'cust_1234567890', '1234567890123456'];
  for (const invId of invalidIds) {
    try {
      await customers.insert({ id: invId, name: 'Bad ID' });
      assert.fail(`Should have rejected invalid ID '${invId}'`);
    } catch (err) {
      assert(err.message.includes('PocketBase IDs must be exactly 15 lowercase alphanumeric characters'));
    }
  }

  // Duplicate ID detection
  try {
    await customers.insert({ id: manualId, name: 'Duplicate Customer' });
    assert.fail('Should have rejected duplicate ID');
  } catch (err) {
    assert(err.message.includes(`already exists in 'customers'`));
  }

  // Immutable ID on update
  try {
    await customers.update(manualId, { id: 'c8x3z2a1b9q0p99' });
    assert.fail('Should have rejected ID change');
  } catch (err) {
    assert(err.message.includes('Cannot change document ID'));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Canonical Timestamps (created & updated) & Metadata Cleanup
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 2: Canonical timestamps (created & updated) and clean metadata');
  assert(autoDoc.created !== undefined, 'created must exist');
  assert(autoDoc.updated !== undefined, 'updated must exist');
  assert.strictEqual(autoDoc._createdAt, undefined, '_createdAt must NOT exist');
  assert.strictEqual(autoDoc._updatedAt, undefined, '_updatedAt must NOT exist');
  assert.strictEqual(autoDoc._col, undefined, '_col must NOT exist');
  assert.strictEqual(autoDoc._id, undefined, '_id must NOT exist');

  const createdBefore = autoDoc.created;
  await new Promise(r => setTimeout(r, 10)); // guarantee timestamp advance
  const updatedDoc = await customers.update(autoDoc.id, { name: 'Auto Customer Updated' });
  assert.strictEqual(updatedDoc.created, createdBefore, 'created must remain immutable on update');
  assert(updatedDoc.updated > createdBefore, 'updated must advance on update');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Unique Index Constraints & O(1) Collision Detection
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 3: Unique index constraints & rollback on violation');
  db.createIndex('customers', 'phone', { unique: true });

  // Inserting duplicate unique field throws immediately
  try {
    await customers.insert({ name: 'Phone Collision', phone: '5500000002' });
    assert.fail('Should have thrown unique constraint violation');
  } catch (err) {
    assert(err.message.includes('Unique constraint violation: field \'phone\' with value \'5500000002\' already exists'));
  }

  // Updating own document to the same phone should succeed
  await customers.update(manualId, { name: 'Manual Customer Renovated', phone: '5500000002' });

  // Updating document to another document's phone throws
  try {
    await customers.update(autoDoc.id, { phone: '5500000002' });
    assert.fail('Should have thrown unique violation on update');
  } catch (err) {
    assert(err.message.includes('Unique constraint violation'));
  }

  // Transaction rollback restores unique index cleanly
  try {
    await db.transaction(async (tx) => {
      const txCust = tx.collection('customers');
      await txCust.insert({ id: 'c9x3z2a1b9q0p99', name: 'Temporary', phone: '5599999999' });
      throw new Error('Forced transaction failure');
    });
  } catch (err) {
    assert.strictEqual(err.message, 'Forced transaction failure');
  }

  // Phone should be available again after rollback
  const reuseDoc = await customers.insert({ id: 'c9x3z2a1b9q0p99', name: 'Reused Phone', phone: '5599999999' });
  assert.strictEqual(reuseDoc.phone, '5599999999');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: PocketBase Query Methods (getOne, getFirstListItem, getFullList, getList)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 4: PocketBase SDK Query Parity (getOne, getFirstListItem, getFullList, getList)');
  
  // getOne
  const one = customers.getOne(manualId);
  assert.strictEqual(one.name, 'Manual Customer Renovated');
  assert.strictEqual(customers.getOne('nonexistent12345'), null);

  // getFirstListItem with predicate
  const itemByFn = customers.getFirstListItem(d => d.phone === '5599999999');
  assert.strictEqual(itemByFn.id, 'c9x3z2a1b9q0p99');

  // getFirstListItem with field, value
  const itemByField = customers.getFirstListItem('phone', '5500000002');
  assert.strictEqual(itemByField.id, manualId);

  // getFirstListItem with query object
  const itemByObj = customers.getFirstListItem({ phone: '5500000002' });
  assert.strictEqual(itemByObj.id, manualId);

  // getFullList
  const allList = customers.getFullList();
  assert.strictEqual(allList.length, 3);

  // getList (paginated)
  const pageResult = customers.getList(1, 2);
  assert.strictEqual(pageResult.page, 1);
  assert.strictEqual(pageResult.perPage, 2);
  assert.strictEqual(pageResult.totalItems, 3);
  assert.strictEqual(pageResult.totalPages, 2);
  assert.strictEqual(pageResult.items.length, 2);

  const page2Result = customers.getList(2, 2);
  assert.strictEqual(page2Result.page, 2);
  assert.strictEqual(page2Result.items.length, 1);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: PocketBase Sorting Syntax ('-created', 'name:desc', '+phone')
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 5: PocketBase sorting syntax (-field, +field, field:asc/desc)');
  
  const descList = customers.getFullList({ sort: '-created' });
  assert(descList[0].created >= descList[1].created);

  const ascList = customers.getFullList({ sort: '+created' });
  assert(ascList[0].created <= ascList[1].created);

  const byNameDesc = customers.getFullList({ sort: 'name:desc' });
  assert(byNameDesc[0].name >= byNameDesc[1].name);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 6: In-Memory Relation Expansion (.expand)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 6: In-memory cross-collection relation expand');
  const credits = db.collection('credits');
  const credit1 = await credits.insert({
    id: 'k1x2z3a4b5c6d7e',
    amount: 1500,
    customerId: manualId // points to customers collection
  });

  // Expand with field name (conventional customerId -> customers)
  const expandedCredit = credits.getOne(credit1.id, { expand: 'customerId' });
  assert(expandedCredit.expand !== undefined);
  assert.strictEqual(expandedCredit.expand.customerId.id, manualId);
  assert.strictEqual(expandedCredit.expand.customerId.name, 'Manual Customer Renovated');

  // Multi-relation expand with array
  const products = db.collection('products');
  const prod1 = await products.insert({ id: 'prd000000000001', name: 'Item 1' });
  const prod2 = await products.insert({ id: 'prd000000000002', name: 'Item 2' });

  const orders = db.collection('orders');
  const order1 = await orders.insert({
    id: 'ord000000000001',
    customerId: manualId,
    productIds: [prod1.id, prod2.id]
  });

  const expandedOrder = orders.getOne(order1.id, { expand: ['customerId', 'productIds'] });
  assert.strictEqual(expandedOrder.expand.customerId.id, manualId);
  assert.strictEqual(expandedOrder.expand.productIds.length, 2);
  assert.strictEqual(expandedOrder.expand.productIds[0].name, 'Item 1');
  assert.strictEqual(expandedOrder.expand.productIds[1].name, 'Item 2');

  // Explicit collection map expand
  const explicitExpand = credits.getOne(credit1.id, { expand: { customerId: 'customers' } });
  assert.strictEqual(explicitExpand.expand.customerId.id, manualId);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 7: Lightweight Schema Contracts & SQLite Zero-Values Coercion
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 7: Schema contracts & zero-values coercion');
  db.defineSchema('members', {
    name:   { type: 'text', required: true },
    email:  { type: 'email', required: true, unique: true },
    points: { type: 'number', default: 0 },
    active: { type: 'bool', default: true },
    notes:  { type: 'text' },
    tier:   { type: 'select', options: ['BRONZE', 'SILVER', 'GOLD'], default: 'BRONZE' }
  });

  const members = db.collection('members');

  // Coercion on insert: points -> 0, active -> true, notes -> "", tier -> 'BRONZE'
  const member = await members.insert({
    name: 'Roberto Gómez',
    email: 'roberto@example.com'
  });

  assert.strictEqual(member.points, 0, 'number should default to 0');
  assert.strictEqual(member.active, true, 'bool should default to true');
  assert.strictEqual(member.notes, '', 'text should coerce to empty string');
  assert.strictEqual(member.tier, 'BRONZE', 'select should take default');

  // Missing required field throws validation error
  try {
    await members.insert({ email: 'noname@example.com' });
    assert.fail('Should have rejected missing name');
  } catch (err) {
    assert(err.message.includes('field \'name\' is required'));
  }

  // Invalid select option throws validation error
  try {
    await members.insert({ name: 'Ana', email: 'ana@example.com', tier: 'PLATINUM' });
    assert.fail('Should have rejected invalid tier');
  } catch (err) {
    assert(err.message.includes('is not a valid option for \'tier\''));
  }

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 8: PocketBase Migration Generator (pb_migrations)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 8: PocketBase v0.23+ JS migration file generator');
  const migrationScript = db.generatePocketBaseMigration();
  assert(migrationScript.includes('migrate((app) => {'), 'Must have migrate function');
  assert(migrationScript.includes('name: "members"'), 'Must include members collection');
  assert(migrationScript.includes('"name":"points"') && migrationScript.includes('"type":"number"'), 'Must include typed points field');
  assert(migrationScript.includes('CREATE UNIQUE INDEX `idx_members_email`'), 'Must include unique email index');
  assert(migrationScript.includes('app.save(members);'), 'Must save collection');
  assert(migrationScript.includes('app.delete(collection);'), 'Must have rollback');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 9: PocketBase Batch Export (POST /api/batch)
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 9: exportPocketBaseBatch() payloads for POST /api/batch');
  const batches = db.exportPocketBaseBatch({ batchSize: 2 });
  assert(Array.isArray(batches), 'Batches must be an array');
  assert(batches.length > 0, 'Must have at least one batch');
  assert(batches[0].requests !== undefined, 'Batch must have requests array');
  assert(batches[0].requests.length <= 2, 'Batch size must respect limit');

  const firstReq = batches[0].requests[0];
  assert.strictEqual(firstReq.action, 'create');
  assert(typeof firstReq.collection === 'string');
  assert(firstReq.body.id !== undefined, 'Body must have id');
  assert(firstReq.body.created !== undefined, 'Body must have created');
  assert(firstReq.body.updated !== undefined, 'Body must have updated');
  assert.strictEqual(firstReq.body._v, undefined, 'Body must NOT have internal _v');
  assert.strictEqual(firstReq.body._eeId, undefined, 'Body must NOT have internal _eeId');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 10: create() canonical method — alias of insert(), supports expand & fields
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 10: create() canonical method with expand and fields options');
  const t10refs = db.collection('t10refs');
  const t10items = db.collection('t10items');

  const refDoc10 = await t10refs.insert({ label: 'Ref-A' });

  // create() without options behaves identically to insert()
  const created = await t10items.create({ name: 'Widget', refId: refDoc10.id, price: 99 });
  assert(PB_ID_REGEX.test(created.id), 'create() must assign valid 15-char ID');
  assert.strictEqual(created.name, 'Widget');
  assert(created.created, 'create() must set created timestamp');

  // create() with fields projection
  const projected = await t10items.create(
    { name: 'Gadget', refId: refDoc10.id, price: 49 },
    { fields: 'id,name' }
  );
  assert.strictEqual(projected.name, 'Gadget');
  assert(projected.id, 'id must be present in projection');
  assert.strictEqual(projected.price, undefined, 'price must be excluded by fields projection');
  assert.strictEqual(projected.created, undefined, 'created must be excluded by fields projection');

  // create() with expand option — explicit collection map avoids auto-naming guessing
  const withExpand = await t10items.create(
    { name: 'Thingamajig', refId: refDoc10.id, price: 19 },
    { expand: { refId: 't10refs' } }
  );
  assert(withExpand.expand, 'create() with expand must set expand key');
  assert.strictEqual(withExpand.expand.refId.label, 'Ref-A', 'expand must resolve relation');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 11: update() with expand and fields options
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 11: update() with expand and fields options');
  const t11products = db.collection('t11products');
  const p1 = await t11products.insert({ title: 'Old Title', stock: 10, categoryId: refDoc10.id });

  // update() with fields projection
  const upProjected = await t11products.update(p1.id, { stock: 20 }, { fields: 'id,stock' });
  assert.strictEqual(upProjected.stock, 20);
  assert.strictEqual(upProjected.id, p1.id);
  assert.strictEqual(upProjected.title, undefined, 'title must be excluded by fields');

  // update() with explicit expand map
  const upExpanded = await t11products.update(p1.id, { stock: 30 }, { expand: { categoryId: 't10refs' } });
  assert.strictEqual(upExpanded.stock, 30);
  assert(upExpanded.expand, 'updated doc must have expand key');
  assert.strictEqual(upExpanded.expand.categoryId.label, 'Ref-A', 'expand must resolve relation after update');

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 12: fields projection on getOne, getFirstListItem, getFullList, getList
  // ───────────────────────────────────────────────────────────────────────────
  console.log('✔ Test 12: fields projection on all getXxx query methods');
  const t12col = db.collection('t12_records');
  await t12col.insert({ title: 'Alpha', score: 100, active: true });
  await t12col.insert({ title: 'Beta',  score: 200, active: false });
  await t12col.insert({ title: 'Gamma', score: 300, active: true });

  // getOne with fields
  const r12 = await t12col.insert({ title: 'Delta', score: 400, active: true });
  const oneProjected = t12col.getOne(r12.id, { fields: 'id,title' });
  assert.strictEqual(oneProjected.title, 'Delta');
  assert.strictEqual(oneProjected.score, undefined, 'score must be excluded');
  assert.strictEqual(oneProjected.created, undefined, 'created must be excluded');

  // getFirstListItem with fields
  const firstProjected = t12col.getFirstListItem(d => d.title === 'Alpha', { fields: 'id,score' });
  assert.strictEqual(firstProjected.score, 100);
  assert.strictEqual(firstProjected.title, undefined, 'title must be excluded');

  // getFullList with fields
  const fullProjected = t12col.getFullList({ fields: 'id,title,score' });
  for (const doc of fullProjected) {
    assert(doc.id, 'id must be present');
    assert(doc.title !== undefined, 'title must be present');
    assert.strictEqual(doc.active, undefined, 'active must be excluded');
    assert.strictEqual(doc.created, undefined, 'created must be excluded');
  }

  // getList with fields and skipTotal
  const listProjected = t12col.getList(1, 2, { fields: 'id,score', skipTotal: true });
  assert.strictEqual(listProjected.totalItems, -1, 'skipTotal must set totalItems to -1');
  assert.strictEqual(listProjected.totalPages, -1, 'skipTotal must set totalPages to -1');
  assert.strictEqual(listProjected.items.length, 2);
  for (const doc of listProjected.items) {
    assert(doc.score !== undefined, 'score must be present');
    assert.strictEqual(doc.title, undefined, 'title must be excluded');
  }

  // getList without skipTotal — normal pagination
  const listNormal = t12col.getList(1, 2, { sort: '-score' });
  assert(listNormal.totalItems > 0, 'totalItems must be computed');
  assert(listNormal.totalPages > 0, 'totalPages must be computed');
  assert.strictEqual(listNormal.items[0].score, 400, 'First item must be highest score');

  // ───────────────────────────────────────────────────────────────────────────
  // Clean shutdown
  await db.close();
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  console.log('\n🎉 ALL POCKETBASE PARITY TESTS PASSED SUCCESSFULLY!\n');
}

runPocketBaseParityTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
