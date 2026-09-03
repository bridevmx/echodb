# @isclaudeia/echo-entries-db

> RAM-first document database backed by **Echo Entries**.  
> Zero-dependency · Append-only log · Atomic transactions · Auto-compaction · TypeScript types included.

[![npm](https://img.shields.io/npm/v/@isclaudeia/echo-entries-db)](https://www.npmjs.com/package/@isclaudeia/echo-entries-db)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## What is it?

`@isclaudeia/echo-entries-db` turns your [Echo Entries](https://echo-entries.com) account into a
cloud-persisted NoSQL document database.

| Feature | Detail |
|---|---|
| **RAM-first reads** | All queries served from an in-memory Map. **0 ms**, no network. |
| **Append-only event log** | Writes are stored as immutable entries — multiple Node.js instances write concurrently without conflicts. |
| **Atomic transactions** | Automatic RAM rollback if any operation inside `transaction()` throws. |
| **WAL on disk** | Write-Ahead Log guarantees zero data loss across server restarts. |
| **Auto-compaction** | Op-entries are periodically merged into a single snapshot to keep EE storage flat. |
| **Zero dependency** | Only Node.js built-ins (`fs`, `crypto`). No npm packages required. |
| **TypeScript types** | Full type definitions included (`index.d.ts`). Generic per collection. |

---

## Installation

```bash
npm install @isclaudeia/echo-entries-db
```

**Requirements:** Node.js `>= 18` · An active [Echo Entries](https://echo-entries.com) account.

---

## Quick start

```js
const { EchoEntriesDB } = require('@isclaudeia/echo-entries-db');

const db = new EchoEntriesDB({
  email:    process.env.EE_EMAIL,
  password: process.env.EE_PASSWORD,
});

await db.init();

const posts = db.collection('posts');

// INSERT — id auto-generated (UUIDv4) if not provided
const post = await posts.insert({ title: 'Hello world', published: false });

// READS — served from RAM, ~0 ms
posts.findById(post.id);
posts.find(p => p.published);
posts.findOne(p => p.title.startsWith('Hello'));
posts.all();
posts.count(p => !p.published);

// UPDATE — shallow merge, _v increments
await posts.update(post.id, { published: true });

// UPSERT
await posts.upsert({ id: 'slug-hello', title: 'Hello world', published: true });

// DELETE
await posts.delete(post.id);

// ATOMIC TRANSACTION
await db.transaction(async (tx) => {
  const accounts = tx.collection('accounts');
  const a = accounts.findById('acc_A');
  const b = accounts.findById('acc_B');
  if (a.balance < 100) throw new Error('Insufficient funds'); // → rollback
  await accounts.update('acc_A', { balance: a.balance - 100 });
  await accounts.update('acc_B', { balance: b.balance + 100 });
});

await db.close();
```

---

## API Reference

### `new EchoEntriesDB(opts)`

| Option | Type | Default | Description |
|---|---|---|---|
| `email` | `string` | required | Echo Entries account email. |
| `password` | `string` | required | Echo Entries account password. |
| `walPath` | `string` | `./.echodb_wal.json` | Local WAL file path. |
| `autoSyncMs` | `number` | `300000` | Periodic sync interval in ms (0 = disabled). |
| `compactEvery` | `number` | `20` | Op-entries written before auto-compaction per collection. |
| `requestDelayMs` | `number` | `80` | Delay between sequential HTTP requests (rate-limit safety). |

### Engine methods

| Method | Returns | Description |
|---|---|---|
| `db.init()` | `Promise<this>` | Authenticate, load WAL, sync from EE, drain pending ops. |
| `db.close()` | `Promise<void>` | Flush all ops and close. |
| `db.flush()` | `Promise<void>` | Wait until the WAL queue is fully drained. |
| `db.sync()` | `Promise<void>` | Re-sync from EE into RAM. |
| `db.collection(name)` | `Collection` | Get or lazily create a collection. |
| `db.transaction(fn)` | `Promise<R>` | Atomic transaction with automatic rollback. |

### `Collection` methods

#### Reads (RAM, ~0 ms)

| Method | Description |
|---|---|
| `col.findById(id)` | Find by id. Returns `doc \| null`. |
| `col.find(predicate?)` | Filter by predicate. Returns `doc[]`. |
| `col.findOne(predicate)` | First match or `null`. |
| `col.all()` | All documents. |
| `col.count(predicate?)` | Count (optionally filtered). |

#### Writes (RAM-immediate + async persist to EE)

| Method | Description |
|---|---|
| `col.insert(doc)` | Insert. Auto-generates UUIDv4 `id` if not provided. |
| `col.update(id, updates)` | Shallow merge update. Throws if not found. |
| `col.upsert(doc)` | Insert if not exists, update if exists. Requires `id`. |
| `col.delete(id)` | Delete. Returns `true` if existed. |

Every document gets automatic metadata fields:

```js
{
  id:         string,   // document id
  _v:         number,   // version (increments on each update)
  _createdAt: string,   // ISO 8601
  _updatedAt: string,   // ISO 8601
}
```

---

## Architecture

### Write path

```
col.insert(doc)
  │
  ├── 1. Apply to RAM Map immediately  (0 ms)
  ├── 2. Push to WAL on disk           (sync write, ~0.1 ms)
  └── 3. Background drain:
           POST to Echo Entries        (~100 ms, non-blocking)
           Every 20 ops → compact:
             PATCH snapshot row
             DELETE old op-entries
```

### Sync path (on `init()` / `db.sync()`)

```
GET all journal_entries (paginated, 1000/page)
  │
  ├── Find latest snapshot per collection → load docs into RAM
  └── Replay op-entries newer than snapshot → apply in creation order
```

### Compaction

Every `compactEvery` writes (default: 20), the engine:

1. Writes (or patches) a single **snapshot** entry containing all current documents.
2. Deletes all op-entries now folded into the snapshot.

This keeps the total number of EE rows constant regardless of write volume.

---

## Ideal use cases

✅ Blog / portfolio / headless CMS  
✅ App configuration stored in the cloud  
✅ Personal or small-team tools  
✅ MVPs that need cloud persistence without a dedicated database  

---

## Environment variables (recommended)

```bash
# .env
EE_EMAIL=your@email.com
EE_PASSWORD=yourpassword
```

```js
const db = new EchoEntriesDB({
  email:    process.env.EE_EMAIL,
  password: process.env.EE_PASSWORD,
});
```

---

## License

[MIT](./LICENSE) © 2026 isclaudeia
