---
name: echodb
description: Expert integration and usage guide for EchoDB (@bridevmx/echodb), a zero-dependency, RAM-first document database backed by Echo Entries with O(1) in-memory lookups, disk Write-Ahead Log (WAL) durability, atomic transactions, secondary indexes, JSON import/export, double-layer E2EE encryption, and automated compaction.
license: MIT
compatibility: Works with any AI coding agent. Requires Node.js >= 18.
metadata:
  package: "@bridevmx/echodb"
  version: "1.1.0"
  repository: https://github.com/bridevmx/echodb
  npm: https://www.npmjs.com/package/@bridevmx/echodb
---

# EchoDB Agent Skill (`@bridevmx/echodb`)

This skill provides comprehensive instructions, patterns, API references, and best practices for AI agents implementing, integrating, and debugging `@bridevmx/echodb`.

---

## 1. Core Architecture & Mental Model

EchoDB is a hybrid **RAM-first + Append-Only Document Database**:

1. **Reads (~0 ms)**: All active documents reside in in-memory JavaScript `Map` structures. Reads, queries, index lookups, and aggregations run instantly without disk or network I/O.
2. **Writes (Immediate RAM + Local WAL + Background Sync)**:
   - When `insert()`, `update()`, `upsert()`, or `delete()` is called:
     1. Updated in RAM `Map` immediately.
     2. Appended synchronously to the local disk **Write-Ahead Log (WAL)** file (`.echodb_wal.json`) to prevent data loss on crashes.
     3. Queued and drained in background batches to the **Echo Entries cloud API**.
3. **Double-Layer Encryption (E2EE)**:
   - **Outer Layer**: AES-256-GCM encrypted using the user ID (compatible with Echo Entries UI).
   - **Inner Layer (Optional `encryptionSecret`)**: AES-256-GCM + PBKDF2 applied *before* outer encryption for zero-knowledge privacy.
4. **Auto-Compaction**: Periodically collapses historical operation logs into single snapshot entries on the cloud once threshold (`compactEvery`) is reached.
5. **Zero External Dependencies**: Uses only standard Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:https`).

---

## 2. Installation & Import

### Install
```bash
npm install @bridevmx/echodb
```

### CommonJS
```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');
```

### ES Modules / TypeScript
```typescript
import EchoEntriesDB, { Collection, DocMeta, EchoEntriesDBOptions, Query } from '@bridevmx/echodb';
```

---

## 3. Configuration & Lifecycle

### Options Reference (`EchoEntriesDBOptions`)

| Option | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | **required** | Echo Entries account email. |
| `password` | `string` | **required** | Echo Entries account password. |
| `encryptionSecret` | `string` | `undefined` | Optional extra secret for inner AES-256-GCM layer. |
| `walPath` | `string` | `'./.echodb_wal.json'` | Local disk path for the WAL file. |
| `autoSyncMs` | `number` | `300000` (5 min) | Background polling sync from cloud (`0` = disabled). |
| `compactEvery` | `number` | `20` | Ops threshold per collection to trigger compaction. |
| `batchSize` | `number` | `10` | Max parallel cloud requests per drain cycle. |
| `batchWindowMs` | `number` | `8` | Milliseconds window to batch pending writes. |

---

### Programmatic User Registration

Before first login, accounts can be registered statically:

```javascript
const { EchoEntriesDB } = require('@bridevmx/echodb');

const result = await EchoEntriesDB.register({
  email: 'dev@example.com',
  password: 'StrongPassword123!',
  firstName: 'John',
  lastName: 'Doe'
});

if (result.emailConfirmationRequired) {
  console.log('Verification email sent! Check inbox before logging in.');
}
```

---

### Lifecycle: `init()`, `flush()`, and `close()`

```javascript
const db = new EchoEntriesDB({
  email: process.env.EE_EMAIL,
  password: process.env.EE_PASSWORD,
  encryptionSecret: process.env.EE_SECRET,
  walPath: './data/production.wal.json'
});

// 1. MUST ALWAYS await init() before querying or writing
await db.init();

// Declare secondary indexes immediately after init
db.createIndex('users', 'email');
db.createIndex('orders', 'userId');

// ... Application Logic ...

// 2. Graceful Shutdown: flush pending WAL ops to cloud and stop background timers
async function shutdown() {
  console.log('Shutting down EchoDB...');
  await db.close(); // Automatically flushes WAL and clears sync/drain timers
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

---

## 4. Collection CRUD Operations

Every document automatically includes the `DocMeta` fields:
- `id` / `_id`: Document UUID.
- `_col`: Collection name.
- `_v`: Monotonically increasing revision counter (`1`, `2`, ...).
- `_createdAt`: ISO-8601 creation timestamp.
- `_updatedAt`: ISO-8601 last update timestamp.
- `_type`: `'op' | 'snapshot'`
- `_op`: `'INSERT' | 'UPDATE' | 'DELETE'`

```javascript
const users = db.collection('users');

// INSERT: Auto-assigns UUIDv4 if 'id' is omitted
const alice = await users.insert({
  name: 'Alice Smith',
  email: 'alice@example.com',
  role: 'admin',
  tags: ['developer', 'security']
});

// READ BY ID (O(1) in-memory Map lookup)
const user = users.findById(alice.id);

// UPDATE: Shallow merges changes, increments _v, updates _updatedAt
const updated = await users.update(alice.id, {
  role: 'superadmin'
});

// UPSERT: Inserts if id does not exist, updates if it does
const bob = await users.upsert({
  id: 'usr_custom_bob',
  name: 'Bob',
  email: 'bob@example.com'
});

// DELETE: Removes from RAM, updates indexes, logs DELETE in WAL
const wasDeleted = await users.delete(alice.id); // returns boolean
```

---

## 5. Secondary Indexes for $O(1)$ Lookups

By default, `.find(predicate)` does a full RAM scan $O(n)$. For high-frequency query fields (e.g. `email`, `userId`, `slug`, `status`), declare secondary indexes:

```javascript
// Declare index on 'users' collection for field 'email'
db.createIndex('users', 'email');
db.createIndex('users', 'status');

const users = db.collection('users');

// O(1) single result
const user = users.findOneBy('email', 'alice@example.com');

// O(1) array result
const activeUsers = users.findBy('status', 'active');
```

*Note: Indexes are maintained in RAM automatically during `insert()`, `update()`, `upsert()`, `delete()`, transactions, and cloud re-syncs.*

---

## 6. Chainable Query Builder

Fluent query builder supporting `.where()`, `.sortBy()`, `.offset()`, `.limit()`, and execution.

```javascript
const products = db.collection('products');
db.createIndex('products', 'category');

// Build query
const topProducts = products
  .where({ category: 'electronics', status: 'in_stock' })
  .sortBy('price', 'desc') // 'asc' or 'desc'
  .offset(0)
  .limit(10)
  .exec(); // or .get()

// Get first matching item
const cheapest = products
  .where({ category: 'electronics' })
  .sortBy('price', 'asc')
  .first();

// Get count without allocating full array
const inStockCount = products
  .where({ status: 'in_stock' })
  .count();
```

---

## 7. Atomic Transactions with Automatic Rollback

Transactions are fully atomic, thread-safe, and serialized. If any error occurs within the transaction callback:
1. All RAM mutations across all collections are automatically rolled back.
2. All secondary indexes are restored to their pre-transaction state.
3. No operations are written to the WAL or cloud.

```javascript
try {
  await db.transaction(async (tx) => {
    const accounts = tx.collection('accounts');
    const transfers = tx.collection('transfers');

    const source = accounts.findById('acc_source');
    const target = accounts.findById('acc_target');

    if (!source || source.balance < 100) {
      throw new Error('Insufficient balance'); // Auto-triggers complete RAM rollback
    }

    await accounts.update(source.id, { balance: source.balance - 100 });
    await accounts.update(target.id, { balance: target.balance + 100 });
    await transfers.insert({
      from: source.id,
      to: target.id,
      amount: 100,
      timestamp: new Date().toISOString()
    });
  });

  console.log('Transaction committed successfully.');
} catch (err) {
  console.error('Transaction failed and was safely rolled back:', err.message);
}
```

---

## 8. Export & Import JSON

EchoDB supports atomic multi-collection and single-collection JSON serialization and deserialization.

### Database-Level Export & Import
```javascript
// Export all collections to a formatted JSON string
const jsonString = db.exportJSON({ pretty: true });

// Export without system metadata (_col, _v, etc.) or for specific collections
const cleanExport = db.exportJSON({
  collections: ['users', 'products'],
  excludeMeta: true,
  stringify: false // returns JS object instead of JSON string
});

// Atomic Multi-Collection Import (Runs inside a single transaction)
const result = await db.importJSON(jsonString, { mode: 'upsert' });
console.log(`Imported ${result.total} documents across ${Object.keys(result.imported).length} collections.`);
```

### Collection-Level Export, Import & Clear
```javascript
const users = db.collection('users');

// Export single collection
const usersBackup = users.exportJSON({ pretty: true, excludeMeta: true });

// Import array of documents with overwrite mode (clears existing documents first)
await users.importJSON(usersBackup, { mode: 'overwrite' });

// Clear all documents in collection
const deletedCount = await users.clear();
```

| Option | Type | Default | Description |
|---|---|---|---|
| `mode` | `'upsert' \| 'overwrite' \| 'insert'` | `'upsert'` | Import strategy. |
| `collections` | `string[]` | all | Subset of collection names to export or import. |
| `pretty` | `boolean` | `false` | Format JSON with 2-space indentation. |
| `stringify` | `boolean` | `true` | Return JSON string if `true`, JS object if `false`. |
| `excludeMeta` | `boolean` | `false` | Strip internal metadata (`_col`, `_v`, `_eeId`, etc.). |

---

## 9. TypeScript Usage Example

```typescript
import EchoEntriesDB, { Collection, DocMeta } from '@bridevmx/echodb';

interface OrderItem {
  sku: string;
  qty: number;
  price: number;
}

interface Order {
  customerId: string;
  items: OrderItem[];
  total: number;
  status: 'pending' | 'paid' | 'shipped' | 'cancelled';
}

async function start() {
  const db = new EchoEntriesDB({
    email: process.env.EE_EMAIL!,
    password: process.env.EE_PASSWORD!,
    encryptionSecret: process.env.EE_SECRET
  });

  await db.init();
  db.createIndex('orders', 'customerId');

  const orders: Collection<Order> = db.collection<Order>('orders');

  const newOrder = await orders.insert({
    customerId: 'cust_982',
    items: [{ sku: 'KB-99', qty: 1, price: 49.99 }],
    total: 49.99,
    status: 'pending'
  });

  // Typed results include DocMeta (_id, _v, _createdAt, etc.)
  const found: (Order & DocMeta) | null = orders.findById(newOrder.id);
  console.log(found?.status, found?._createdAt);
}
```

---

## 9. Critical Agent Rules & Checklist

When generating code or debugging with `@bridevmx/echodb`, ALWAYS check:

1. ⚠️ **Always `await db.init()`**: Never call collection methods before `db.init()` has resolved.
2. ⚠️ **Always declare indexes early**: Place `db.createIndex(col, field)` right after `db.init()` for any field used with `findBy()`, `findOneBy()`, or `where()`.
3. ⚠️ **Singleton Pattern in Web Frameworks**: In Express, Fastify, Next.js, or Hono, initialize `EchoEntriesDB` once as a singleton module. Do NOT create a new instance on every HTTP request.
4. ⚠️ **Handle Graceful Shutdown**: Always attach `db.close()` to `SIGINT` and `SIGTERM` so pending WAL writes drain to the cloud.
5. ⚠️ **Do Not Mutate Metadata Manually**: Never manually overwrite `_id`, `_col`, `_v`, `_type`, `_op`, `_createdAt`, or `_updatedAt`.
6. ⚠️ **Use `walPath` in Containerized/Cloud Environments**: Ensure `walPath` points to a writable, persistent volume directory (e.g. `/data/.echodb_wal.json` or `./data/.wal.json`) if running inside Docker.
7. ⚠️ **Transactions Scoping**: Inside `db.transaction(async (tx) => { ... })`, ALWAYS use the `tx` parameter (`tx.collection(...)`), never the outer `db` variable.
