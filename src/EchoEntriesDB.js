'use strict';

const path        = require('path');
const HttpClient  = require('./http');
const WAL         = require('./WAL');
const Collection  = require('./Collection');
const { encrypt, decrypt } = require('./crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE        = 1000;
const COMPACT_EVERY    = 20;
const DEFAULT_DELAY    = 0;      // batch mode: no inter-request delay needed
const BATCH_SIZE       = 10;     // max parallel POSTs per drain cycle
const BATCH_WINDOW_MS  = 8;      // ms to wait for more ops to accumulate before flushing

// journal_entries fields — match EE UI exactly
const EE_MOOD     = 'neutral';
const EE_STATUS   = 'published';
const EE_TIMEZONE = 'UTC';

const TAG_OP   = 'op';
const TAG_SNAP = 'snapshot';

// Monotonic counter — avoids UNIQUE(user_id, status, timestamp_started) conflicts
let _tsSeq = 0;
function makeTimestamp() {
  _tsSeq++;
  return new Date(Date.now() + _tsSeq).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────

class EchoEntriesDB {
  /**
   * @param {object} opts
   * @param {string}  [opts.email]
   * @param {string}  [opts.password]
   * @param {boolean} [opts.memoryOnly=false]      offline/CI mode — no network, no WAL, no auth
   * @param {string}  [opts.encryptionSecret]   inner encryption layer
   * @param {string}  [opts.walPath]
   * @param {number}  [opts.autoSyncMs]          0 = off
   * @param {number}  [opts.compactEvery]        ops before auto-compaction per col
   * @param {number}  [opts.batchSize]           max ops per bulk POST
   * @param {number}  [opts.batchWindowMs]       ms to accumulate ops before firing
   * @param {number}  [opts.requestDelayMs]      legacy single-op delay (ignored in batch mode)
   */
  constructor(opts = {}) {
    this._memoryOnly = Boolean(opts.memoryOnly);

    if (!this._memoryOnly && (!opts.email || !opts.password)) {
      throw new Error('[EchoEntriesDB] opts.email and opts.password are required (or set memoryOnly: true for offline mode).');
    }

    this._email            = opts.email;
    this._password         = opts.password;
    this._encryptionSecret = opts.encryptionSecret ?? null;
    this._walPath          = path.resolve(opts.walPath ?? './.echodb_wal.json');
    this._autoSyncMs       = opts.autoSyncMs   ?? 300_000;
    this._compactEvery     = opts.compactEvery ?? COMPACT_EVERY;
    this._batchSize        = opts.batchSize    ?? BATCH_SIZE;
    this._batchWindowMs    = opts.batchWindowMs ?? BATCH_WINDOW_MS;

    this._http       = new HttpClient();
    this._wal        = new WAL(this._walPath);

    // ── RAM state ──────────────────────────────────────────────────────────
    this._stores   = new Map(); // col → Map<id, doc>
    this._snapEeId = new Map(); // col → EE row id of current snapshot
    this._opEeIds  = new Map(); // col → string[]  EE row ids of pending op-entries
    this._opCount  = new Map(); // col → number of ops since last compaction

    // ── Secondary indexes ──────────────────────────────────────────────────
    // col → Map<field, Map<value, Set<id>>>
    this._indexes      = new Map();
    this._uniqueFields = new Map(); // col → Set<field>
    this._schemas      = new Map(); // col → schemaDefinition

    // ── Drain & Mutex state ────────────────────────────────────────────────
    this._draining      = false;
    this._batchTimer    = null; // setTimeout handle for batch window
    this._syncTimer     = null;
    this._userId        = null;
    this._txQueue       = Promise.resolve();
  }

  // ── Static helpers ─────────────────────────────────────────────────────────

  /**
   * Create a new Echo Entries account without needing an existing db instance.
   *
   * Note: Echo Entries requires email confirmation before login works.
   * If emailConfirmationRequired is true, the user must click the link
   * in their inbox before calling db.init().
   *
   * @param {object} opts
   * @param {string} opts.email
   * @param {string} opts.password
   * @param {string} [opts.firstName]
   * @param {string} [opts.lastName]
   * @returns {Promise<{user, session, emailConfirmationRequired: boolean}>}
   */
  static async register({ email, password, firstName = '', lastName = '' } = {}) {
    if (!email || !password) throw new Error('[EchoEntriesDB] register() requires email and password.');
    const http = new HttpClient();
    const data = await http.signup(email, password, { firstName, lastName });
    const emailConfirmationRequired = !data.access_token || !data.session;
    return {
      user:                     data.user ?? null,
      session:                  data.session ?? null,
      emailConfirmationRequired
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    if (this._memoryOnly) {
      console.log('[EchoEntriesDB] memoryOnly mode — skipping auth, WAL and network sync.');
      return this;
    }
    console.log('[EchoEntriesDB] Initializing...');
    const authData = await this._http.login(this._email, this._password);
    this._userId = authData.user?.id;
    if (!this._userId) throw new Error('[EchoEntriesDB] Could not read user id from auth response.');

    this._wal.load();
    await this.sync();

    if (this._wal.length > 0) {
      console.log(`[EchoEntriesDB] Draining ${this._wal.length} WAL op(s) from previous run...`);
      await this._drain();
    }

    if (this._autoSyncMs > 0) {
      this._syncTimer = setInterval(() => this.sync().catch(console.error), this._autoSyncMs);
      // .unref() prevents the timer from keeping the Node.js process alive in
      // CLI scripts and test runners (Jest, Vitest, Mocha) that don't call close().
      if (typeof this._syncTimer.unref === 'function') this._syncTimer.unref();
    }

    console.log('[EchoEntriesDB] Ready.');
    return this;
  }

  async close() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
    if (!this._memoryOnly) await this.flush();
    this._wal.clear();
    console.log('[EchoEntriesDB] Closed.');
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
   * Must be called before inserting documents (or after a sync).
   *
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
    if (colIndex.has(field)) return; // already exists

    // Build index from current RAM state
    const fieldIndex = new Map(); // value → Set<id>
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
   * Enables automatic SQLite zero-value coercion, validation, and PocketBase migration generation.
   * Also automatically registers unique indexes for fields with `unique: true`.
   *
   * @param {string} colName
   * @param {Record<string, { type: string, required?: boolean, default?: any, unique?: boolean, options?: string[], collection?: string }>} schema
   */
  defineSchema(colName, schema) {
    if (!colName || typeof colName !== 'string') {
      throw new Error('[EchoDB] defineSchema() requires a collection name string.');
    }
    if (!schema || typeof schema !== 'object') {
      throw new Error('[EchoDB] defineSchema() requires a schema definition object.');
    }

    this._schemas.set(colName, schema);

    // Auto-register indexes for unique or indexed fields
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

  /**
   * Get the registered schema definition for a collection.
   * @param {string} colName
   * @returns {object|null}
   */
  getSchema(colName) {
    return this._schemas.get(colName) ?? null;
  }

  /**
   * Generate a PocketBase (v0.23+) JS migration file script from registered schemas.
   *
   * @param {object} [opts]
   * @param {string} [opts.migrationName]
   * @returns {string} PocketBase JS migration script
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
   * WAL ops only committed on success.
   * Concurrent transactions are serialized safely via FIFO queue to guarantee atomic isolation.
   */
  async transaction(fn) {
    const execute = async () => {
      // Snapshot RAM stores + indexes + unique fields
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
        // Rollback RAM — mutate existing Maps in-place so external Collection
        // references (which point directly to the Map object) stay valid.
        this._enqueue = origEnqueue;
        for (const [col, snap] of storeSnap) {
          const live = this._stores.get(col);
          if (live) { live.clear(); for (const [k, v] of snap) live.set(k, v); }
          else this._stores.set(col, snap);
        }
        // Rollback indexes in-place too
        for (const [col, snapIdx] of indexSnap) {
          const liveIdx = this._indexes.get(col);
          if (liveIdx) {
            liveIdx.clear();
            for (const [field, fieldSnap] of snapIdx) liveIdx.set(field, fieldSnap);
          } else {
            this._indexes.set(col, snapIdx);
          }
        }
        // Rollback unique field sets
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
   * Export all (or selected) database collections to JSON.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.collections]      Subset of collection names to export (default: all)
   * @param {boolean}  [opts.pretty=false]     Format JSON with 2-space indentation
   * @param {boolean}  [opts.stringify=true]    Return JSON string (true) or plain JS object (false)
   * @param {boolean}  [opts.excludeMeta=false] Omit internal metadata fields (_v, _eeId)
   * @returns {string|object}
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
   * Export all database records partitioned into chunks formatted for PocketBase's
   * transactional batch endpoint (POST /api/batch, introduced in v0.22+).
   *
   * @param {object} [opts]
   * @param {number} [opts.batchSize=100] Maximum operations per batch request
   * @param {string[]} [opts.collections] Optional subset of collections to export
   * @returns {Array<{ requests: Array<{ action: 'create', collection: string, body: object }> }>}
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
   * Atomically import JSON database dump across one or multiple collections.
   * Runs inside an atomic transaction — full rollback if any error occurs.
   *
   * @param {string|object} data - JSON string or object { collections: { colName: doc[] } } or { colName: doc[] }
   * @param {object} [opts]
   * @param {'upsert'|'overwrite'|'insert'} [opts.mode='upsert']
   * @param {string[]} [opts.collections] - Optional subset of collections to import
   * @returns {Promise<{imported: Record<string, number>, total: number}>}
   */
  async importJSON(data, opts = {}) {
    const mode       = opts.mode ?? 'upsert';
    const filterCols = Array.isArray(opts.collections) ? new Set(opts.collections) : null;

    let parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('[EchoEntriesDB] importJSON() invalid payload.');
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

  async sync() {
    const rows = await this._fetchAllRows();
    await this._rebuildFromRows(rows);
    // Rebuild all declared indexes after sync
    for (const [col, colIdx] of this._indexes) {
      const uFields = this._uniqueFields.get(col) || new Set();
      for (const field of colIdx.keys()) {
        colIdx.delete(field); // clear and rebuild
        this.createIndex(col, field, { unique: uFields.has(field) });
      }
    }
  }

  // ── Encryption ─────────────────────────────────────────────────────────────

  _encrypt(payload) {
    return encrypt(JSON.stringify(payload), this._userId, this._encryptionSecret);
  }

  async _decrypt(cipherB64) {
    const plain = await decrypt(cipherB64, this._userId, this._encryptionSecret);
    return JSON.parse(plain);
  }

  // ── OPTIMIZATION 1: Batch writes ───────────────────────────────────────────
  //
  // Instead of one sequential POST per op, we:
  //   1. Accept ops into the WAL immediately (durability).
  //   2. Wait up to batchWindowMs for more ops to accumulate.
  //   3. Encrypt all pending ops in parallel (Promise.all).
  //   4. POST all in parallel in chunks of batchSize.
  //
  // Result: N ops take ~same wall-clock time as 1 op (bounded by batchSize).

  _enqueue(op) {
    // In memoryOnly mode ops are applied to RAM only — no WAL, no network drain
    if (this._memoryOnly) return;

    this._wal.push(op);

    // Schedule a drain after the batch window if not already scheduled
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
      // Take up to batchSize ops from the front of the WAL
      const batch = this._wal.queue.slice(0, this._batchSize);

      try {
        await this._persistBatch(batch);

        // Remove persisted ops from WAL
        for (let i = 0; i < batch.length; i++) this._wal.shift();

        // Update op counters and trigger compaction per collection
        const colsToCompact = new Set();
        for (const op of batch) {
          const count = (this._opCount.get(op.col) ?? 0) + 1;
          this._opCount.set(op.col, count);
          if (count >= this._compactEvery) colsToCompact.add(op.col);
        }

        // OPTIMIZATION 3: compact all affected collections in parallel
        if (colsToCompact.size > 0) {
          await Promise.all(
            [...colsToCompact].map(col =>
              this._compact(col).catch(e =>
                console.error('[EchoEntriesDB] Compaction error:', e.message)
              )
            )
          );
        }

      } catch (err) {
        console.error(`[EchoEntriesDB] Batch persist failed (retrying in 5s): ${err.message}`);
        await sleep(5000);
      }
    }

    this._draining = false;
  }

  // ── Echo Entries persistence ───────────────────────────────────────────────

  /**
   * Persist a batch of ops to EE in a single bulk POST request.
   * PostgREST accepts a JSON array body and returns one row per inserted entry,
   * reducing N round-trips to exactly 1 regardless of batch size.
   */
  async _persistBatch(ops) {
    // Step 1: encrypt all ops in parallel
    const encrypted = await Promise.all(
      ops.map(op => this._encrypt({
        _type: TAG_OP,
        _col:  op.col,
        _op:   op.type,
        _id:   op.doc.id,
        _v:    op.doc._v,
        doc:   op.doc
      }))
    );

    // Step 2: single bulk POST — PostgREST accepts a JSON array of rows
    const bodies = encrypted.map(entryText => ({
      user_id:           this._userId,
      entry_text:        entryText,
      mood:              EE_MOOD,
      status:            EE_STATUS,
      timezone:          EE_TIMEZONE,
      timestamp_started: makeTimestamp()
    }));

    const { data } = await this._http.request('POST', '', bodies);

    // Step 3: backfill EE row ids in RAM (bulk response is an ordered array)
    const rows = Array.isArray(data) ? data : (data ? [data] : []);
    for (let i = 0; i < ops.length; i++) {
      const op  = ops[i];
      const row = rows[i];
      if (!row?.id) continue;

      const ids = this._opEeIds.get(op.col) ?? [];
      ids.push(row.id);
      this._opEeIds.set(op.col, ids);

      // Backfill _eeId in RAM
      const store = this._stores.get(op.col);
      if (store && op.type !== 'DELETE') {
        const current = store.get(op.doc.id);
        if (current) store.set(op.doc.id, { ...current, _eeId: row.id });
      }
    }
  }

  // ── OPTIMIZATION 3: Aggressive compaction ─────────────────────────────────
  //
  // After compaction the collection is represented by exactly 1 EE row
  // (the snapshot). On the next sync, we only need to decrypt 1 entry per
  // collection regardless of how many ops have been written.
  //
  // Additionally, we compact ALL affected collections in parallel (see _drain).

  async _compact(col) {
    const store = this._stores.get(col);
    if (!store) return;

    // Encrypt snapshot
    const snapPayload = {
      _type: TAG_SNAP,
      _col:  col,
      _v:    this._opCount.get(col) ?? 0,
      docs:  Object.fromEntries(store)
    };
    const entryText      = await this._encrypt(snapPayload);
    const existingSnapId = this._snapEeId.get(col);

    // Write snapshot + delete ops in parallel where possible
    const opIds = this._opEeIds.get(col) ?? [];

    const [snapResult] = await Promise.all([
      // Write/update snapshot
      existingSnapId
        ? this._http.request('PATCH', `?id=eq.${existingSnapId}`,
            { entry_text: entryText, updated_at: new Date().toISOString() }, 'return=minimal')
        : this._http.request('POST', '', {
            user_id: this._userId, entry_text: entryText,
            mood: EE_MOOD, status: EE_STATUS, timezone: EE_TIMEZONE,
            timestamp_started: makeTimestamp()
          }),
      // Delete all op-entries in parallel
      ...opIds.map(eeId =>
        this._http.request('DELETE', `?id=eq.${eeId}`, null, 'return=minimal')
      )
    ]);

    // Register new snapshot row id if this was a POST
    if (!existingSnapId) {
      const row = Array.isArray(snapResult.data) ? snapResult.data[0] : snapResult.data;
      if (row?.id) this._snapEeId.set(col, row.id);
    }

    this._opEeIds.set(col, []);
    this._opCount.set(col, 0);
    console.log(`[EchoEntriesDB] '${col}' compacted — ${opIds.length} op-entries removed.`);
  }

  // ── Sync internals ─────────────────────────────────────────────────────────

  async _fetchAllRows() {
    const rows = [];
    let offset = 0;
    while (true) {
      const { data } = await this._http.request(
        'GET',
        `?status=eq.${EE_STATUS}&select=id,entry_text,created_at&order=created_at.asc&limit=${PAGE_SIZE}&offset=${offset}`,
        null,
        'count=none'
      );
      const batch = Array.isArray(data) ? data : [];
      rows.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
    return rows;
  }

  async _rebuildFromRows(rows) {
    // OPTIMIZATION 3: decrypt all rows in parallel
    const decrypted = await Promise.all(
      rows.map(async row => {
        try {
          const payload = await this._decrypt(row.entry_text);
          return { row, payload };
        } catch {
          return null; // not our entry
        }
      })
    );

    const snapshots = new Map();
    const ops       = new Map();

    for (const item of decrypted) {
      if (!item) continue;
      const { row, payload } = item;
      if (!payload._col || !payload._type) continue;
      const col = payload._col;

      if (payload._type === TAG_SNAP) {
        const existing = snapshots.get(col);
        if (!existing || (payload._v ?? 0) > (existing.v ?? 0)) {
          snapshots.set(col, { row, payload, v: payload._v ?? 0 });
        }
      } else if (payload._type === TAG_OP) {
        if (!ops.has(col)) ops.set(col, []);
        ops.get(col).push({ row, payload });
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
        this._snapEeId.set(col, snap.row.id);
        for (const [id, doc] of Object.entries(snap.payload.docs ?? {})) {
          store.set(id, doc);
        }
      }

      const colOps = ops.get(col) ?? [];
      const opIds  = [];
      for (const { row, payload } of colOps) {
        opIds.push(row.id);
        const { _op, _id, doc } = payload;
        if (!_id) continue;
        if (_op === 'INSERT' || _op === 'UPDATE') {
          const existing = store.get(_id);
          if (!existing || (doc?._v ?? 0) >= (existing._v ?? 0)) {
            store.set(_id, { ...(doc ?? {}), _eeId: row.id });
          }
        } else if (_op === 'DELETE') {
          store.delete(_id);
        }
      }

      this._opEeIds.set(col, opIds);
      this._opCount.set(col, opIds.length);
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

module.exports = EchoEntriesDB;
