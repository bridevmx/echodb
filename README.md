# echodb

> **RAM-first document database backed by Mataroa (Primary) and Echo Entries (Backup).**  
> Dual-Host Write · Zero-dependency · Append-only log · Atomic transactions · End-to-End Encryption · Secondary Indexes · Auto-compaction · Offline/CI mode · TypeScript support.

[![npm](https://img.shields.io/npm/v/@bridevmx/echodb)](https://www.npmjs.com/package/@bridevmx/echodb)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Features

| Feature | Description |
|---|---|
| ⚡ **RAM-first reads** | All queries served directly from in-memory Maps in **~0 ms**, without network roundtrips. |
| 🌐 **Primary + Backup Dual-Host** | **Mataroa (https://mataroa.blog)** acts as the primary cloud host with **Echo Entries** as redundant backup. Ops are written to both simultaneously. |
| 🚀 **PocketBase Parity** | 100% compatible 15-char IDs (`[a-z0-9]{15}`), canonical `created`/`updated` timestamps, `getOne`, `getList`, `.expand()`, and batch export. |
| 👤 **Built-in Registration** | Create new accounts programmatically via static `EchoEntriesDB.register()` or `MataroaClient.register()`. |
| 🔐 **Double-Layer Encryption** | Optional end-to-end encryption layer (AES-256-GCM + PBKDF2) so not even storage admins can read data. |
| ⚡ **Secondary & Unique Indexes $O(1)$** | Declare indexes on any collection field with optional unique constraint for instant $O(1)$ lookups and integrity. |
| 🔍 **Chainable Query Builder** | Fluent query API supporting `.where()`, `.sortBy()`, `.limit()`, and `.offset()`. |
| 🛡️ **Atomic Transactions** | Thread-safe, serialized transactions with automatic RAM rollback on errors. |
| 💾 **Disk WAL Durability** | Write-Ahead Log guarantees zero data loss across process crashes or server restarts. |
| 📦 **Bulk Writes** | Batch of ops flushed in parallel to Mataroa (hidden pages) and Echo Entries (PostgREST bulk insert). |
| 📦 **Auto-Compaction** | Automatically folds operation logs into consolidated snapshots on both hosts to optimize storage. |
| 🧪 **Offline / CI mode** | `memoryOnly: true` runs 100% in RAM — no credentials, no network, no WAL. Perfect for tests. |
| 📦 **Zero Dependencies** | Powered purely by Node.js built-in modules (`node:crypto`, `fs`). No external npm packages. |
| 📘 **TypeScript Support** | Full type definitions included (`index.d.ts`) with generic collection support. |

---

## Installation

```bash
npm install @bridevmx/echodb
```

**Requirements:** Node.js `>= 18`

> **ESM & CommonJS:** The package ships a single `index.js` and exposes both `import` and `require` entry-points in `package.json`, so it works out-of-the-box in CJS (`require`) and ESM (`import`) projects without any extra configuration.

---

## Account Registration & Provisioning

You can create accounts programmatically using the static `EchoEntriesDB.provisionAccount()` (or `EchoEntriesDB.register()`) method without needing an existing database instance. This provisions a **single synchronized account** across **Mataroa (Primary host)** and **Echo Entries (Backup host)** simultaneously, with automatic CSPRNG security generation:

```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');

async function setupDatabase() {
  try {
    const result = await EchoEntriesDB.provisionAccount({
      email:     'dev@mycompany.com',
      // password, username, and encryptionSecret are optional:
      // if omitted, EchoDB generates a 24-char CSPRNG password and 256-bit E2EE key!
    });

    console.log('✅ Synchronized Account Created:');
    console.log('API Key:', result.credentials.apiKey);
    console.log('Password:', result.credentials.password);
    console.log('E2EE Secret:', result.credentials.encryptionSecret);

    // Save ready-made .env template to disk
    const fs = require('fs');
    fs.writeFileSync('.env', result.env);
    console.log('Saved .env file successfully!');

    // Or initialize the DB directly using result.config:
    const db = new EchoEntriesDB(result.config);
    await db.init();
  } catch (err) {
    console.error('Provisioning failed:', err.message);
  }
}

setupDatabase();
```

### What `provisionAccount()` returns:

```javascript
{
  success: true,

  // 1. Synchronized credentials for both hosts
  credentials: {
    username: 'm8a3f120',
    email: 'dev@mycompany.com',
    password: '...',         // 24-char CSPRNG password
    apiKey: '...',           // Mataroa Bearer token
    encryptionSecret: '...'  // 256-bit CSPRNG hex key
  },

  // 2. Ready-to-pass config object
  config: {
    apiKey: '...',
    email: 'dev@mycompany.com',
    password: '...',
    encryptionSecret: '...'
  },

  // 3. Pre-formatted .env template with security comments
  env: `
# ========================================================
# EchoDB Credentials (Mataroa Primary + Echo Entries Backup)
# WARNING: NEVER commit this file to version control (.gitignore)
# ========================================================
ECHODB_API_KEY="..."
ECHODB_EMAIL="dev@mycompany.com"
ECHODB_PASSWORD="..."
ECHODB_ENCRYPTION_SECRET="..."
  `.trim(),

  // 4. Code snippet for developer convenience
  codeSnippet: `...`,

  // 5. Host status
  hosts: {
    primary: { provider: 'mataroa', url: 'https://mataroa.blog', status: 'active' },
    backup:  { provider: 'echoentries', url: 'https://veorhexddrwlwxtkuycb.supabase.co', status: 'active' }
  }
}
```

> **Security First**: All generated passwords use OS-level CSPRNG (`crypto.randomInt` and `crypto.randomBytes`), guarantee high entropy across 4 character classes, and pass Mataroa's Django similarity validation. Sensitive secrets are never logged.

---

## Quick Start

```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');

async function main() {
  // 1. Initialize and authenticate
  const db = new EchoEntriesDB({
    email:            process.env.EE_EMAIL,
    password:         process.env.EE_PASSWORD,
    encryptionSecret: 'my-private-encryption-key' // Optional E2EE
  });

  await db.init();

  // 2. Get a collection
  const products = db.collection('products');

  // 3. Declare a secondary index for O(1) lookups
  db.createIndex('products', 'category');

  // 4. Insert documents
  const item = await products.insert({
    title:    'Wireless Mouse',
    category: 'electronics',
    price:    29.99,
    stock:    100
  });

  // 5. Read operations (~0 ms)
  const mouse = products.findById(item.id);
  const electronics = products.findBy('category', 'electronics'); // O(1) index lookup

  // 6. Chainable Query Builder
  const deals = products
    .where({ category: 'electronics' })
    .sortBy('price', 'asc')
    .limit(5)
    .exec();

  // 7. Update document
  await products.update(item.id, { stock: 95 });

  // 8. Clean shutdown (flushes pending WAL ops)
  await db.close();
}

main();
```

---

## Detailed Usage Examples

### 1. CRUD Operations

```javascript
const users = db.collection('users');

// CREATE — canonical PocketBase SDK method name; auto-generates 15-char ID if omitted
const user = await users.create({
  name: 'Alice',
  role: 'admin',
  age: 28
});
// create() also accepts options: { expand, fields }
const projected = await users.create({ name: 'Bob', role: 'dev', age: 25 }, { fields: 'id,name' });
// projected → { id: '...', name: 'Bob' }  (only those two fields returned)

// INSERT — alias for create(), kept for backward compatibility
const user2 = await users.insert({ name: 'Carol', role: 'admin', age: 30 });

// READ BY ID — O(1) lookup
const foundUser = users.findById(user.id); // or users.getOne(user.id)

// READ WITH PREDICATE — O(n) scan
const admins = users.find(u => u.role === 'admin');
const firstAdmin = users.findOne(u => u.role === 'admin');
const allUsers = users.all();
const totalCount = users.count();

// UPDATE — PATCH semantics (partial merge); refreshes updated timestamp
// Third arg options: { expand, fields } — same as create()
await users.update(user.id, { age: 29 });
const updated = await users.update(user.id, { age: 30 }, { fields: 'id,age' });
// updated → { id: '...', age: 30 }

// UPSERT — inserts if id does not exist, updates if it exists (requires valid 15-char ID if passed)
await users.upsert({
  id: 'usr000000000101',
  name: 'Dave',
  role: 'developer'
});

// DELETE — returns boolean
const deleted = await users.delete(user.id);
```

Each document stored in `echodb` uses canonical PocketBase metadata fields:

```json
{
  "id": "m8x3z9a1b2c3d4e",
  "name": "Alice",
  "role": "admin",
  "age": 28,
  "created": "2026-09-04T12:00:00.000Z",
  "updated": "2026-09-04T12:00:00.000Z"
}
```

---

### 2. PocketBase SDK Query Parity & Relation Expand

EchoDB implements the exact read methods from the official PocketBase SDK with in-memory $O(1)$ relational expansion. All methods support `{ expand }` and `{ fields }` options:

```javascript
const credits = db.collection('credits');
const customers = db.collection('customers');

// 1. getOne(id, { expand, fields }) — O(1) lookup
const credit = credits.getOne('c8x3z2a1b9q0p12', { expand: 'customerId' });
console.log(credit.expand.customerId.name); // resolved from RAM

// fields projection — only include specified fields in response
const slim = credits.getOne('c8x3z2a1b9q0p12', { fields: 'id,amount,created' });
// slim → { id: '...', amount: 50, created: '...' }

// 2. getFirstListItem(filter, { expand, fields })
const activeStaff = users.getFirstListItem(u => u.role === 'staff');
const userByEmail = users.getFirstListItem('email', 'alice@example.com');
const userByObj   = users.getFirstListItem({ role: 'admin' });

// 3. getFullList({ filter, sort, expand, fields }) — supports PocketBase sort syntax
const topCredits = credits.getFullList({
  sort: '-created', // PocketBase style: '-' for desc, '+' or none for asc
  expand: 'customerId',
  fields: 'id,amount,expand'
});

// 4. getList(page, perPage, { sort, filter, expand, fields, skipTotal })
//    returns standard PocketBase paginated shape
const pageResult = credits.getList(1, 20, { sort: '-created' });
console.log(pageResult);
// {
//   page: 1,
//   perPage: 20,
//   totalItems: 142,
//   totalPages: 8,
//   items: [...]
// }

// skipTotal: true — skip computing totalItems/totalPages (faster)
// Returns totalItems: -1 and totalPages: -1 (mirrors PocketBase SDK behavior)
const fast = credits.getList(1, 20, { sort: '-created', skipTotal: true });
```

---

### 3. Secondary & Unique Indexes $O(1)$

Declare secondary indexes to make lookups instantaneous ($O(1)$). Use `{ unique: true }` to enforce database-level uniqueness across documents:

```javascript
// Secondary index
db.createIndex('users', 'role');

// Unique index — throws immediately in O(1) if value is duplicate
db.createIndex('users', 'email', { unique: true });
db.createIndex('customers', 'phone', { unique: true });

const users = db.collection('users');

// Instant O(1) lookup
const user = users.findOneBy('email', 'alice@example.com');

// Throws [EchoDB] Unique constraint violation if email already exists:
try {
  await users.insert({ name: 'Impostor', email: 'alice@example.com' });
} catch (err) {
  console.error(err.message);
}
```

*Note: Indexes and unique constraints are fully transactional: if a `db.transaction()` rolls back, all unique index entries are atomically reverted.*

---

### 4. Lightweight Schema Contracts & SQLite Zero-Values Coercion

PocketBase relies on SQLite, which requires typed values instead of JavaScript `undefined`. EchoDB allows registering optional lightweight schemas for automatic zero-value coercion and PocketBase migration file generation:

```javascript
db.defineSchema('customers', {
  name:   { type: 'text', required: true },
  phone:  { type: 'text', required: true, unique: true },
  points: { type: 'number', default: 0 },
  active: { type: 'bool', default: true },
  notes:  { type: 'text', default: '' },
  tier:   { type: 'select', options: ['REGULAR', 'SILVER', 'GOLD'], default: 'REGULAR' }
});

const customers = db.collection('customers');

// Missing fields are automatically coerced to SQLite zero-values (0, "", false):
const customer = await customers.insert({ name: 'Carlos', phone: '5512345678' });
console.log(customer.points); // 0 (not undefined)
console.log(customer.notes);  // "" (not undefined)
console.log(customer.active); // true (default applied)

// Generate PocketBase v0.23+ JS migration file:
const migrationCode = db.generatePocketBaseMigration();
// Outputs ready-to-run pb_migrations script!
```

---

### 5. Native PocketBase Batch Export (`POST /api/batch`)

Export your entire database partitioned into payloads formatted for PocketBase's transactional batch endpoint (`POST /api/batch`, introduced in v0.22+):

```javascript
// Generate batches of 100 requests (or custom batchSize)
const batches = db.exportPocketBaseBatch({ batchSize: 100 });

// Direct 1-click import into PocketBase:
for (const batch of batches) {
  await fetch('http://127.0.0.1:8090/api/batch', {
    method: 'POST',
    headers: {
      'Authorization': `AdminOrUserToken`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(batch)
  });
}
```

---

### 3. Chainable Query Builder

Use `.where()` for complex queries. The query engine automatically detects and utilizes the most selective secondary index available.

```javascript
const products = db.collection('products');

db.createIndex('products', 'category');
db.createIndex('products', 'status');

// Filter, Sort, Offset, Limit
const results = products
  .where({ category: 'hardware', status: 'active' })
  .sortBy('price', 'desc')
  .offset(0)
  .limit(10)
  .exec();

// Fetch first matching document
const cheapest = products
  .where({ status: 'active' })
  .sortBy('price', 'asc')
  .first();

// Get matching count without constructing full array
const countActive = products
  .where({ status: 'active' })
  .count();
```

---

### 4. Atomic Transactions

Transactions in `echodb` are fully atomic and thread-safe. If any operation inside the transaction block throws an error, all RAM mutations and index updates across all collections are automatically reverted.

```javascript
try {
  await db.transaction(async (tx) => {
    const accounts = tx.collection('accounts');
    const logs = tx.collection('audit_logs');

    const accA = accounts.findById('acc_A');
    const accB = accounts.findById('acc_B');

    if (accA.balance < 500) {
      throw new Error('Insufficient funds'); // Triggers automatic rollback
    }

    await accounts.update('acc_A', { balance: accA.balance - 500 });
    await accounts.update('acc_B', { balance: accB.balance + 500 });
    await logs.insert({ type: 'transfer', amount: 500, from: 'acc_A', to: 'acc_B' });
  });

  console.log('Transaction committed successfully!');
} catch (err) {
  console.error('Transaction rolled back:', err.message);
}
```

---

### 5. Double-Layer End-to-End Encryption (E2EE)

`echodb` provides client-side encryption using AES-256-GCM and PBKDF2 key derivation.

1. **Outer Layer (Default)**: Encrypted using the `userId`. Formatted to be compatible with Echo Entries web UI.
2. **Inner Layer (Optional `encryptionSecret`)**: Applied *before* the outer layer using your private secret key.

```javascript
const db = new EchoEntriesDB({
  email:            process.env.EE_EMAIL,
  password:         process.env.EE_PASSWORD,
  encryptionSecret: 'your-super-secret-client-side-key'
});
```

*When `encryptionSecret` is set, data is double-encrypted. Even storage cloud administrators cannot read your document contents.*

---

### 6. Offline / CI Mode (`memoryOnly`)

Pass `memoryOnly: true` to run entirely in RAM — no credentials, no network calls, no WAL file, no auth.  
All APIs (`collection`, `transaction`, `exportJSON`, `importJSON`) work identically.

```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');

const db = new EchoEntriesDB({ memoryOnly: true });
await db.init(); // returns immediately, no network

const tasks = db.collection('tasks');
await tasks.insert({ title: 'Write tests', done: false });

const pending = tasks.find(t => !t.done);
console.log(pending); // works fully in RAM

await db.close(); // instant, no flush
```

**Use cases:**
- Unit tests and integration tests (Jest, Vitest, Mocha) — process exits cleanly without `process.exit()`
- CI/CD pipelines without real credentials
- Local offline development and prototyping
- Seeding scripts that export JSON for later import

> When `memoryOnly: true` is set, `email` and `password` are not required.

---

### 7. Export & Import JSON

You can export and import the entire database or individual collections to/from JSON with full atomicity and secondary index synchronization.

#### Exporting to JSON

```javascript
// 1. Export entire database to formatted JSON string
const dbDump = db.exportJSON({ pretty: true });

// 2. Export specific collections without internal metadata
const productsDump = db.exportJSON({
  collections: ['products', 'categories'],
  excludeMeta: true,
  pretty: true
});

// 3. Export single collection
const usersCollection = db.collection('users');
const usersJson = usersCollection.exportJSON({ pretty: true, excludeMeta: true });
```

#### Importing from JSON

```javascript
// 1. Multi-collection atomic import (upsert mode by default)
const result = await db.importJSON(dbDump, { mode: 'upsert' });
console.log(`Imported ${result.total} documents across collections.`);

// 2. Overwrite collection mode (clears existing documents first)
await usersCollection.importJSON(usersJson, { mode: 'overwrite' });

// 3. Clear all documents in a collection
const deletedCount = await usersCollection.clear();
```

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `'upsert' \| 'overwrite' \| 'insert'` | `'upsert'` | Import strategy. |
| `collections` | `string[]` | all | Subset of collection names to export or import. |
| `pretty` | `boolean` | `false` | Format JSON with 2-space indentation. |
| `stringify` | `boolean` | `true` | Return JSON string if `true`, JS object if `false`. |
| `excludeMeta` | `boolean` | `false` | Strip internal metadata (`_v`, `_eeId`) from exported documents. |

---

## Options & Configuration

### `new EchoEntriesDB(opts)`

| Option | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | optional* | Account email (Echo Entries backup and Mataroa registration). |
| `password` | `string` | optional* | Account password. |
| `apiKey` | `string` | `null` | Direct Mataroa Bearer API key (primary host). |
| `username` | `string` | `null` | Mataroa username (for auto-login without apiKey). |
| `memoryOnly` | `boolean` | `false` | Run 100% in RAM — no auth, no WAL, no network. Perfect for tests & CI. |
| `encryptionSecret` | `string` | `null` | Extra secret key for double-layer E2EE encryption. |
| `walPath` | `string` | `'./.echodb_wal.json'` | Local disk path for the Write-Ahead Log file. |
| `autoSyncMs` | `number` | `300000` | Periodical sync interval from cloud in ms (`0` = disabled). |
| `compactEvery` | `number` | `20` | Ops threshold per collection to trigger auto-compaction. |
| `batchSize` | `number` | `10` | Maximum ops per bulk drain cycle. |
| `batchWindowMs` | `number` | `8` | Ms window to accumulate writes before firing background batch. |

*\*`email` + `password` or `apiKey` is required unless `memoryOnly: true`.*

---

## TypeScript Usage

`echodb` ships with complete type definitions (`index.d.ts`).

```typescript
import EchoEntriesDB, { Collection, DocMeta, MataroaClient } from '@bridevmx/echodb';

interface Product {
  name: string;
  price: number;
  stock: number;
  category: string;
}

async function run() {
  const db = new EchoEntriesDB({
    email: 'user@example.com',
    password: 'password123',
    apiKey: process.env.MATAROA_API_KEY // optional direct Mataroa key
  });

  await db.init();

  // Strongly typed collection
  const products: Collection<Product> = db.collection<Product>('products');

  // Insert typed document — use create() (canonical) or insert() (alias)
  const doc = await products.create({
    name: 'Keyboard',
    price: 49.99,
    stock: 20,
    category: 'tech'
  });

  // Typed results include DocMeta fields (id, created, updated, _v)
  const item: (Product & DocMeta) | null = products.findById(doc.id);
  console.log(item?.name, item?.created);
}
```

---

## Architecture Overview (Dual-Host Storage)

```
col.insert(doc)
  │
  ├── 1. Apply to RAM Map immediately  (~0 ms)
  ├── 2. Push to local WAL on disk     (sync write, ~0.1 ms)
  └── 3. Background drain (batch window) — DUAL WRITE in parallel:
           ├── PRIMARY:  Mataroa (https://mataroa.blog) hidden pages
           └── BACKUP:   Echo Entries PostgREST bulk insert
           
         When ops threshold reached → DUAL-COMPACT:
           ├── PRIMARY:  PATCH Mataroa snapshot page & DELETE op pages
           └── BACKUP:   PATCH Echo Entries snapshot row & DELETE op rows
```

> In `memoryOnly` mode, steps 2 and 3 are skipped entirely.

---

## License

[MIT](./LICENSE) © 2026 EchoDB Contributors
