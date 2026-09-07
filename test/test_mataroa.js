'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EchoEntriesDB, MataroaClient, Collection } = require('../index');

async function runTests() {
  console.log('🧪 Starting Mataroa Provider & Dual-Host Test Suite...\n');

  const walPath = path.resolve('./.echodb_test_mataroa_wal.json');
  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);

  // ─── Test 1: MataroaClient Trailing Slash & Request Handling ───────────────
  console.log('✔ Test 1: MataroaClient endpoint formatting & request normalization');
  const client = new MataroaClient({ apiKey: 'test-api-key-123' });
  assert.strictEqual(client.apiKey, 'test-api-key-123');

  let interceptedUrl = null;
  let interceptedHeaders = null;
  let interceptedBody = null;

  client._fetchWithRetry = async (url, opts) => {
    interceptedUrl = url;
    interceptedHeaders = opts.headers;
    interceptedBody = opts.body ? JSON.parse(opts.body) : null;
    return { data: { ok: true, slug: 'test-slug' }, status: 200 };
  };

  // Endpoint without leading or trailing slash
  await client.request('POST', 'pages', { title: 'Test Title' });
  assert.strictEqual(interceptedUrl, 'https://mataroa.blog/api/pages/');
  assert.strictEqual(interceptedHeaders['Authorization'], 'Bearer test-api-key-123');
  assert.strictEqual(interceptedBody.title, 'Test Title');

  // Endpoint with leading and trailing slash
  await client.request('GET', '/pages/my-slug/');
  assert.strictEqual(interceptedUrl, 'https://mataroa.blog/api/pages/my-slug/');

  // ─── Test 2: MataroaClient.fetchApiKeyFromDocs Parser ──────────────────────
  console.log('✔ Test 2: MataroaClient.fetchApiKeyFromDocs extraction from HTML');
  const mockDocsHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <h2>API Base Endpoint</h2>
        <code>https://mataroa.blog/api/</code>
        <h2>API Key</h2>
        <code>99887766aabbccddeeff001122334455</code>
      </body>
    </html>
  `;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url.includes('/api/docs/')) {
      return {
        ok: true,
        status: 200,
        text: async () => mockDocsHtml,
        headers: new Headers()
      };
    }
    return originalFetch(url);
  };

  const extractedKey = await MataroaClient.fetchApiKeyFromDocs('mock-session-id', 'mock-csrf');
  assert.strictEqual(extractedKey, '99887766aabbccddeeff001122334455');
  globalThis.fetch = originalFetch;

  // ─── Test 3: Dual-Host Initialization & Dual-Write ────────────────────────
  console.log('✔ Test 3: Dual-write to Mataroa (Primary) and Echo Entries (Backup)');

  const mataroaPages = new Map(); // slug -> page
  const echoEntriesRows = [];     // EE journal_entries rows

  const db = new EchoEntriesDB({
    apiKey:           'mataroa-key-abc',
    email:            'dual@example.com',
    password:         'secure-password-123',
    encryptionSecret: 'secret-dual-2026',
    walPath,
    autoSyncMs:       0,
    batchWindowMs:    1
  });

  // Mock Mataroa client API
  db._mataroaClient.createPage = async (page) => {
    mataroaPages.set(page.slug, { ...page });
    return { ok: true, slug: page.slug };
  };
  db._mataroaClient.listPages = async () => [...mataroaPages.values()];
  db._mataroaClient.updatePage = async (slug, patch) => {
    const existing = mataroaPages.get(slug) || {};
    mataroaPages.set(slug, { ...existing, ...patch });
    return { ok: true, slug };
  };
  db._mataroaClient.deletePage = async (slug) => {
    mataroaPages.delete(slug);
    return { ok: true };
  };

  // Mock Echo Entries HTTP client
  let eeRowCounter = 1;
  db._http.login = async () => ({ user: { id: 'mock_ee_user_456' }, session: { token: 'mock_ee_token' } });
  db._http.request = async (method, path, body) => {
    if (method === 'POST') {
      const rows = (Array.isArray(body) ? body : [body]).map(b => ({
        id: `ee_row_${eeRowCounter++}`,
        ...b
      }));
      echoEntriesRows.push(...rows);
      return { data: rows };
    }
    return { data: [] };
  };
  db._fetchAllRows = async () => echoEntriesRows;

  await db.init();

  const users = db.collection('users');
  db.createIndex('users', 'email', { unique: true });

  const u1 = await users.create({ name: 'Primary Alice', email: 'alice@dual.com' });
  const u2 = await users.create({ name: 'Primary Bob', email: 'bob@dual.com' });

  await db.flush();

  // Verify memory-first reads
  assert.strictEqual(users.findById(u1.id).name, 'Primary Alice');
  assert.strictEqual(users.findById(u2.id).name, 'Primary Bob');
  assert.strictEqual(users.findOneBy('email', 'alice@dual.com').id, u1.id);

  // Verify Mataroa (Primary) received the hidden ops
  const mataroaOpPages = [...mataroaPages.values()].filter(p => p.slug.startsWith('echodb-op-'));
  assert.strictEqual(mataroaOpPages.length, 2);
  assert.strictEqual(mataroaOpPages[0].is_hidden, true);

  // Verify Echo Entries (Backup) also received the entries
  assert.strictEqual(echoEntriesRows.length, 2);
  assert.strictEqual(echoEntriesRows[0].user_id, 'mock_ee_user_456');

  // ─── Test 4: Dual-Compaction ──────────────────────────────────────────────
  console.log('✔ Test 4: Dual-compaction on Mataroa and Echo Entries');

  await db._compact('users');

  // Mataroa should now have 1 snapshot page and 0 op pages
  const mataroaSnaps = [...mataroaPages.values()].filter(p => p.slug.startsWith('echodb-snap-'));
  const remainingMataroaOps = [...mataroaPages.values()].filter(p => p.slug.startsWith('echodb-op-'));
  assert.strictEqual(mataroaSnaps.length, 1);
  assert.strictEqual(remainingMataroaOps.length, 0);

  // ─── Test 5: Sync from Mataroa (Primary) into Fresh DB ────────────────────
  console.log('✔ Test 5: Sync from Mataroa into fresh instance');

  const walPath2 = path.resolve('./.echodb_test_mataroa_wal2.json');
  if (fs.existsSync(walPath2)) fs.unlinkSync(walPath2);

  const dbFresh = new EchoEntriesDB({
    apiKey:           'mataroa-key-abc',
    email:            'dual@example.com',
    password:         'secure-password-123',
    encryptionSecret: 'secret-dual-2026',
    walPath:          walPath2,
    autoSyncMs:       0
  });

  // Share same Mataroa storage
  dbFresh._mataroaClient.listPages = async () => [...mataroaPages.values()];
  dbFresh._mataroaClient.createPage = async (p) => { mataroaPages.set(p.slug, p); return { ok: true, slug: p.slug }; };
  dbFresh._http.login = async () => ({ user: { id: 'mock_ee_user_456' } });
  dbFresh._fetchAllRows = async () => []; // Echo entries empty — test sync from Mataroa directly

  await dbFresh.init();

  const freshUsers = dbFresh.collection('users');
  dbFresh.createIndex('users', 'email', { unique: true });

  assert.strictEqual(freshUsers.count(), 2);
  assert.strictEqual(freshUsers.findById(u1.id)?.name, 'Primary Alice');
  assert.strictEqual(freshUsers.findById(u2.id)?.name, 'Primary Bob');
  assert.strictEqual(freshUsers.findOneBy('email', 'alice@dual.com')?.id, u1.id);

  // ─── Test 6: Fallback & Auto-Migration from Echo Entries to Mataroa ───────
  console.log('✔ Test 6: Automatic migration from Echo Entries when Mataroa is empty');

  const walPath3 = path.resolve('./.echodb_test_mataroa_wal3.json');
  if (fs.existsSync(walPath3)) fs.unlinkSync(walPath3);

  const emptyMataroaStorage = new Map();
  const dbMigrate = new EchoEntriesDB({
    apiKey:           'mataroa-migrated-key',
    email:            'dual@example.com',
    password:         'secure-password-123',
    encryptionSecret: 'secret-dual-2026',
    walPath:          walPath3,
    autoSyncMs:       0
  });

  dbMigrate._mataroaClient.listPages = async () => [...emptyMataroaStorage.values()];
  dbMigrate._mataroaClient.createPage = async (p) => {
    emptyMataroaStorage.set(p.slug, p);
    return { ok: true, slug: p.slug };
  };
  dbMigrate._http.login = async () => ({ user: { id: 'mock_ee_user_456' } });
  // Echo Entries has the 2 rows from earlier
  dbMigrate._fetchAllRows = async () => echoEntriesRows;

  await dbMigrate.init();

  const migratedUsers = dbMigrate.collection('users');
  assert.strictEqual(migratedUsers.count(), 2);
  assert.strictEqual(migratedUsers.findById(u1.id)?.name, 'Primary Alice');

  // Verify that data was automatically migrated to Mataroa
  const migratedSnaps = [...emptyMataroaStorage.values()].filter(p => p.slug.startsWith('echodb-snap-'));
  assert.strictEqual(migratedSnaps.length, 1);
  assert.strictEqual(migratedSnaps[0].is_hidden, true);

  // ─── Test 7: Atomic Transaction Rollback with Dual-Write ───────────────────
  console.log('✔ Test 7: Atomic transaction rollback prevents writes to both hosts');

  const pagesBefore = mataroaPages.size;
  const rowsBefore = echoEntriesRows.length;

  try {
    await db.transaction(async (tx) => {
      const txUsers = tx.collection('users');
      await txUsers.create({ name: 'Will Fail', email: 'fail@dual.com' });
      throw new Error('Simulated abort');
    });
    assert.fail('Transaction should have thrown');
  } catch (err) {
    assert.strictEqual(err.message, 'Simulated abort');
  }

  await db.flush();

  // RAM rolled back
  assert.strictEqual(users.findOneBy('email', 'fail@dual.com'), null);
  // No new pages on Mataroa
  assert.strictEqual(mataroaPages.size, pagesBefore);
  // No new rows on Echo Entries
  assert.strictEqual(echoEntriesRows.length, rowsBefore);

  // ─── Test 8: Secure Provisioning (CSPRNG, .env template, config) ─────────
  console.log('✔ Test 8: EchoEntriesDB.provisionAccount() with secure CSPRNG and .env output');

  const HttpClient = require('../src/http');
  const origMataroaRegister = MataroaClient.register;
  const origHttpSignup = HttpClient.prototype.signup;

  let capturedMataroaParams = null;
  let capturedEchoParams = null;

  MataroaClient.register = async (params) => {
    capturedMataroaParams = params;
    return {
      username: params.username,
      email: params.email,
      apiKey: 'mock-mataroa-api-key-xyz',
      sessionid: 'mock-session-123'
    };
  };

  HttpClient.prototype.signup = async function(email, password, meta) {
    capturedEchoParams = { email, password, meta };
    return {
      user: { id: 'ee-user-uuid-999' },
      access_token: 'jwt-token-abc',
      session: { access_token: 'jwt-token-abc' }
    };
  };

  const provisioned = await EchoEntriesDB.provisionAccount({
    email: 'dev@company.com'
  });

  // Verify credentials were synchronized and matched on both hosts
  assert.strictEqual(provisioned.success, true);
  assert.strictEqual(capturedMataroaParams.email, 'dev@company.com');
  assert.strictEqual(capturedEchoParams.email, 'dev@company.com');
  assert.strictEqual(capturedMataroaParams.password, capturedEchoParams.password);
  assert(capturedMataroaParams.password.length >= 24, 'Password should be at least 24 chars');
  assert.strictEqual(provisioned.credentials.password, capturedMataroaParams.password);
  assert.strictEqual(provisioned.credentials.apiKey, 'mock-mataroa-api-key-xyz');
  assert.strictEqual(typeof provisioned.credentials.encryptionSecret, 'string');
  assert.strictEqual(provisioned.credentials.encryptionSecret.length, 64); // 256-bit hex

  // Verify config object
  assert.strictEqual(provisioned.config.apiKey, 'mock-mataroa-api-key-xyz');
  assert.strictEqual(provisioned.config.email, 'dev@company.com');
  assert.strictEqual(provisioned.config.password, provisioned.credentials.password);
  assert.strictEqual(provisioned.config.encryptionSecret, provisioned.credentials.encryptionSecret);

  // Verify .env template
  assert(provisioned.env.includes('ECHODB_API_KEY="mock-mataroa-api-key-xyz"'));
  assert(provisioned.env.includes('ECHODB_EMAIL="dev@company.com"'));
  assert(provisioned.env.includes(`ECHODB_PASSWORD="${provisioned.credentials.password}"`));
  assert(provisioned.env.includes(`ECHODB_ENCRYPTION_SECRET="${provisioned.credentials.encryptionSecret}"`));

  // Verify codeSnippet
  assert(provisioned.codeSnippet.includes('new EchoEntriesDB'));
  assert(provisioned.codeSnippet.includes('process.env.ECHODB_API_KEY'));

  // Verify hosts
  assert.strictEqual(provisioned.hosts.primary.provider, 'mataroa');
  assert.strictEqual(provisioned.hosts.primary.status, 'active');
  assert.strictEqual(provisioned.hosts.backup.provider, 'echoentries');
  assert.strictEqual(provisioned.hosts.backup.status, 'active');

  // Verify backward-compatible properties
  assert.strictEqual(provisioned.apiKey, 'mock-mataroa-api-key-xyz');
  assert.strictEqual(provisioned.user.id, 'ee-user-uuid-999');
  assert.strictEqual(provisioned.emailConfirmationRequired, false);

  // ─── Test 9: Input Validation & Error Handling ────────────────────────────
  console.log('✔ Test 9: Input validation (invalid email & short password rejection)');

  // Invalid email format
  try {
    await EchoEntriesDB.register({ email: 'not-an-email' });
    assert.fail('Should have rejected invalid email');
  } catch (err) {
    assert(err.message.includes('Invalid email format'));
  }

  // Password too short
  try {
    await EchoEntriesDB.register({ email: 'test@ok.com', password: '123' });
    assert.fail('Should have rejected short password');
  } catch (err) {
    assert(err.message.includes('at least 8 characters'));
  }

  // Restore mocks
  MataroaClient.register = origMataroaRegister;
  HttpClient.prototype.signup = origHttpSignup;

  // Cleanups
  await db.close();
  await dbFresh.close();
  await dbMigrate.close();

  if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
  if (fs.existsSync(walPath2)) fs.unlinkSync(walPath2);
  if (fs.existsSync(walPath3)) fs.unlinkSync(walPath3);

  console.log('\n🎉 ALL MATAROA PROVIDER & DUAL-HOST TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('\n❌ TEST FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
