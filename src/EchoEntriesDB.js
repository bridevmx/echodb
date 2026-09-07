'use strict';

const path          = require('path');
const crypto        = require('crypto');
const HttpClient    = require('./http');
const MataroaClient = require('./MataroaClient');
const WAL           = require('./WAL');
const Collection    = require('./Collection');
const { encrypt, decrypt } = require('./crypto');

// ── Constants ─────────────────────────────────────────────────────────────────
const PAGE_SIZE        = 1000;
const COMPACT_EVERY    = 20;
const BATCH_SIZE       = 10;     // max parallel POSTs per drain cycle
const BATCH_WINDOW_MS  = 8;      // ms to wait for more ops to accumulate before flushing

// Echo Entries fields (Backup host)
const EE_MOOD     = 'neutral';
const EE_STATUS   = 'published';
const EE_TIMEZONE = 'UTC';

const TAG_OP   = 'op';
const TAG_SNAP = 'snapshot';

// Monotonic counters
let _tsSeq = 0;
function makeTimestamp() {
  _tsSeq++;
  return new Date(Date.now() + _tsSeq).toISOString();
}

let _slugSeq = 0;
function makeMataroaOpSlug(col) {
  _slugSeq++;
  const colHash = crypto.createHash('sha256').update(col).digest('hex').slice(0, 10);
  return `echodb-op-${Date.now()}-${_slugSeq}-${colHash}`;
}

function makeMataroaSnapSlug(col) {
  const colHash = crypto.createHash('sha256').update(col).digest('hex').slice(0, 16);
  return `echodb-snap-${colHash}`;
}

// ─────────────────────────────────────────────────────────────────────────────

class EchoEntriesDB {
  /**
   * @param {object} opts
   * @param {string}  [opts.email]                  - Account email (used for Echo Entries backup & Mataroa)
   * @param {string}  [opts.password]               - Account password (used for Echo Entries backup & Mataroa)
   * @param {string}  [opts.apiKey]                 - Mataroa API key (primary host)
   * @param {string}  [opts.mataroaApiKey]          - Alias for opts.apiKey
   * @param {string}  [opts.username]               - Mataroa username
   * @param {string}  [opts.mataroaUsername]        - Alias for opts.username
   * @param {boolean} [opts.memoryOnly=false]       - offline/CI mode — no network, no WAL, no auth
   * @param {string}  [opts.encryptionSecret]       - inner encryption layer
   * @param {string}  [opts.walPath]                - local WAL path
   * @param {number}  [opts.autoSyncMs=300000]      - 0 = off
   * @param {number}  [opts.compactEvery=20]        - ops before auto-compaction per col
   * @param {number}  [opts.batchSize=10]           - max ops per bulk POST
   * @param {number}  [opts.batchWindowMs=8]        - ms to accumulate ops before firing
   */
  constructor(opts = {}) {
    this._memoryOnly = Boolean(opts.memoryOnly);

    if (!this._memoryOnly && !opts.apiKey && !opts.mataroaApiKey && !opts.username && (!opts.email || !opts.password)) {
      throw new Error('[EchoEntriesDB] opts.email and opts.password are required (or set memoryOnly: true for offline mode).');
    }

    this._email            = opts.email ?? null;
    this._password         = opts.password ?? null;
    this._mataroaApiKey    = opts.apiKey ?? opts.mataroaApiKey ?? null;
    this._mataroaUsername  = opts.username ?? opts.mataroaUsername ?? null;
    this._encryptionSecret = opts.encryptionSecret ?? null;
    this._walPath          = path.resolve(opts.walPath ?? './.echodb_wal.json');
    this._autoSyncMs       = opts.autoSyncMs   ?? 300_000;
    this._compactEvery     = opts.compactEvery ?? COMPACT_EVERY;
    this._batchSize        = opts.batchSize    ?? BATCH_SIZE;
    this._batchWindowMs    = opts.batchWindowMs ?? BATCH_WINDOW_MS;

    // HTTP clients: Mataroa is PRIMARY, Echo Entries is BACKUP
    this._mataroaClient = new MataroaClient({ apiKey: this._mataroaApiKey });
    this._http          = new HttpClient();
    this._wal           = new WAL(this._walPath);

    // ── RAM state ──────────────────────────────────────────────────────────
    this._stores          = new Map(); // col → Map<id, doc>
    this._snapEeId        = new Map(); // col → EE row id of current snapshot
    this._opEeIds         = new Map(); // col → string[] EE row ids of pending op-entries
    this._mataroaSnapSlug = new Map(); // col → Mataroa page slug of current snapshot
    this._mataroaOpSlugs  = new Map(); // col → string[] Mataroa page slugs of pending ops
    this._opCount         = new Map(); // col → number of ops since last compaction

    // ── Secondary indexes ──────────────────────────────────────────────────
    this._indexes      = new Map(); // col → Map<field, Map<value, Set<id>>>
    this._uniqueFields = new Map(); // col → Set<field>
    this._schemas      = new Map(); // col → schemaDefinition

    // ── Drain & Mutex state ────────────────────────────────────────────────
    this._draining      = false;
    this._batchTimer    = null;
    this._syncTimer     = null;
    this._userId        = null;
    this._userKeyId     = null;
    this._txQueue       = Promise.resolve();
  }

  // ── Static helpers ─────────────────────────────────────────────────────────

  /**
   * Provision a synchronized dual-host account on Mataroa (primary) and Echo Entries (backup).
   * Generates cryptographically secure credentials (CSPRNG) if omitted.
   * Returns synchronized credentials, .env template, config object, and host statuses.
   *
   * @param {object} [opts]
   * @param {string} [opts.email]             - Account email (used on both hosts)
   * @param {string} [opts.password]          - Account password (if omitted, generated via CSPRNG)
   * @param {string} [opts.username]          - Mataroa username/subdomain (if omitted, derived from email)
   * @param {string} [opts.encryptionSecret]  - E2EE secret key (if omitted, 256-bit CSPRNG hex generated)
   * @param {string} [opts.firstName]         - Optional user first name (Echo Entries metadata)
   * @param {string} [opts.lastName]          - Optional user last name (Echo Entries metadata)
   * @returns {Promise<object>}
   */
  static async register(opts = {}) {
    const email = opts.email ? String(opts.email).trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error(`[EchoEntriesDB] Invalid email format: '${email}'.`);
    }

    const username = opts.username
      ? String(opts.username).trim().toLowerCase()
      : (email ? deriveMataroaUsername(email) : 'm' + crypto.randomBytes(4).toString('hex'));

    if (!/^[a-z0-9]{3,30}$/.test(username)) {
      throw new Error(`[EchoEntriesDB] Invalid username '${username}'. Must be 3-30 lowercase alphanumeric characters.`);
    }

    const password = opts.password
      ? String(opts.password)
      : generateSecurePassword(24);

    if (password.length < 8) {
      throw new Error('[EchoEntriesDB] Password must be at least 8 characters.');
    }

    const encryptionSecret = opts.encryptionSecret
      ? String(opts.encryptionSecret)
      : generateEncryptionSecret();

    const firstName = opts.firstName || '';
    const lastName  = opts.lastName  || '';

    let mataroaRes = null;
    let eeRes = null;
    let emailConfirmationRequired = false;

    // 1. Primary host: Mataroa registration
    try {
      mataroaRes = await MataroaClient.register({
        username,
        password,
        email: email || ''
      });
    } catch (err) {
      console.warn(`[EchoDB] Mataroa registration notice: ${err.message}`);
    }

    // 2. Backup host: Echo Entries registration
    if (email) {
      try {
        const http = new HttpClient();
        eeRes = await http.signup(email, password, { firstName, lastName });
        emailConfirmationRequired = !(eeRes?.access_token || eeRes?.session?.access_token || eeRes?.session);
      } catch (err) {
        console.warn(`[EchoDB] Echo Entries backup registration notice: ${err.message}`);
      }
    }

    const apiKey = mataroaRes?.apiKey ?? null;

    const envTemplate = [
      '# ========================================================',
      '# EchoDB Credentials (Mataroa Primary + Echo Entries Backup)',
      '# WARNING: NEVER commit this file to version control (.gitignore)',
      '# ========================================================',
      `ECHODB_API_KEY="${apiKey || ''}"`,
      `ECHODB_EMAIL="${email || ''}"`,
      `ECHODB_PASSWORD="${password}"`,
      `ECHODB_ENCRYPTION_SECRET="${encryptionSecret}"`,
      ''
    ].join('\n');

    const codeSnippet = [
      "const { EchoEntriesDB } = require('@bridevmx/echodb');",
      '',
      'const db = new EchoEntriesDB({',
      '  apiKey: process.env.ECHODB_API_KEY,',
      '  email: process.env.ECHODB_EMAIL,',
      '  password: process.env.ECHODB_PASSWORD,',
      '  encryptionSecret: process.env.ECHODB_ENCRYPTION_SECRET',
      '});',
      '',
      'await db.init();'
    ].join('\n');

    return {
      success: Boolean(apiKey || eeRes?.user),

      // Synchronized credentials
      credentials: {
        username,
        email,
        password,
        apiKey,
        encryptionSecret
      },

      // Configuration object ready for new EchoEntriesDB(config)
      config: {
        apiKey,
        email,
        password,
        encryptionSecret
      },

      // Preformatted .env file content
      env: envTemplate,

      // Initialization code snippet
      codeSnippet,

      // Host statuses
      hosts: {
        primary: {
          provider: 'mataroa',
          url: 'https://mataroa.blog',
          blogUrl: `https://${username}.mataroa.blog/`,
          apiKey,
          status: apiKey ? 'active' : 'failed'
        },
        backup: {
          provider: 'echoentries',
          url: 'https://veorhexddrwlwxtkuycb.supabase.co',
          userId: eeRes?.user?.id ?? null,
          emailConfirmationRequired,
          status: eeRes?.user ? 'active' : (email ? 'pending_confirmation' : 'skipped_no_email')
        }
      },

      // Backward-compatible properties
      apiKey,
      user: eeRes?.user ?? null,
      session: eeRes?.session ?? null,
      emailConfirmationRequired,
      mataroa: mataroaRes ?? null
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async init() {
    if (this._memoryOnly) {
      console.log('[EchoEntriesDB] memoryOnly mode — skipping auth, WAL and network sync.');
      return this;
    }

    console.log('[EchoEntriesDB] Initializing...');

    // 1. Authenticate with Echo Entries (Backup host) if credentials provided
    if (this._email && this._password) {
      try {
        const authData = await this._http.login(this._email, this._password);
        this._userId = authData.user?.id;
      } catch (err) {
        console.warn(`[EchoEntriesDB] Echo Entries backup auth notice: ${err.message}`);
      }
    }

    // 2. Authenticate with Mataroa (Primary host)
    await this._initMataroaAuth();

    // 3. Setup encryption identifier
    this._userKeyId = this._userId || (this._mataroaApiKey ? `mataroa:${this._mataroaApiKey.slice(0, 16)}` : 'echodb-key');

    this._wal.load();
    await this.sync();

    if (this._wal.length > 0) {
      console.log(`[EchoEntriesDB] Draining ${this._wal.length} WAL op(s) from previous run...`);
      await this._drain();
    }

    if (this._autoSyncMs > 0) {
      this._syncTimer = setInterval(() => this.sync().catch(console.error), this._autoSyncMs);
      if (typeof this._syncTimer.unref === 'function') this._syncTimer.unref();
    }

    console.log('[EchoEntriesDB] Ready.');
    return this;
  }

  async _initMataroaAuth() {
    if (this._mataroaApiKey) {
      this._mataroaClient.apiKey = this._mataroaApiKey;
      return;
    }

    // Attempt login with explicit username or derived username
    const username = this._mataroaUsername || (this._email ? deriveMataroaUsername(this._email) : null);
    if (username && this._password) {
      try {
        const loginRes = await MataroaClient.login({ username, password: this._password });
        this._mataroaApiKey = loginRes.apiKey;
        this._mataroaClient.apiKey = loginRes.apiKey;
        return;
      } catch (loginErr) {
        // If login failed and we have email, attempt auto-registration
        if (this._email) {
          try {
            const regRes = await MataroaClient.register({
              username,
              password: this._password,
              email: this._email
            });
            this._mataroaApiKey = regRes.apiKey;
            this._mataroaClient.apiKey = regRes.apiKey;
            return;
          } catch (regErr) {
            console.warn(`[EchoEntriesDB] Mataroa auto-setup notice: ${regErr.message}`);
          }
        }
      }
    }
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
      throw new Error('[EchoDB] defineSchema() requires a collection name string.');
    }
    if (!schema || typeof schema !== 'object') {
      throw new Error('[EchoDB] defineSchema() requires a schema definition object.');
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

  // ── Sync & Cloud Operations ────────────────────────────────────────────────

  async sync() {
    let syncedFromMataroa = false;

    // 1. Primary host: Mataroa
    if (this._mataroaClient && this._mataroaClient.apiKey) {
      try {
        const pages = await this._mataroaClient.listPages();
        const echodbPages = (pages || []).filter(p => p.slug && p.slug.startsWith('echodb-'));
        if (echodbPages.length > 0) {
          await this._rebuildFromMataroaPages(echodbPages);
          syncedFromMataroa = true;
        }
      } catch (err) {
        console.warn(`[EchoEntriesDB] Mataroa primary sync notice: ${err.message}`);
      }
    }

    // 2. Backup host: Echo Entries (or auto-migration to Mataroa if Mataroa was empty)
    if (!syncedFromMataroa) {
      try {
        const rows = await this._fetchAllRows();
        if (rows && rows.length > 0) {
          await this._rebuildFromRows(rows);
          // Migrate state to Mataroa primary
          if (this._mataroaClient && this._mataroaClient.apiKey) {
            for (const col of this._stores.keys()) {
              await this._compactMataroa(col).catch(() => {});
            }
          }
        }
      } catch (err) {
        console.warn(`[EchoEntriesDB] Echo Entries backup sync notice: ${err.message}`);
      }
    }

    // 3. Rebuild all declared indexes
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

  /**
   * Dual-write: persists batch of ops to Mataroa (Primary) and Echo Entries (Backup) concurrently.
   */
  async _persistBatch(ops) {
    // Step 1: Encrypt all ops in parallel
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

    const writeTasks = [];

    // ── Task A: Primary — Mataroa hidden pages ──────────────────────────────
    if (this._mataroaClient && this._mataroaClient.apiKey) {
      writeTasks.push(
        Promise.all(
          ops.map(async (op, idx) => {
            const slug = makeMataroaOpSlug(op.col);
            await this._mataroaClient.createPage({
              title: 'Entry',
              slug,
              body: encrypted[idx],
              is_hidden: true
            });
            const slugs = this._mataroaOpSlugs.get(op.col) ?? [];
            slugs.push(slug);
            this._mataroaOpSlugs.set(op.col, slugs);
          })
        )
      );
    }

    // ── Task B: Backup — Echo Entries PostgREST bulk insert ──────────────────
    if (this._userId && this._http) {
      writeTasks.push(
        (async () => {
          try {
            const bodies = encrypted.map(entryText => ({
              user_id:           this._userId,
              entry_text:        entryText,
              mood:              EE_MOOD,
              status:            EE_STATUS,
              timezone:          EE_TIMEZONE,
              timestamp_started: makeTimestamp()
            }));

            const { data } = await this._http.request('POST', '', bodies);
            const rows = Array.isArray(data) ? data : (data ? [data] : []);

            for (let i = 0; i < ops.length; i++) {
              const op  = ops[i];
              const row = rows[i];
              if (!row?.id) continue;

              const ids = this._opEeIds.get(op.col) ?? [];
              ids.push(row.id);
              this._opEeIds.set(op.col, ids);

              const store = this._stores.get(op.col);
              if (store && op.type !== 'DELETE') {
                const current = store.get(op.doc.id);
                if (current) store.set(op.doc.id, { ...current, _eeId: row.id });
              }
            }
          } catch (eeErr) {
            console.warn(`[EchoEntriesDB] Backup write to Echo Entries warning: ${eeErr.message}`);
          }
        })()
      );
    }

    if (writeTasks.length > 0) {
      await Promise.all(writeTasks);
    }
  }

  /**
   * Dual-compaction: compacts on both Mataroa (Primary) and Echo Entries (Backup).
   */
  async _compact(col) {
    await Promise.all([
      this._compactMataroa(col).catch(e => console.warn(`[EchoEntriesDB] Mataroa compaction warning: ${e.message}`)),
      this._compactEchoEntries(col).catch(e => console.warn(`[EchoEntriesDB] Echo Entries compaction warning: ${e.message}`))
    ]);
  }

  async _compactMataroa(col) {
    if (!this._mataroaClient || !this._mataroaClient.apiKey) return;
    const store = this._stores.get(col);
    if (!store) return;

    const snapSlug = makeMataroaSnapSlug(col);
    const snapPayload = {
      _type: TAG_SNAP,
      _col:  col,
      _v:    this._opCount.get(col) ?? 0,
      docs:  Object.fromEntries(store)
    };

    const encrypted = await this._encrypt(snapPayload);
    const existingSnapSlug = this._mataroaSnapSlug.get(col);
    const opSlugs = this._mataroaOpSlugs.get(col) ?? [];

    const updateSnapshot = existingSnapSlug
      ? this._mataroaClient.updatePage(existingSnapSlug, { body: encrypted, is_hidden: true })
      : this._mataroaClient.createPage({
          title: 'Store',
          slug: snapSlug,
          body: encrypted,
          is_hidden: true
        });

    await Promise.all([
      updateSnapshot,
      ...opSlugs.map(slug => this._mataroaClient.deletePage(slug).catch(() => {}))
    ]);

    this._mataroaSnapSlug.set(col, snapSlug);
    this._mataroaOpSlugs.set(col, []);
    this._opCount.set(col, 0);
  }

  async _compactEchoEntries(col) {
    if (!this._userId || !this._http) return;
    const store = this._stores.get(col);
    if (!store) return;

    const snapPayload = {
      _type: TAG_SNAP,
      _col:  col,
      _v:    this._opCount.get(col) ?? 0,
      docs:  Object.fromEntries(store)
    };
    const entryText      = await this._encrypt(snapPayload);
    const existingSnapId = this._snapEeId.get(col);
    const opIds          = this._opEeIds.get(col) ?? [];

    const [snapResult] = await Promise.all([
      existingSnapId
        ? this._http.request('PATCH', `?id=eq.${existingSnapId}`,
            { entry_text: entryText, updated_at: new Date().toISOString() }, 'return=minimal')
        : this._http.request('POST', '', {
            user_id: this._userId, entry_text: entryText,
            mood: EE_MOOD, status: EE_STATUS, timezone: EE_TIMEZONE,
            timestamp_started: makeTimestamp()
          }),
      ...opIds.map(eeId =>
        this._http.request('DELETE', `?id=eq.${eeId}`, null, 'return=minimal')
      )
    ]);

    if (!existingSnapId) {
      const row = Array.isArray(snapResult.data) ? snapResult.data[0] : snapResult.data;
      if (row?.id) this._snapEeId.set(col, row.id);
    }

    this._opEeIds.set(col, []);
  }

  // ── Sync Rebuilders ────────────────────────────────────────────────────────

  async _rebuildFromMataroaPages(pages) {
    const decrypted = await Promise.all(
      pages.map(async page => {
        try {
          const payload = await this._decrypt(page.body);
          return { page, payload };
        } catch {
          return null;
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
        this._mataroaSnapSlug.set(col, snap.page.slug);
        for (const [id, doc] of Object.entries(snap.payload.docs ?? {})) {
          store.set(id, doc);
        }
      }

      const colOps = ops.get(col) ?? [];
      const storedSlugs = [];
      colOps.sort((a, b) => (a.page.slug < b.page.slug ? -1 : 1));

      for (const { page, payload } of colOps) {
        storedSlugs.push(page.slug);
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

      this._mataroaOpSlugs.set(col, storedSlugs);
      this._opCount.set(col, storedSlugs.length);
    }
  }

  async _fetchAllRows() {
    if (!this._http || !this._userId) return [];
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
    const decrypted = await Promise.all(
      rows.map(async row => {
        try {
          const payload = await this._decrypt(row.entry_text);
          return { row, payload };
        } catch {
          return null;
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

function deriveMataroaUsername(email) {
  const hash = crypto.createHash('sha256').update(email).digest('hex').slice(0, 8);
  return `m${hash}`;
}

/**
 * Generate a cryptographically secure random password (CSPRNG).
 * Satisfies Django's UserAttributeSimilarityValidator and standard complexity rules.
 * @param {number} [length=24]
 * @returns {string}
 */
function generateSecurePassword(length = 24) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*+=';
  const all = upper + lower + digits + symbols;

  const pwd = [
    upper[crypto.randomInt(0, upper.length)],
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    digits[crypto.randomInt(0, digits.length)],
    symbols[crypto.randomInt(0, symbols.length)],
    symbols[crypto.randomInt(0, symbols.length)]
  ];

  for (let i = pwd.length; i < length; i++) {
    pwd.push(all[crypto.randomInt(0, all.length)]);
  }

  // Fisher-Yates shuffle using CSPRNG
  for (let i = pwd.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = pwd[i];
    pwd[i] = pwd[j];
    pwd[j] = tmp;
  }

  return pwd.join('');
}

/**
 * Generate a 256-bit cryptographically secure encryption secret (hex string).
 * @returns {string} 64-char hex string
 */
function generateEncryptionSecret() {
  return crypto.randomBytes(32).toString('hex');
}

EchoEntriesDB.provisionAccount = EchoEntriesDB.register;

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
