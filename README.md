# echodb

> **RAM-first document database backed by Echo Entries.**  
> Zero-dependency · Append-only log · Atomic transactions · End-to-End Encryption · Secondary Indexes · Auto-compaction · Offline/CI mode · TypeScript support.

[![npm](https://img.shields.io/npm/v/@bridevmx/echodb)](https://www.npmjs.com/package/@bridevmx/echodb)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## Features

| Feature | Description |
|---|---|
| ⚡ **RAM-first reads** | All queries served directly from in-memory Maps in **~0 ms**, without network roundtrips. |
| 👤 **Built-in Registration** | Create new accounts programmatically via static `EchoEntriesDB.register()`. |
| 🔐 **Double-Layer Encryption** | Optional end-to-end encryption layer (AES-256-GCM + PBKDF2) so not even storage admins can read data. |
| ⚡ **Secondary Indexes $O(1)$** | Declare indexes on any collection field for instant $O(1)$ lookups. |
| 🔍 **Chainable Query Builder** | Fluent query API supporting `.where()`, `.sortBy()`, `.limit()`, and `.offset()`. |
| 🛡️ **Atomic Transactions** | Thread-safe, serialized transactions with automatic RAM rollback on errors. |
| 💾 **Disk WAL Durability** | Write-Ahead Log guarantees zero data loss across process crashes or server restarts. |
| 📦 **Bulk Writes** | Entire batch of ops flushed in a single HTTP request to Echo Entries (PostgREST bulk insert). |
| 📦 **Auto-Compaction** | Automatically folds operation logs into consolidated snapshots to optimize cloud storage. |
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

## Account Registration

You can create a new Echo Entries account programmatically using the static `EchoEntriesDB.register()` method without needing an existing database instance.

```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');

async function registerAccount() {
  try {
    const result = await EchoEntriesDB.register({
      email:    'newuser@example.com',
      password: 'SecurePassword123!',
      firstName: 'Jane',
      lastName:  'Doe'
    });

    console.log('User created:', result.user.id);

    if (result.emailConfirmationRequired) {
      console.log('✉️ Check your inbox and confirm your email address before logging in.');
    } else {
      console.log('✅ Account ready for login!');
    }
  } catch (err) {
    console.error('Registration failed:', err.message);
  }
}

registerAccount();
```

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

// INSERT — auto-generates UUIDv4 id if omitted
const user = await users.insert({
  name: 'Alice',
  role: 'admin',
  age: 28
});

// READ BY ID — O(1) lookup
const foundUser = users.findById(user.id);

// READ WITH PREDICATE — O(n) scan
const admins = users.find(u => u.role === 'admin');
const firstAdmin = users.findOne(u => u.role === 'admin');
const allUsers = users.all();
const totalCount = users.count();

// UPDATE — shallow merge & increments version counter (_v)
await users.update(user.id, { age: 29 });

// UPSERT — inserts if id does not exist, updates if it exists
await users.upsert({
  id: 'usr_custom_101',
  name: 'Bob',
  role: 'developer'
});

// DELETE — returns boolean
const deleted = await users.delete(user.id);
```

Each document stored in `echodb` automatically includes system metadata fields:

```json
{
  "id": "385fec34-8bfd-424f-9f59-e5f722df8be8",
  "name": "Alice",
  "_col": "users",
  "_id": "385fec34-8bfd-424f-9f59-e5f722df8be8",
  "_type": "op",
  "_op": "INSERT",
  "_v": 1,
  "_eeId": "row_99218",
  "_createdAt": "2026-09-03T18:40:00.000Z",
  "_updatedAt": "2026-09-03T18:40:00.000Z"
}
```

---

### 2. Secondary Indexes $O(1)$

By default, filtering via `.find(fn)` performs a full scan over all documents in RAM. Declare secondary indexes to make exact-match lookups instantaneous ($O(1)$).

```javascript
// Declare indexes before or after inserting documents
db.createIndex('users', 'email');
db.createIndex('users', 'status');

const users = db.collection('users');

// O(1) array result lookup
const activeUsers = users.findBy('status', 'active');

// O(1) single result lookup
const userByEmail = users.findOneBy('email', 'alice@example.com');
```

*Note: Indexes are maintained automatically during `insert()`, `update()`, `upsert()`, `delete()`, transactions, and re-syncs.*

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
| `excludeMeta` | `boolean` | `false` | Strip internal metadata (`_col`, `_v`, `_eeId`, etc.). |

---

## Options & Configuration

### `new EchoEntriesDB(opts)`

| Option | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | required* | Echo Entries account email. |
| `password` | `string` | required* | Echo Entries account password. |
| `memoryOnly` | `boolean` | `false` | Run 100% in RAM — no auth, no WAL, no network. `email`/`password` not needed. |
| `encryptionSecret` | `string` | `null` | Extra secret key for double-layer E2EE encryption. |
| `walPath` | `string` | `'./.echodb_wal.json'` | Local disk path for the Write-Ahead Log file. |
| `autoSyncMs` | `number` | `300000` | Periodical sync interval from cloud in ms (`0` = disabled). |
| `compactEvery` | `number` | `20` | Ops threshold per collection to trigger auto-compaction. |
| `batchSize` | `number` | `10` | Maximum ops per bulk POST to Echo Entries. |
| `batchWindowMs` | `number` | `8` | Ms window to accumulate writes before firing background batch. |

*`email` and `password` are required unless `memoryOnly: true`.

---

## TypeScript Usage

`echodb` ships with complete type definitions (`index.d.ts`).

```typescript
import EchoEntriesDB, { Collection, DocMeta } from '@bridevmx/echodb';

interface Product {
  name: string;
  price: number;
  stock: number;
  category: string;
}

async function run() {
  const db = new EchoEntriesDB({
    email: 'user@example.com',
    password: 'password123'
  });

  await db.init();

  // Strongly typed collection
  const products: Collection<Product> = db.collection<Product>('products');

  // Insert typed document
  const doc = await products.insert({
    name: 'Keyboard',
    price: 49.99,
    stock: 20,
    category: 'tech'
  });

  // Typed results include DocMeta metadata (_id, _v, _createdAt, etc.)
  const item: (Product & DocMeta) | null = products.findById(doc.id);
  console.log(item?.name, item?._v);
}
```

---

## Architecture Overview

```
col.insert(doc)
  │
  ├── 1. Apply to RAM Map immediately  (~0 ms)
  ├── 2. Push to local WAL on disk     (sync write, ~0.1 ms)
  └── 3. Background drain (batch window):
           Single bulk POST → Echo Entries (N rows in 1 HTTP request)
           When ops threshold reached → Compact:
             PATCH single snapshot entry
             DELETE obsolete op-entries in parallel
```

> In `memoryOnly` mode, steps 2 and 3 are skipped entirely.

---

## License

[MIT](./LICENSE) © 2026 EchoDB Contributors
