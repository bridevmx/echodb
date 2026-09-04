---
name: echodb
description: Expert integration and usage guide for EchoDB (@bridevmx/echodb), a zero-dependency, RAM-first document database backed by Echo Entries with PocketBase parity: 15-char canonical IDs ([a-z0-9]{15}), created/updated timestamps, O(1) in-memory lookups, relation expand, disk Write-Ahead Log (WAL) durability, atomic transactions, secondary & unique indexes, schema contracts, PocketBase batch export, double-layer E2EE encryption, and automated compaction.
license: MIT
compatibility: Works with any AI coding agent. Requires Node.js >= 18.
metadata:
  package: "@bridevmx/echodb"
  version: "2.0.0"
  repository: https://github.com/bridevmx/echodb
  npm: https://www.npmjs.com/package/@bridevmx/echodb
---

# EchoDB Agent Skill (`@bridevmx/echodb`)

This skill provides comprehensive instructions, patterns, API references, and best practices for AI agents implementing, integrating, and debugging `@bridevmx/echodb`.

---

## 1. Core Architecture & Mental Model

EchoDB is a hybrid **RAM-first + Append-Only Document Database with PocketBase Parity**:

1. **Reads (~0 ms)**: All active documents reside in in-memory JavaScript `Map` structures. Reads, queries, index lookups, and relation expansions (`.expand`) run instantly without disk or network I/O.
2. **PocketBase-Parity Standards**:
   - **Canonical IDs**: 15-character lowercase alphanumeric IDs (`[a-z0-9]{15}`).
   - **Canonical Timestamps**: `created` and `updated` (ISO-8601 UTC).
   - **SDK Read Parity**: `getOne()`, `getFirstListItem()`, `getFullList()`, `getList()` with `{ page, perPage, totalItems, totalPages, items }`.
   - **In-Memory Expand**: Cross-collection foreign key resolution in RAM.
   - **Batch Migration**: Direct export to PocketBase's transactional `POST /api/batch`.
3. **Writes (Immediate RAM + Local WAL + Background Sync)**:
   - When `insert()`, `update()`, `upsert()`, or `delete()` is called:
     1. Validated and coerced against schema (if defined) & checked for unique constraints.
     2. Updated in RAM `Map` and secondary indexes immediately.
     3. Appended synchronously to the local disk **Write-Ahead Log (WAL)** file (`.echodb_wal.json`) to prevent data loss on crashes.
     4. Queued and drained in background batches to the **Echo Entries cloud API**.
4. **Double-Layer Encryption (E2EE)**:
   - **Outer Layer**: AES-256-GCM encrypted using the user ID (compatible with Echo Entries UI).
   - **Inner Layer (Optional `encryptionSecret`)**: AES-256-GCM + PBKDF2 applied *before* outer encryption for zero-knowledge privacy.
5. **Auto-Compaction**: Periodically collapses historical operation logs into single snapshot entries on the cloud once threshold (`compactEvery`) is reached.
6. **Zero External Dependencies**: Uses only standard Node.js built-ins (`node:crypto`, `node:fs`, `node:path`, `node:https`).

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
| `email` | `string` | **required\*** | Echo Entries account email. |
| `password` | `string` | **required\*** | Echo Entries account password. |
| `memoryOnly` | `boolean` | `false` | Run 100% in RAM — no auth, no WAL, no network. Perfect for tests & CI. |
| `encryptionSecret` | `string` | `undefined` | Optional extra secret for inner AES-256-GCM layer. |
| `walPath` | `string` | `'./.echodb_wal.json'` | Local disk path for the WAL file. |
| `autoSyncMs` | `number` | `300000` (5 min) | Background polling sync from cloud (`0` = disabled). |
| `compactEvery` | `number` | `20` | Ops threshold per collection to trigger compaction. |
| `batchSize` | `number` | `10` | Max parallel cloud requests per drain cycle. |
| `batchWindowMs` | `number` | `8` | Milliseconds window to batch pending writes. |

*\*`email` and `password` are required unless `memoryOnly: true` is set.*

---

## 4. Collection CRUD Operations

Every document in EchoDB follows the canonical PocketBase schema:
- `id`: 15-char lowercase alphanumeric string (`[a-z0-9]{15}`). Auto-generated if omitted.
- `created`: Inmutable ISO-8601 UTC creation timestamp.
- `updated`: ISO-8601 UTC last modification timestamp.
- `_v`: Internal revision counter.
- `_eeId`: Internal cloud row reference.

```javascript
const users = db.collection('users');

// INSERT: Auto-assigns valid 15-char PB ID if omitted
const alice = await users.insert({
  name: 'Alice Smith',
  email: 'alice@example.com',
  role: 'admin'
});
console.log(alice.id); // e.g. "m8x3z2a1b9q0p12"
console.log(alice.created); // "2026-09-04T12:00:00.000Z"

// READ BY ID (O(1) in-memory Map lookup)
const user = users.findById(alice.id);

// UPDATE: Shallow merges changes, updates 'updated' timestamp
const updated = await users.update(alice.id, {
  role: 'superadmin'
});

// UPSERT: Inserts if id does not exist, updates if it does (validates 15-char ID)
const bob = await users.upsert({
  id: 'usr000000000bob',
  name: 'Bob',
  email: 'bob@example.com'
});

// DELETE: Removes from RAM, cleans indexes, logs DELETE in WAL
const wasDeleted = await users.delete(alice.id); // returns boolean
```

---

## 5. PocketBase SDK Query Parity & Relation Expand

EchoDB supports the query and expansion methods of the official PocketBase SDK:

### `getOne(id, { expand })`
```javascript
const credits = db.collection('credits');

// Resolves customerId -> customers collection in RAM O(1)
const credit = credits.getOne('c8x3z2a1b9q0p12', { expand: 'customerId' });
console.log(credit.expand.customerId.name); // "Alice Smith"
```

### `getFirstListItem(filterOrField, value, { expand })`
```javascript
// By predicate function:
const firstAdmin = users.getFirstListItem(u => u.role === 'admin');

// By exact field and value:
const userByEmail = users.getFirstListItem('email', 'alice@example.com');

// By query object:
const leadDev = users.getFirstListItem({ role: 'dev', lead: true });
```

### `getFullList({ filter, sort, expand })`
```javascript
// Supports PocketBase sort format: '-field' (desc), '+field' or 'field' (asc), 'field:asc/desc'
const allCredits = credits.getFullList({
  sort: '-created',
  expand: 'customerId'
});
```

### `getList(page, perPage, { filter, sort, expand })`
```javascript
// Returns PocketBase paginated response structure:
const paged = credits.getList(1, 20, { sort: '-created' });
console.log(paged.page);       // 1
console.log(paged.perPage);    // 20
console.log(paged.totalItems); // e.g. 85
console.log(paged.totalPages); // 5
console.log(paged.items);      // array of documents
```

---

## 6. Secondary & Unique Indexes $O(1)$

```javascript
// Secondary index for fast O(1) lookup
db.createIndex('users', 'role');

// Unique index — enforces non-duplicate values in RAM O(1)
db.createIndex('users', 'email', { unique: true });
db.createIndex('customers', 'phone', { unique: true });

const users = db.collection('users');

// O(1) lookup
const adminList = users.findBy('role', 'admin');
const alice = users.findOneBy('email', 'alice@example.com');

// Inserting duplicate value throws [EchoDB] Unique constraint violation:
try {
  await users.insert({ name: 'Clone', email: 'alice@example.com' });
} catch (err) {
  // Thrown before modifying RAM or WAL
}
```

---

## 7. Lightweight Schemas & SQLite Zero-Values Coercion

Register lightweight schemas to guarantee SQLite compatibility (no `undefined`, typed defaults):

```javascript
db.defineSchema('customers', {
  name:   { type: 'text', required: true },
  phone:  { type: 'text', required: true, unique: true },
  points: { type: 'number', default: 0 },
  active: { type: 'bool', default: true },
  notes:  { type: 'text', default: '' },
  tier:   { type: 'select', options: ['REGULAR', 'VIP'], default: 'REGULAR' }
});

const customers = db.collection('customers');

// Missing fields automatically receive defaults/zero-values:
const cust = await customers.insert({ name: 'John Doe', phone: '5511223344' });
console.log(cust.points); // 0
console.log(cust.notes);  // ""
console.log(cust.tier);   // "REGULAR"

// Generate PocketBase migration code:
const migrationCode = db.generatePocketBaseMigration();
```

---

## 8. PocketBase Batch Export (`POST /api/batch`)

Export the database partitioned into chunks ready for PocketBase's transactional batch endpoint:

```javascript
const batches = db.exportPocketBaseBatch({ batchSize: 100 });

for (const batch of batches) {
  // Send directly to PocketBase
  await fetch(`${POCKETBASE_URL}/api/batch`, {
    method: 'POST',
    headers: {
      'Authorization': `AdminToken`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(batch)
  });
}
```

---

## 9. Atomic Transactions with Automatic Rollback

Transactions are atomic, thread-safe, and serialized. If any error occurs:
1. All RAM mutations across all collections are automatically reverted.
2. All secondary and unique indexes are restored to their pre-transaction state.
3. No WAL operations are flushed.

```javascript
try {
  await db.transaction(async (tx) => {
    const accounts = tx.collection('accounts');
    const transfers = tx.collection('transfers');

    const source = accounts.findById('acc000000000001');
    const target = accounts.findById('acc000000000002');

    if (!source || source.balance < 100) {
      throw new Error('Insufficient balance'); // Auto-triggers complete RAM rollback
    }

    await accounts.update(source.id, { balance: source.balance - 100 });
    await accounts.update(target.id, { balance: target.balance + 100 });
    await transfers.insert({
      from: source.id,
      to: target.id,
      amount: 100
    });
  });

  console.log('Transaction committed successfully.');
} catch (err) {
  console.error('Transaction failed and was safely rolled back:', err.message);
}
```

---

## 10. Critical Agent Rules & Checklist

When generating code or debugging with `@bridevmx/echodb`, ALWAYS check:

1. ⚠️ **Always `await db.init()`**: Never call collection methods before `db.init()` has resolved.
2. ⚠️ **Use Valid 15-char IDs if Manual**: If passing manual IDs, they must match `^[a-z0-9]{15}$`. Otherwise, omit `id` and allow EchoDB to generate one automatically.
3. ⚠️ **Canonical Timestamps**: Always read `.created` and `.updated`. Do NOT look for `_createdAt` or `_updatedAt`.
4. ⚠️ **Always declare indexes early**: Place `db.createIndex(col, field, opts)` right after `db.init()`.
5. ⚠️ **Singleton Pattern in Web Frameworks**: In Express, Fastify, Next.js, or Hono, initialize `EchoEntriesDB` once as a singleton module. Do NOT create a new instance on every HTTP request.
6. ⚠️ **Handle Graceful Shutdown**: Always attach `db.close()` to `SIGINT` and `SIGTERM` so pending WAL writes drain to the cloud.
7. ⚠️ **Transaction Scoping**: Inside `db.transaction(async (tx) => { ... })`, ALWAYS use the `tx` parameter (`tx.collection(...)`), never the outer `db` variable.
