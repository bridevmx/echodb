'use strict';

const crypto = require('crypto');

const PB_ID_REGEX = /^[a-z0-9]{15}$/;
const PB_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generatePbId() {
  const bytes = crypto.randomBytes(15);
  let id = '';
  for (let i = 0; i < 15; i++) {
    id += PB_ID_CHARS[bytes[i] % 36];
  }
  return id;
}

/**
 * Collection — PocketBase-compatible document collection backed by in-memory Map.
 *
 * - RAM-first reads (~0 ms, no network, no disk).
 * - PocketBase-compatible 15-char IDs ([a-z0-9]{15}).
 * - Canonical ISO-8601 UTC timestamps: created, updated.
 * - Unique constraint validation on indexed fields (O(1)).
 * - PocketBase query methods: getOne(), getFirstListItem(), getFullList(), getList().
 * - Cross-collection in-memory relation expansion (.expand).
 * - Zero external dependencies.
 */
class Collection {
  /**
   * @param {string}                       name
   * @param {Map<string,object>}           store         shared RAM map
   * @param {function}                     enqueue       db._enqueue(op)
   * @param {Map<string, Map<string,Set>>} indexes       col-level index map
   * @param {Set<string>}                  [uniqueFields] set of fields with unique constraint
   * @param {object}                       [db]          parent EchoEntriesDB reference
   */
  constructor(name, store, enqueue, indexes, uniqueFields, db = null) {
    this.name          = name;
    this._store        = store;
    this._enqueue      = enqueue;
    this._indexes      = indexes ?? new Map(); // field → Map<value, Set<id>>
    this._uniqueFields = uniqueFields ?? new Set(); // field names with unique constraint
    this._db           = db;
  }

  // ── Reads — O(1) ──────────────────────────────────────────────────────────

  findById(id) {
    return this._store.get(id) ?? null;
  }

  // ── Reads — O(n) full scan ────────────────────────────────────────────────

  find(predicate = () => true) {
    const out = [];
    for (const doc of this._store.values()) {
      if (predicate(doc)) out.push(doc);
    }
    return out;
  }

  findOne(predicate) {
    for (const doc of this._store.values()) {
      if (predicate(doc)) return doc;
    }
    return null;
  }

  all()                          { return [...this._store.values()]; }
  count(predicate = () => true)  { return this.find(predicate).length; }

  // ── OPTIMIZATION 2: Index-backed lookups — O(1) ───────────────────────────

  /**
   * Exact-match lookup using a secondary index.
   * Requires db.createIndex(colName, field) to have been called first.
   * Falls back to full scan with a warning if the index doesn't exist.
   *
   * @param {string} field
   * @param {*}      value
   * @returns {object[]}
   */
  findBy(field, value) {
    const fieldIndex = this._indexes.get(field);
    if (!fieldIndex) {
      console.warn(`[EchoDB] No index on '${this.name}.${field}'. Call db.createIndex('${this.name}', '${field}') for O(1) lookups.`);
      return this.find(d => d[field] === value);
    }
    const ids = fieldIndex.get(String(value));
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const doc = this._store.get(id);
      if (doc) out.push(doc);
    }
    return out;
  }

  /**
   * Find the first document matching an indexed field.
   * @param {string} field
   * @param {*}      value
   * @returns {object|null}
   */
  findOneBy(field, value) {
    const results = this.findBy(field, value);
    return results[0] ?? null;
  }

  // ── PocketBase-compatible query methods ───────────────────────────────────

  /**
   * Fetch a single record by its ID with optional relation expansion and field projection.
   * @param {string} id
   * @param {object} [options]
   * @param {string|string[]|object} [options.expand]
   * @param {string} [options.fields]  Comma-separated field projection (e.g. 'id,name,email')
   * @returns {object|null}
   */
  getOne(id, options = {}) {
    const doc = this.findById(id);
    if (!doc) return null;
    let result = doc;
    if (options.expand) result = this._expandDoc(result, options.expand);
    if (options.fields) result = this._projectFields(result, options.fields);
    return result;
  }

  /**
   * Fetch the first record matching a filter or predicate with optional expand and field projection.
   *
   * @example
   *   col.getFirstListItem(doc => doc.role === 'admin')
   *   col.getFirstListItem('email', 'user@example.com')
   *   col.getFirstListItem({ email: 'user@example.com' }, { expand: 'profile' })
   *
   * @param {function|string|object} filterOrField
   * @param {*} [valueOrOptions]
   * @param {object} [maybeOptions]
   * @param {string} [maybeOptions.expand]
   * @param {string} [maybeOptions.fields]  Comma-separated field projection
   * @returns {object|null}
   */
  getFirstListItem(filterOrField, valueOrOptions, maybeOptions = {}) {
    let doc = null;
    let opts = maybeOptions;

    if (typeof filterOrField === 'function') {
      doc = this.findOne(filterOrField);
      opts = typeof valueOrOptions === 'object' && valueOrOptions !== null ? valueOrOptions : maybeOptions;
    } else if (typeof filterOrField === 'string' && valueOrOptions !== undefined && (typeof valueOrOptions !== 'object' || valueOrOptions === null)) {
      doc = this.findOneBy(filterOrField, valueOrOptions);
    } else if (typeof filterOrField === 'object' && filterOrField !== null) {
      doc = this.where(filterOrField).first();
      opts = typeof valueOrOptions === 'object' && valueOrOptions !== null ? valueOrOptions : maybeOptions;
    }

    if (!doc) return null;
    let result = doc;
    if (opts && opts.expand) result = this._expandDoc(result, opts.expand);
    if (opts && opts.fields) result = this._projectFields(result, opts.fields);
    return result;
  }

  /**
   * Fetch all records matching optional filter, sort, expand and field projection.
   *
   * @param {object} [options]
   * @param {function|object} [options.filter]
   * @param {string|string[]} [options.sort]  e.g. '-created', 'title:asc', '-created,title'
   * @param {string|string[]|object} [options.expand]
   * @param {string} [options.fields]  Comma-separated field projection (e.g. 'id,name,email')
   * @returns {object[]}
   */
  getFullList(options = {}) {
    let docs = [...this._store.values()];

    if (options.filter) {
      if (typeof options.filter === 'function') {
        docs = docs.filter(options.filter);
      } else if (typeof options.filter === 'object') {
        docs = docs.filter(doc =>
          Object.entries(options.filter).every(([k, v]) => doc[k] === v)
        );
      }
    }

    if (options.sort) {
      docs = this._sortDocs(docs, options.sort);
    }

    if (options.expand) {
      docs = docs.map(d => this._expandDoc(d, options.expand));
    }

    if (options.fields) {
      docs = docs.map(d => this._projectFields(d, options.fields));
    }

    return docs;
  }

  /**
   * Fetch a paginated list of records matching PocketBase response format.
   *
   * @param {number} [page=1]
   * @param {number} [perPage=30]
   * @param {object} [options]
   * @param {function|object} [options.filter]
   * @param {string|string[]} [options.sort]
   * @param {string|string[]|object} [options.expand]
   * @param {string} [options.fields]     Comma-separated field projection (e.g. 'id,name')
   * @param {boolean} [options.skipTotal] Skip totalItems/totalPages computation (faster)
   * @returns {{ page: number, perPage: number, totalItems: number, totalPages: number, items: object[] }}
   */
  getList(page = 1, perPage = 30, options = {}) {
    const p  = Math.max(1, parseInt(page,    10) || 1);
    const pp = Math.max(1, parseInt(perPage, 10) || 30);

    const docs = this.getFullList(options);
    const start = (p - 1) * pp;
    const items = docs.slice(start, start + pp);

    if (options.skipTotal) {
      return { page: p, perPage: pp, totalItems: -1, totalPages: -1, items };
    }

    const totalItems = docs.length;
    const totalPages = Math.ceil(totalItems / pp) || 0;
    return { page: p, perPage: pp, totalItems, totalPages, items };
  }

  // ── OPTIMIZATION 2: Chainable query builder ───────────────────────────────

  /**
   * Start a chainable query.
   * Uses indexes automatically when available.
   *
   * @example
   *   col.where({ role: 'admin', active: true })
   *      .sortBy('age', 'desc')
   *      .limit(10)
   *      .exec()
   *
   * @param {object} conditions  - { field: value, ... }
   * @returns {Query}
   */
  where(conditions = {}) {
    return new Query(this._store, this._indexes, conditions);
  }

  // ── Index & Constraint Setup ──────────────────────────────────────────────

  /**
   * Declare a secondary index on this collection.
   * @param {string} field
   * @param {object} [opts]
   * @param {boolean} [opts.unique=false]
   */
  createIndex(field, opts = {}) {
    if (this._db) {
      this._db.createIndex(this.name, field, opts);
    } else {
      if (opts.unique) this._uniqueFields.add(field);
      if (!this._indexes.has(field)) {
        const fieldIndex = new Map();
        for (const doc of this._store.values()) {
          const val = doc[field];
          if (val === undefined || val === null) continue;
          const key = String(val);
          if (!fieldIndex.has(key)) fieldIndex.set(key, new Set());
          fieldIndex.get(key).add(doc.id);
        }
        this._indexes.set(field, fieldIndex);
      }
    }
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * Create a new document — canonical PocketBase SDK name.
   * Equivalent to insert(). `insert()` is kept as an alias.
   * @param {object} bodyParams
   * @param {object} [options]
   * @param {string} [options.expand]
   * @param {string} [options.fields]  Comma-separated field projection (e.g. 'id,name,email')
   * @returns {Promise<object>}
   */
  async create(bodyParams, options = {}) {
    const doc = await this.insert(bodyParams);
    let result = doc;
    if (options.expand) result = this._expandDoc(result, options.expand);
    if (options.fields) result = this._projectFields(result, options.fields);
    return result;
  }

  async insert(doc) {
    if (!doc || typeof doc !== 'object') {
      throw new Error(`[EchoDB] insert() requires a document object.`);
    }

    let id = doc.id ?? doc._id;
    if (id === undefined || id === null) {
      do {
        id = generatePbId();
      } while (this._store.has(id));
    } else {
      if (typeof id !== 'string' || !PB_ID_REGEX.test(id)) {
        throw new Error(`[EchoDB] Invalid ID '${id}'. PocketBase IDs must be exactly 15 lowercase alphanumeric characters ([a-z0-9]{15}).`);
      }
      if (this._store.has(id)) {
        throw new Error(`[EchoDB] Document with id '${id}' already exists in '${this.name}'.`);
      }
    }

    // Apply schema defaults & validation
    const prepared = this._applySchema(doc, false);

    // Check unique constraints in RAM
    this._checkUniqueConstraints(prepared, id);

    const stored = this._build(id, prepared, 'INSERT', 1);
    this._store.set(id, stored);
    this._indexAdd(stored);
    this._enqueue({ type: 'INSERT', col: this.name, doc: stored });
    return stored;
  }

  /**
   * Update a document by ID — canonical PocketBase SDK name and signature.
   * @param {string} id
   * @param {object} bodyParams  Partial fields to merge (PATCH semantics)
   * @param {object} [options]
   * @param {string} [options.expand]  Expand relations in the response
   * @param {string} [options.fields]  Comma-separated field projection (e.g. 'id,name')
   * @returns {Promise<object>}
   */
  async update(id, bodyParams, options = {}) {
    if (typeof id !== 'string' || !id) {
      throw new Error(`[EchoDB] update() requires a valid document ID string.`);
    }
    const updates = bodyParams;
    const current = this._store.get(id);
    if (!current) {
      throw new Error(`[EchoDB] Document '${id}' not found in '${this.name}'.`);
    }
    if (updates.id && updates.id !== id) {
      throw new Error(`[EchoDB] Cannot change document ID from '${id}' to '${updates.id}'.`);
    }

    // Apply schema validation
    const preparedUpdates = this._applySchema(updates, true);
    const merged = { ...current, ...preparedUpdates };

    // Check unique constraints in RAM
    this._checkUniqueConstraints(merged, id);

    const stored = this._build(id, merged, 'UPDATE', (current._v ?? 1) + 1, current._eeId);
    this._indexRemove(current);
    this._store.set(id, stored);
    this._indexAdd(stored);
    this._enqueue({ type: 'UPDATE', col: this.name, doc: stored });

    let result = stored;
    if (options.expand) result = this._expandDoc(result, options.expand);
    if (options.fields) result = this._projectFields(result, options.fields);
    return result;
  }

  async upsert(doc) {
    if (!doc || typeof doc !== 'object') {
      throw new Error(`[EchoDB] upsert() requires a document object.`);
    }
    let id = doc.id ?? doc._id;
    if (!id) {
      return this.insert(doc);
    }
    if (!PB_ID_REGEX.test(id)) {
      throw new Error(`[EchoDB] Invalid ID '${id}'. PocketBase IDs must be exactly 15 lowercase alphanumeric characters ([a-z0-9]{15}).`);
    }
    return this._store.has(id) ? this.update(id, doc) : this.insert(doc);
  }

  async delete(id) {
    const doc = this._store.get(id);
    if (!doc) return false;
    this._indexRemove(doc);
    this._store.delete(id);
    this._enqueue({ type: 'DELETE', col: this.name, doc });
    return true;
  }

  /**
   * Delete all documents in this collection.
   * @returns {Promise<number>} Number of deleted documents.
   */
  async clear() {
    const docs = [...this._store.values()];
    for (const doc of docs) {
      await this.delete(doc.id);
    }
    return docs.length;
  }

  /**
   * Export this collection's documents.
   * @param {object} [opts]
   * @param {boolean} [opts.pretty=false]      Format JSON with 2 spaces
   * @param {boolean} [opts.stringify=true]     Return JSON string (true) or JS object (false)
   * @param {boolean} [opts.excludeMeta=false]  Omit internal metadata fields (_v, _eeId)
   * @returns {string|object}
   */
  exportJSON(opts = {}) {
    const stringify   = opts.stringify !== false;
    const pretty      = Boolean(opts.pretty);
    const excludeMeta = Boolean(opts.excludeMeta);

    const docs = [...this._store.values()].map(doc => {
      if (!excludeMeta) return { ...doc };
      const { _v, _eeId, ...clean } = doc;
      return clean;
    });

    const payload = {
      collection: this.name,
      count:      docs.length,
      exportedAt: new Date().toISOString(),
      documents:  docs
    };

    return stringify ? JSON.stringify(payload, null, pretty ? 2 : undefined) : payload;
  }

  /**
   * Import documents into this collection.
   * @param {string|Array<object>|{documents: Array<object>}} data
   * @param {object} [opts]
   * @param {'upsert'|'overwrite'|'insert'} [opts.mode='upsert']
   * @returns {Promise<{imported: number}>}
   */
  async importJSON(data, opts = {}) {
    const mode = opts.mode ?? 'upsert';
    let parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (parsed && Array.isArray(parsed.documents)) {
      parsed = parsed.documents;
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`[EchoDB] importJSON() expected an array of documents or { documents: [...] } for collection '${this.name}'.`);
    }

    if (mode === 'overwrite') {
      await this.clear();
    }

    let count = 0;
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      if (mode === 'insert') {
        await this.insert(item);
      } else {
        await this.upsert(item);
      }
      count++;
    }

    return { imported: count };
  }

  // ── Index maintenance ─────────────────────────────────────────────────────

  _indexAdd(doc) {
    for (const [field, fieldIndex] of this._indexes) {
      const val = doc[field];
      if (val === undefined || val === null) continue;
      const key = String(val);
      if (!fieldIndex.has(key)) fieldIndex.set(key, new Set());
      fieldIndex.get(key).add(doc.id);
    }
  }

  _indexRemove(doc) {
    for (const [field, fieldIndex] of this._indexes) {
      const val = doc[field];
      if (val === undefined || val === null) continue;
      const key = String(val);
      fieldIndex.get(key)?.delete(doc.id);
    }
  }

  // ── Unique constraint check ───────────────────────────────────────────────

  _checkUniqueConstraints(doc, currentId = null) {
    for (const field of this._uniqueFields) {
      const val = doc[field];
      if (val === undefined || val === null || val === '') continue;
      const fieldIndex = this._indexes.get(field);
      if (fieldIndex) {
        const ids = fieldIndex.get(String(val));
        if (ids) {
          for (const existingId of ids) {
            if (existingId !== currentId) {
              throw new Error(`[EchoDB] Unique constraint violation: field '${field}' with value '${val}' already exists in '${this.name}' (document '${existingId}').`);
            }
          }
        }
      }
    }
  }

  // ── Schema coercion & validation ──────────────────────────────────────────

  _applySchema(data, isUpdate = false) {
    if (!this._db || !this._db.getSchema) return data;
    const schema = this._db.getSchema(this.name);
    if (!schema) return data;

    const result = { ...data };
    for (const [field, def] of Object.entries(schema)) {
      let val = result[field];

      if (val === undefined) {
        if (!isUpdate) {
          if (def.default !== undefined) {
            val = typeof def.default === 'function' ? def.default() : def.default;
          } else if (def.type === 'number' || def.type === 'int' || def.type === 'float') {
            val = 0;
          } else if (def.type === 'text' || def.type === 'string' || def.type === 'email' || def.type === 'url') {
            val = '';
          } else if (def.type === 'bool' || def.type === 'boolean') {
            val = false;
          } else if (def.type === 'json') {
            val = null;
          }
          if (val !== undefined) {
            result[field] = val;
          }
        }
      }

      if (def.required && (val === undefined || val === null || val === '')) {
        if (!(isUpdate && !(field in data))) {
          throw new Error(`[EchoDB] Validation error: field '${field}' is required in collection '${this.name}'.`);
        }
      }

      if (def.type === 'select' && Array.isArray(def.options) && val !== undefined && val !== null && val !== '') {
        if (!def.options.includes(val)) {
          throw new Error(`[EchoDB] Validation error: value '${val}' is not a valid option for '${field}' in '${this.name}'. Allowed: ${def.options.join(', ')}.`);
        }
      }
    }

    return result;
  }

  // ── Sort, Expand & Project helpers ────────────────────────────────────────

  /**
   * Project only the specified fields from a document.
   * Mirrors the PocketBase SDK `fields` option (comma-separated string).
   * Dot-notation (e.g. 'expand.author.name') is NOT supported — EchoDB is RAM-first.
   *
   * @param {object} doc
   * @param {string|string[]} fields  Comma-separated or array of field names
   * @returns {object}
   */
  _projectFields(doc, fields) {
    if (!fields) return doc;
    const keys = Array.isArray(fields)
      ? fields.map(f => f.trim()).filter(Boolean)
      : String(fields).split(',').map(f => f.trim()).filter(Boolean);
    if (keys.length === 0) return doc;
    const projected = {};
    for (const key of keys) {
      if (key in doc) projected[key] = doc[key];
    }
    return projected;
  }

  _sortDocs(docs, sort) {
    const sortSpecs = [];
    const specs = Array.isArray(sort) ? sort : String(sort).split(',');
    for (let spec of specs) {
      spec = spec.trim();
      if (!spec) continue;
      if (spec.includes(':')) {
        const [field, dir] = spec.split(':');
        sortSpecs.push({ field: field.trim(), dir: dir.trim().toLowerCase() === 'desc' ? -1 : 1 });
      } else if (spec.startsWith('-')) {
        sortSpecs.push({ field: spec.slice(1).trim(), dir: -1 });
      } else if (spec.startsWith('+')) {
        sortSpecs.push({ field: spec.slice(1).trim(), dir: 1 });
      } else {
        sortSpecs.push({ field: spec, dir: 1 });
      }
    }

    return [...docs].sort((a, b) => {
      for (const { field, dir } of sortSpecs) {
        if (a[field] < b[field]) return -dir;
        if (a[field] > b[field]) return dir;
      }
      return 0;
    });
  }

  _expandDoc(doc, expand) {
    if (!this._db || !expand) return doc;

    let expandMap = {};
    if (typeof expand === 'string') {
      expand.split(',').forEach(f => {
        const trimmed = f.trim();
        if (trimmed) expandMap[trimmed] = null;
      });
    } else if (Array.isArray(expand)) {
      expand.forEach(f => {
        if (typeof f === 'string') expandMap[f.trim()] = null;
      });
    } else if (typeof expand === 'object' && expand !== null) {
      expandMap = { ...expand };
    }

    const expanded = { ...(doc.expand || {}) };
    const schema = this._db.getSchema ? this._db.getSchema(this.name) : null;

    for (const [field, explicitCol] of Object.entries(expandMap)) {
      const foreignVal = doc[field];
      if (foreignVal === undefined || foreignVal === null) {
        expanded[field] = null;
        continue;
      }

      let targetColName = explicitCol;
      if (!targetColName && schema && schema[field]) {
        targetColName = schema[field].collection || schema[field].relation;
      }
      if (!targetColName) {
        if (this._db._stores.has(field)) {
          targetColName = field;
        } else if (field.endsWith('Ids')) {
          const base = field.slice(0, -3);
          if (this._db._stores.has(base + 's')) {
            targetColName = base + 's';
          } else if (this._db._stores.has(base + 'es')) {
            targetColName = base + 'es';
          } else if (this._db._stores.has(base)) {
            targetColName = base;
          } else {
            targetColName = base + 's';
          }
        } else if (field.endsWith('Id')) {
          const base = field.slice(0, -2);
          if (this._db._stores.has(base + 's')) {
            targetColName = base + 's';
          } else if (this._db._stores.has(base + 'es')) {
            targetColName = base + 'es';
          } else if (this._db._stores.has(base)) {
            targetColName = base;
          } else {
            targetColName = base + 's';
          }
        } else {
          targetColName = field;
        }
      }

      const targetCol = this._db.collection(targetColName);
      if (Array.isArray(foreignVal)) {
        expanded[field] = foreignVal.map(fid => targetCol.findById(fid)).filter(Boolean);
      } else {
        expanded[field] = targetCol.findById(foreignVal) ?? null;
      }
    }

    return {
      ...doc,
      expand: expanded
    };
  }

  // ── Document Builder ──────────────────────────────────────────────────────

  _build(id, data, op, v, eeId = null) {
    const now = new Date().toISOString();
    const { _col, _id, _type, _op, _v, _eeId, _createdAt, _updatedAt, ...rest } = data;

    return {
      ...rest,
      id,
      created: rest.created || now,
      updated: now,
      _v:      v,
      _eeId:   eeId
    };
  }
}

// ── Query builder ─────────────────────────────────────────────────────────────

class Query {
  constructor(store, indexes, conditions) {
    this._store      = store;
    this._indexes    = indexes;
    this._conditions = conditions;
    this._sortField  = null;
    this._sortDir    = 'asc';
    this._limitN     = Infinity;
    this._offsetN    = 0;
  }

  /**
   * Sort results by a field.
   * @param {string} field
   * @param {'asc'|'desc'} direction
   */
  sortBy(field, direction = 'asc') {
    this._sortField = field;
    this._sortDir   = direction;
    return this;
  }

  /** @param {number} n */
  limit(n)  { this._limitN  = n; return this; }

  /** @param {number} n */
  offset(n) { this._offsetN = n; return this; }

  /**
   * Execute the query and return results.
   * Uses the most selective index available (the field with fewest matches).
   * @returns {object[]}
   */
  exec() {
    const fields  = Object.keys(this._conditions);
    let candidates = null;

    // Find the most selective indexed field to use as base set
    let bestCount = Infinity;
    let bestField = null;
    for (const field of fields) {
      const fieldIndex = this._indexes.get(field);
      if (!fieldIndex) continue;
      const val  = this._conditions[field];
      const ids  = fieldIndex.get(String(val));
      const count = ids?.size ?? 0;
      if (count < bestCount) {
        bestCount = count;
        bestField = field;
        candidates = ids;
      }
    }

    // Build the candidate doc set
    let docs;
    if (candidates) {
      docs = [];
      for (const id of candidates) {
        const doc = this._store.get(id);
        if (doc) docs.push(doc);
      }
    } else {
      // No usable index — full scan
      docs = [...this._store.values()];
    }

    // Apply all remaining conditions as a filter
    docs = docs.filter(doc =>
      fields.every(field => {
        if (field === bestField) return true; // already filtered by index
        return doc[field] === this._conditions[field];
      })
    );

    // Sort
    if (this._sortField) {
      const dir = this._sortDir === 'desc' ? -1 : 1;
      const sf  = this._sortField;
      docs.sort((a, b) => {
        if (a[sf] < b[sf]) return -dir;
        if (a[sf] > b[sf]) return  dir;
        return 0;
      });
    }

    // Offset + limit
    return docs.slice(this._offsetN, this._offsetN + this._limitN);
  }

  /** Alias: exec() for users who prefer .get() */
  get() { return this.exec(); }

  /** Returns the first result or null. */
  first() { return this.limit(1).exec()[0] ?? null; }

  /** Returns the count without building the full result array. */
  count() { return this.exec().length; }
}

module.exports = Collection;
