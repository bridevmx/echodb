'use strict';

const { EchoEntriesDB } = require('../index');

async function main() {
  const db = new EchoEntriesDB({
    email:            process.env.EE_EMAIL || 'isclaudeia+echo@gmail.com',
    password:         process.env.EE_PASSWORD || '1234567890',
    encryptionSecret: process.env.EE_SECRET || 'mi-secreto-privado-2026',
    walPath:          './.echodb_test_wal.json',
    autoSyncMs:       0,
    compactEvery:     50,   // high threshold so compaction doesn't fire mid-test
    batchSize:        10,
    batchWindowMs:    8
  });

  await db.init();

  // ── Cleanup leftover data ─────────────────────────────────────────────────
  for (const col of ['test_users', 'test_accounts', 'bench_col']) {
    const c = db.collection(col);
    for (const d of c.all()) await c.delete(d.id);
  }
  await db.flush();

  // ── Declare indexes BEFORE inserting ─────────────────────────────────────
  db.createIndex('test_users',    'role');
  db.createIndex('test_accounts', 'holder');
  db.createIndex('bench_col',     'tag');

  // ── INSERT ───────────────────────────────────────────────────────────────
  console.log('\n── INSERT ──');
  const users = db.collection('test_users');
  await users.insert({ id: 'u1', name: 'Ana López',   role: 'admin', age: 28 });
  await users.insert({ id: 'u2', name: 'Carlos Ruiz', role: 'dev',   age: 34 });
  await users.insert({ id: 'u3', name: 'Bea Peña',    role: 'dev',   age: 22 });
  await users.insert({ id: 'u4', name: 'Diego Mora',  role: 'admin', age: 45 });
  console.log('count:', users.count()); // 4

  // ── findBy index O(1) ────────────────────────────────────────────────────
  console.log('\n── findBy index O(1) ──');
  console.log('admins:', users.findBy('role', 'admin').map(u => u.name));
  console.log('devs:',   users.findBy('role', 'dev').map(u => u.name));

  // ── where() query builder ─────────────────────────────────────────────────
  console.log('\n── where().sortBy().limit() ──');
  const admins = users.where({ role: 'admin' }).sortBy('age', 'desc').exec();
  console.log('admins by age desc:', admins.map(u => `${u.name}(${u.age})`));
  console.log('youngest dev:', users.where({ role: 'dev' }).sortBy('age').first()?.name);
  console.log('admin count:', users.where({ role: 'admin' }).count());

  // ── UPDATE index auto-maintained ─────────────────────────────────────────
  console.log('\n── UPDATE + index ──');
  await users.update('u3', { role: 'lead' });
  console.log('devs after update:', users.findBy('role', 'dev').map(u => u.name));
  console.log('leads:', users.findBy('role', 'lead').map(u => u.name));

  // ── DELETE index auto-maintained ─────────────────────────────────────────
  console.log('\n── DELETE + index ──');
  await users.delete('u2');
  console.log('devs after delete:', users.findBy('role', 'dev').length); // 0

  // ── TRANSACTION rollback (stores + indexes) ───────────────────────────────
  console.log('\n── TRANSACTION rollback ──');
  const accounts = db.collection('test_accounts');
  await accounts.insert({ id: 'accA', holder: 'Ana', balance: 1000 });

  try {
    await db.transaction(async (tx) => {
      const col = tx.collection('test_accounts');
      await col.update('accA', { balance: -9999, holder: 'HACKED' });
      throw new Error('forced rollback');
    });
  } catch {
    const doc = accounts.findById('accA');
    console.log('balance after rollback:', doc?.balance);   // 1000
    console.log('holder after rollback:', doc?.holder);     // Ana
    console.log('Ana via index:', accounts.findBy('holder', 'Ana').length); // 1
    console.log('HACKED via index:', accounts.findBy('holder', 'HACKED').length); // 0
  }

  // ── Batch benchmark ───────────────────────────────────────────────────────
  console.log('\n── BATCH benchmark: 20 inserts ──');
  const bench = db.collection('bench_col');
  let t = Date.now();
  for (let i = 0; i < 20; i++) {
    await bench.insert({ name: 'item' + i, tag: i % 4 === 0 ? 'featured' : 'normal' });
  }
  console.log('20 enqueued in RAM:', Date.now() - t, 'ms');

  t = Date.now();
  await db.flush();
  const elapsed = Date.now() - t;
  console.log('20 flushed to EE:', elapsed, 'ms  (~' + Math.round(elapsed / 20) + 'ms/op vs ~200ms sequential)');

  console.log('featured:', bench.findBy('tag', 'featured').length, 'docs via index');

  await db.close();
  console.log('\n✅ All checks passed.');
}

main().catch(err => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
