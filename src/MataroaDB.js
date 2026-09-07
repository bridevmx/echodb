'use strict';

const path          = require('path');
const crypto        = require('crypto');
const MataroaClient = require('./MataroaClient');
const WAL           = require('./WAL');
const Collection    = require('./Collection');
const { encrypt, decrypt } = require('./crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
const COMPACT_EVERY    = 20;
const BATCH_SIZE       = 10;     // max parallel POSTs per drain cycle
const BATCH_WINDOW_MS  = 8;      // ms to wait for more ops to accumulate before flushing

const TAG_OP   = 'op';
const TAG_SNAP = 'snapshot';

let _slugSeq = 0;
function makeOpSlug(col) {
  _slugSeq++;
  const colHash = crypto.createHash('sha256').update(col).digest('hex').slice(0, 10);
  return `echodb-op-${Date.now()}-${_slugSeq}-${colHash}`;
}

function makeSnapSlug(col) {
  const colHash = crypto.createHash('sha256').update(col).digest('hex').slice(0, 16);
  return `echodb-snap-${colHash}`;
}

// ─────────────────────────────────────────────────────────────────────────────

class MataroaDB {
  /**
   * @param {object} opts
   * @param {string}  [opts.apiKey]             - Mataroa API key
   * @param {string}  [opts.username]           - For auto-login if apiKey not provided
   * @param {string}  [opts.password]           - For auto-login if apiKey not provided
   * @param {boolean} [opts.memoryOnly=false]   - offline/CI mode — no network, no WAL, no auth
   * @param {string}  [opts.encryptionSecret]    - inner encryption layer
   * @param {string}  [opts.walPath]            - path for Write-Ahead Log file
   * @param {number}  [opts.autoSyncMs=300000]  - 0 = off
   * @param {number}  [opts.compactEvery=20]    - ops before auto-compaction per col
   * @param {number}  [opts.batchSize=10]       - max ops per drain cycle
   * @param {number}  [opts.batchWindowMs=8]    - ms to accumulate ops before firing
   */
  constructor(opts = {}) {
    this._memoryOnly = Boolean(opts.memoryOnly);

    if (!this._memoryOnly && !opts.apiKey && (!opts.username || !opts.password)) {
      throw new Error('[MataroaDB] opts.apiKey or (opts.username and opts.password) is required (or set memoryOnly: true for offline mode).');
    }

    this._apiKey           = opts.apiKey ?? null;
    this._username         = opts.username ?? null;
    this._password         = opts.password ?? null;
    this._encryptionSecret = opts.encryptionSecret ?? null;
    this._walPath          = path.resolve(opts.walPath ?? './.echodb_mataroa_wal.json');
    this._autoSyncMs       = opts.autoSyncMs   ?? 300_000;
    this._compactEvery     = opts.compactEvery ?? COMPACT_EVERY;
    this._batchSize        = opts.batchSize    ?? BATCH_SIZE;
    this._batchWindowMs    = opts.batchWindowMs ?? BATCH_WINDOW_MS;

    this._client     = new MataroaClient({ apiKey: this._apiKey });
    this._wal        = new WAL(this._walPath);

    // ── RAM state ──────────────────────────────────────────────────────────
    this._stores     = new Map(); // col → Map<id, doc>
    this._snapSlug   = new Map(); // col → string (Mataroa page slug of current snapshot)
    this._opSlugs    = new Map(); // col → string[] (Mataroa page slugs of pending op-entries)
    this._opCount    = new Map(); // col → number of ops since last compaction

    // ── Secondary indexes ──────────────────────────────────────────────────
    this._indexes      = new Map(); // col → Map<field, Map<value, Set<id>>>
    this._uniqueFields = new Map(); // col → Set<field>
    this._schemas      = new Map(); // col → schemaDefinition

    // ── Drain & Mutex state ────────────────────────────────────────────────
    this._draining      = false;
    this._batchTimer    = null;
    this._syncTimer     = null;
    this._userKeyId     = null;
    this._txQueue       = Promise.resolve();
  }

  // ── Static helpers ─────────────────────────────────────────────────────────

  /**
   * Create a new Mataroa blog account programmatically and return its API key.
   *
   * @param {object} params
   * @param {string} params.username
   * @param {string} params.password
   * @param {string} [params.email]
   * @returns {Promise<{ username: string, email: string, apiKey: string, sessionid: string }>}
   */
  static async register({ username, password, email = '' } = {}) {
    return MataroaClient.register({ username, password, email });
  }

  /**
   * Log into an existing Mataroa blog account and retrieve its API key.
   *
   * @param {object} params
   * @param {string} params.username
   * @param {string} params.password
   * @returns {Promise<{ username: string, apiKey: string, sessionid: string }>}
   */
  static async login({ username, password } = {}) {
    return MataroaClient.login({ username, password });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    if (this._memoryOnly) {
      console.log('[MataroaDB] memoryOnly mode — skipping auth, WAL and network sync.');
      return this;
    }

    console.log('[MataroaDB] Initializing...');

    if (!this._apiKey) {
      if (!this._username || !this._password) {
        throw new Error('[MataroaDB] No apiKey provided and username/password missing.');
      }
      console.log(`[MataroaDB] Logging in as '${this._username}'...`);
      const auth = await MataroaClient.login({ username: this._username, password: this._password });
      this._apiKey = auth.apiKey;
      this._client.apiKey = auth.apiKey;
    }

    this._userKeyId = `mataroa:${this._username || this._apiKey.slice(0, 16)}`;

    this._wal.load();
    await this.sync();

    if (this._wal.length > 0) {
      console.log(`[MataroaDB] Draining ${this._wal.length} WAL op(s) from previous run...`);
      await this._drain();
    }

    if (this._autoSyncMs > 0) {
      this._syncTimer = setInterval(() => this.sync().catch(console.error), this._autoSyncMs);
      if (typeof this._syncTimer.unref === 'function') this._syncTimer.unref();
    }

    console.log('[MataroaDB] Ready.');
    return this;
  }

  async close() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (!this._memoryOnly) await this.flush();
    this._wal.clear();
    console.log('[MataroaDB] Closed.');
  }

  async flush() {
    if (this._batchTimer) {
      clearTimeout(this._batchTimer);
      this._batchTimer = null;
      await this._drain();
    }
    while (this._wal.length > 0 || this._draining) {
      await sleep(20);
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get (or create) a typed collection.
   * @param {string} name
   * @returns {Collection}
   */
  collection(name) {
    if (!this._stores.has(name))       this._stores.set(name, new Map());
    if (!this._indexes.has(name))      this._indexes.set(name, new Map());
    if (!this._uniqueFields.has(name)) this._uniqueFields.set(name, new Set());
    return new Collection(
      name,
      this._stores.get(name),
      (op) => this._enqueue(op),
      this._indexes.get(name),
      this._uniqueFields.get(name),
      this
    );
  }

  /**
   * Declare a secondary index on a collection field.
   * @param {string} colName
   * @param {string} field
   * @param {object} [opts]
   * @param {boolean} [opts.unique=false]
   */
  createIndex(colName, field, opts = {}) {
    if (!this._indexes.has(colName))       this._indexes.set(colName, new Map());
    if (!this._uniqueFields.has(colName))  this._uniqueFields.set(colName, new Set());

    const isUnique = Boolean(opts && opts.unique);
    if (isUnique) {
      this._uniqueFields.get(colName).add(field);
    }

    const colIndex = this._indexes.get(colName);
    if (colIndex.has(field)) return;

    const fieldIndex = new Map();
    const store = this._stores.get(colName);
    if (store) {
      for (const doc of store.values()) {
        const val = doc[field];
        if (val === undefined || val === null) continue;
        const key = String(val);
        if (!fieldIndex.has(key)) fieldIndex.set(key, new Set());
        fieldIndex.get(key).add(doc.id);
      }
    }
    colIndex.set(field, fieldIndex);
  }

  /**
   * Register a lightweight schema contract for a collection.
   * @param {string} colName
   * @param {object} schema
   */
  defineSchema(colName, schema) {
    if (!colName || typeof colName !== 'string') {
      throw new Error('[MataroaDB] defineSchema() requires a collection name string.');
    }
    if (!schema || typeof schema !== 'object') {
      throw new Error('[MataroaDB] defineSchema() requires a schema definition object.');
    }

    this._schemas.set(colName, schema);

    for (const [field, def] of Object.entries(schema)) {
      if (def && typeof def === 'object') {
        if (def.unique) {
          this.createIndex(colName, field, { unique: true });
        } else if (def.index) {
          this.createIndex(colName, field, { unique: false });
        }
      }
    }

    return this;
  }

  getSchema(colName) {
    return this._schemas.get(colName) ?? null;
  }

  /**
   * Generate a PocketBase (v0.23+) JS migration file script from registered schemas.
   * @param {object} [opts]
   * @returns {string}
   */
  generatePocketBaseMigration(opts = {}) {
    const lines = [
      `/// <reference path="../pb_data/types.d.ts" />`,
      `migrate((app) => {`
    ];

    for (const [colName, schema] of this._schemas) {
      lines.push(`  const ${colName} = new Collection({`);
      lines.push(`    name: ${JSON.stringify(colName)},`);
      lines.push(`    type: "base",`);
      lines.push(`    fields: [`);
      lines.push(`      { name: "id", type: "text", primaryKey: true, autogeneratePattern: "[a-z0-9]{15}" },`);

      for (const [fieldName, def] of Object.entries(schema)) {
        const pbType = mapToPbType(def.type);
        const fieldConfig = {
          name: fieldName,
          type: pbType,
          required: Boolean(def.required)
        };
        if (def.options && Array.isArray(def.options)) {
          fieldConfig.values = def.options;
        }
        if (def.collection) {
          fieldConfig.collectionId = def.collection;
        }
        lines.push(`      ${JSON.stringify(fieldConfig)},`);
      }

      lines.push(`      { name: "created", type: "autodate", onCreate: true },`);
      lines.push(`      { name: "updated", type: "autodate", onCreate: true, onUpdate: true }`);
      lines.push(`    ],`);

      const uniqueFields = this._uniqueFields.get(colName) || new Set();
      if (uniqueFields.size > 0) {
        lines.push(`    indexes: [`);
        for (const f of uniqueFields) {
          lines.push(`      "CREATE UNIQUE INDEX \`idx_${colName}_${f}\` ON \`${colName}\` (\`${f}\`);",`);
        }
        lines.push(`    ]`);
      } else {
        lines.push(`    indexes: []`);
      }

      lines.push(`  });`);
      lines.push(`  app.save(${colName});\n`);
    }

    lines.push(`}, (app) => {`);
    for (const colName of this._schemas.keys()) {
      lines.push(`  const collection = app.findCollectionByNameOrId(${JSON.stringify(colName)});`);
      lines.push(`  if (collection) app.delete(collection);`);
    }
    lines.push(`});\n`);

    return lines.join('\n');
  }

  /**
   * Atomic transaction — rolls back all RAM changes if fn throws.
   */
  async transaction(fn) {
    const execute = async () => {
      const storeSnap = new Map();
      for (const [col, store] of this._stores) storeSnap.set(col, new Map(store));

      const indexSnap = new Map();
      for (const [col, colIdx] of this._indexes) {
        const copy = new Map();
        for (const [field, fieldIdx] of colIdx) {
          const fcopy = new Map();
          for (const [val, ids] of fieldIdx) fcopy.set(val, new Set(ids));
          copy.set(field, fcopy);
        }
        indexSnap.set(col, copy);
      }

      const uniqueSnap = new Map();
      for (const [col, uSet] of this._uniqueFields) {
        uniqueSnap.set(col, new Set(uSet));
      }

      const buffer = [];
      const origEnqueue = this._enqueue.bind(this);
      this._enqueue = (op) => buffer.push(op);

      try {
        const result = await fn(this);
        this._enqueue = origEnqueue;
        for (const op of buffer) origEnqueue(op);
        return result;
      } catch (err) {
        this._enqueue = origEnqueue;
        for (const [col, snap] of storeSnap) {
          const live = this._stores.get(col);
          if (live) { live.clear(); for (const [k, v] of snap) live.set(k, v); }
          else this._stores.set(col, snap);
        }
        for (const [col, snapIdx] of indexSnap) {
          const liveIdx = this._indexes.get(col);
          if (liveIdx) {
            liveIdx.clear();
            for (const [field, fieldSnap] of snapIdx) liveIdx.set(field, fieldSnap);
          } else {
            this._indexes.set(col, snapIdx);
          }
        }
        for (const [col, snapUnique] of uniqueSnap) {
          const liveUnique = this._uniqueFields.get(col);
          if (liveUnique) {
            liveUnique.clear();
            for (const f of snapUnique) liveUnique.add(f);
          } else {
            this._uniqueFields.set(col, snapUnique);
          }
        }
        throw err;
      }
    };

    const next = this._txQueue.then(execute, execute);
    this._txQueue = next.catch(() => {});
    return next;
  }

  /**
   * Export database collections to JSON.
   */
  exportJSON(opts = {}) {
    const stringify   = opts.stringify !== false;
    const pretty      = Boolean(opts.pretty);
    const excludeMeta = Boolean(opts.excludeMeta);
    const filterCols  = Array.isArray(opts.collections) ? new Set(opts.collections) : null;

    const collectionsObj = {};
    for (const [colName, store] of this._stores) {
      if (filterCols && !filterCols.has(colName)) continue;
      collectionsObj[colName] = [...store.values()].map(doc => {
        if (!excludeMeta) return { ...doc };
        const { _v, _eeId, _col, _id, _type, _op, _createdAt, _updatedAt, ...clean } = doc;
        return clean;
      });
    }

    const payload = {
      version:     1,
      exportedAt:  new Date().toISOString(),
      collections: collectionsObj
    };

    return stringify ? JSON.stringify(payload, null, pretty ? 2 : undefined) : payload;
  }

  /**
   * Export records partitioned into chunks formatted for PocketBase's POST /api/batch.
   */
  exportPocketBaseBatch(opts = {}) {
    const batchSize = opts.batchSize || 100;
    const filterCols = Array.isArray(opts.collections) ? new Set(opts.collections) : null;
    const batches = [];
    let currentRequests = [];

    for (const [colName, store] of this._stores) {
      if (filterCols && !filterCols.has(colName)) continue;
      for (const doc of store.values()) {
        const { _v, _eeId, _col, _id, _type, _op, _createdAt, _updatedAt, ...body } = doc;
        currentRequests.push({
          action: 'create',
          collection: colName,
          body
        });

        if (currentRequests.length >= batchSize) {
          batches.push({ requests: currentRequests });
          currentRequests = [];
        }
      }
    }

    if (currentRequests.length > 0) {
      batches.push({ requests: currentRequests });
    }

    return batches;
  }

  /**
   * Atomically import JSON database dump across collections.
   */
  async importJSON(data, opts = {}) {
    const mode       = opts.mode ?? 'upsert';
    const filterCols = Array.isArray(opts.collections) ? new Set(opts.collections) : null;

    let parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('[MataroaDB] importJSON() invalid payload.');
    }

    const collectionsSource = parsed.collections && typeof parsed.collections === 'object' && !Array.isArray(parsed.collections)
      ? parsed.collections
      : parsed;

    return this.transaction(async (tx) => {
      const imported = {};
      let total = 0;

      for (const [colName, docs] of Object.entries(collectionsSource)) {
        if (filterCols && !filterCols.has(colName)) continue;
        if (!Array.isArray(docs)) continue;

        const col = tx.collection(colName);
        const result = await col.importJSON(docs, { mode });
        imported[colName] = result.imported;
        total += result.imported;
      }

      return { imported, total };
    });
  }

  // ── Sync & Cloud Operations ────────────────────────────────────────────────

  async sync() {
    const pages = await this._client.listPages();
    const echodbPages = pages.filter(p => p.slug && p.slug.startsWith('echodb-'));
    await this._rebuildFromPages(echodbPages);

    // Rebuild declared indexes
    for (const [col, colIdx] of this._indexes) {
      const uFields = this._uniqueFields.get(col) || new Set();
      for (const field of colIdx.keys()) {
        colIdx.delete(field);
        this.createIndex(col, field, { unique: uFields.has(field) });
      }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────────────

  _encrypt(payload) {
    return encrypt(JSON.stringify(payload), this._userKeyId, this._encryptionSecret);
  }

  async _decrypt(cipherB64) {
    const plain = await decrypt(cipherB64, this._userKeyId, this._encryptionSecret);
    return JSON.parse(plain);
  }

  // ── Write Drainage & Background Flushing ──────────────────────────────────

  _enqueue(op) {
    if (this._memoryOnly) return;

    this._wal.push(op);

    if (!this._batchTimer && !this._draining) {
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        this._drain().catch(console.error);
      }, this._batchWindowMs);
    }
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;

    while (this._wal.length > 0) {
      const batch = this._wal.queue.slice(0, this._batchSize);

      try {
        await this._persistBatch(batch);

        for (let i = 0; i < batch.length; i++) this._wal.shift();

        const colsToCompact = new Set();
        for (const op of batch) {
          const count = (this._opCount.get(op.col) ?? 0) + 1;
          this._opCount.set(op.col, count);
          if (count >= this._compactEvery) colsToCompact.add(op.col);
        }

        if (colsToCompact.size > 0) {
          await Promise.all(
            [...colsToCompact].map(col =>
              this._compact(col).catch(e =>
                console.error('[MataroaDB] Compaction error:', e.message)
              )
            )
          );
        }

      } catch (err) {
        console.error(`[MataroaDB] Batch persist failed (retrying in 5s): ${err.message}`);
        await sleep(5000);
      }
    }

    this._draining = false;
  }

  async _persistBatch(ops) {
    // Write each op as a hidden page in Mataroa in parallel
    await Promise.all(
      ops.map(async (op) => {
        const slug = makeOpSlug(op.col);
        const encrypted = await this._encrypt({
          _type: TAG_OP,
          _col:  op.col,
          _op:   op.type,
          _id:   op.doc.id,
          _v:    op.doc._v,
          doc:   op.doc
        });

        await this._client.createPage({
          title: 'Entry',
          slug,
          body: encrypted,
          is_hidden: true
        });

        const slugs = this._opSlugs.get(op.col) ?? [];
        slugs.push(slug);
        this._opSlugs.set(op.col, slugs);
      })
    );
  }

  async _compact(col) {
    const store = this._stores.get(col);
    if (!store) return;

    const snapSlug = makeSnapSlug(col);
    const snapPayload = {
      _type: TAG_SNAP,
      _col:  col,
      _v:    this._opCount.get(col) ?? 0,
      docs:  Object.fromEntries(store)
    };

    const encrypted = await this._encrypt(snapPayload);
    const existingSnapSlug = this._snapSlug.get(col);
    const opSlugs = this._opSlugs.get(col) ?? [];

    const updateSnapshot = existingSnapSlug
      ? this._client.updatePage(existingSnapSlug, { body: encrypted, is_hidden: true })
      : this._client.createPage({
          title: 'Store',
          slug: snapSlug,
          body: encrypted,
          is_hidden: true
        });

    await Promise.all([
      updateSnapshot,
      ...opSlugs.map(slug => this._client.deletePage(slug).catch(() => {}))
    ]);

    this._snapSlug.set(col, snapSlug);
    this._opSlugs.set(col, []);
    this._opCount.set(col, 0);

    console.log(`[MataroaDB] '${col}' compacted — ${opSlugs.length} op-page(s) removed.`);
  }

  async _rebuildFromPages(pages) {
    // Decrypt all pages in parallel
    const decrypted = await Promise.all(
      pages.map(async page => {
        try {
          const payload = await this._decrypt(page.body);
          return { page, payload };
        } catch {
          return null; // Not our encrypted page or invalid format
        }
      })
    );

    const snapshots = new Map();
    const ops       = new Map();

    for (const item of decrypted) {
      if (!item) continue;
      const { page, payload } = item;
      if (!payload._col || !payload._type) continue;
      const col = payload._col;

      if (payload._type === TAG_SNAP) {
        const existing = snapshots.get(col);
        if (!existing || (payload._v ?? 0) > (existing.v ?? 0)) {
          snapshots.set(col, { page, payload, v: payload._v ?? 0 });
        }
      } else if (payload._type === TAG_OP) {
        if (!ops.has(col)) ops.set(col, []);
        ops.get(col).push({ page, payload });
      }
    }

    const allCols = new Set([...snapshots.keys(), ...ops.keys()]);

    for (const col of allCols) {
      if (!this._stores.has(col))  this._stores.set(col, new Map());
      if (!this._indexes.has(col)) this._indexes.set(col, new Map());
      const store = this._stores.get(col);
      store.clear();

      const snap = snapshots.get(col);
      if (snap) {
        this._snapSlug.set(col, snap.page.slug);
        for (const [id, doc] of Object.entries(snap.payload.docs ?? {})) {
          store.set(id, doc);
        }
      }

      const colOps = ops.get(col) ?? [];
      const storedOpSlugs = [];

      // Sort ops by creation / slug to apply in order
      colOps.sort((a, b) => (a.page.slug < b.page.slug ? -1 : 1));

      for (const { page, payload } of colOps) {
        storedOpSlugs.push(page.slug);
        const { _op, _id, doc } = payload;
        if (!_id) continue;
        if (_op === 'INSERT' || _op === 'UPDATE') {
          const existing = store.get(_id);
          if (!existing || (doc?._v ?? 0) >= (existing._v ?? 0)) {
            store.set(_id, doc ?? {});
          }
        } else if (_op === 'DELETE') {
          store.delete(_id);
        }
      }

      this._opSlugs.set(col, storedOpSlugs);
      this._opCount.set(col, storedOpSlugs.length);
    }
  }
}

function mapToPbType(type) {
  switch (type) {
    case 'number':
    case 'int':
    case 'float':
      return 'number';
    case 'bool':
    case 'boolean':
      return 'bool';
    case 'json':
      return 'json';
    case 'relation':
      return 'relation';
    case 'select':
      return 'select';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'date':
    case 'datetime':
      return 'date';
    case 'text':
    case 'string':
    default:
      return 'text';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = MataroaDB;
