'use strict';

const crypto = require('crypto');

/**
 * Collection — NoSQL-style API over an in-memory Map.
 *
 * OPTIMIZATION 2: Secondary indexes
 *   col.createIndex('field') via db.createIndex(colName, field)
 *   col.findBy('field', value)  → O(1) Map lookup instead of O(n) scan
 *   col.where({...})            → chainable query builder
 *
 * All reads are RAM-only (0ms, no network).
 * All writes update RAM immediately and enqueue a WAL op.
 */
class Collection {
  /**
   * @param {string}                          name
   * @param {Map<string,object>}              store     shared RAM map
   * @param {function}                        enqueue   db._enqueue(op)
   * @param {Map<string, Map<string,Set>>}    indexes   col-level index map
   */
  constructor(name, store, enqueue, indexes) {
    this.name      = name;
    this._store    = store;
    this._enqueue  = enqueue;
    this._indexes  = indexes ?? new Map(); // field → Map<value, Set<id>>
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
      // No index — fall back to O(n) scan and warn
      console.warn(`[EchoEntriesDB] No index on '${this.name}.${field}'. Call db.createIndex('${this.name}', '${field}') for O(1) lookups.`);
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

  // ── Writes ────────────────────────────────────────────────────────────────

  async insert(doc) {
    const id = doc.id ?? doc._id ?? crypto.randomUUID();
    if (this._store.has(id)) {
      throw new Error(`[EchoEntriesDB] Document '${id}' already exists in '${this.name}'.`);
    }
    const stored = this._build(id, doc, 'INSERT', 1);
    this._store.set(id, stored);
    this._indexAdd(stored);
    this._enqueue({ type: 'INSERT', col: this.name, doc: stored });
    return stored;
  }

  async update(id, updates) {
    const current = this._store.get(id);
    if (!current) throw new Error(`[EchoEntriesDB] Document '${id}' not found in '${this.name}'.`);
    const stored = this._build(id, { ...current, ...updates }, 'UPDATE', (current._v ?? 1) + 1, current._eeId);
    this._indexRemove(current);
    this._store.set(id, stored);
    this._indexAdd(stored);
    this._enqueue({ type: 'UPDATE', col: this.name, doc: stored });
    return stored;
  }

  async upsert(doc) {
    const id = doc.id ?? doc._id;
    if (!id) throw new Error('[EchoEntriesDB] upsert() requires a document with an id field.');
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
   * @param {boolean} [opts.excludeMeta=false]  Omit system metadata fields (_col, _v, etc.)
   * @returns {string|object}
   */
  exportJSON(opts = {}) {
    const stringify   = opts.stringify !== false;
    const pretty      = Boolean(opts.pretty);
    const excludeMeta = Boolean(opts.excludeMeta);

    const docs = [...this._store.values()].map(doc => {
      if (!excludeMeta) return { ...doc };
      const { _col, _id, _type, _op, _v, _eeId, _createdAt, _updatedAt, ...clean } = doc;
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
      throw new Error(`[EchoEntriesDB] importJSON() expected an array of documents or { documents: [...] } for collection '${this.name}'.`);
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
        const id = item.id ?? item._id ?? crypto.randomUUID();
        await this.upsert({ ...item, id });
      }
      count++;
    }

    return { imported: count };
  }

  // ── Index maintenance ─────────────────────────────────────────────────────

  _indexAdd(doc) {
    for (const [field, fieldIndex] of this._indexes) {
      const val = doc[field];
      if (val === undefined) continue;
      const key = String(val);
      if (!fieldIndex.has(key)) fieldIndex.set(key, new Set());
      fieldIndex.get(key).add(doc.id);
    }
  }

  _indexRemove(doc) {
    for (const [field, fieldIndex] of this._indexes) {
      const val = doc[field];
      if (val === undefined) continue;
      const key = String(val);
      fieldIndex.get(key)?.delete(doc.id);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _build(id, data, op, v, eeId = null) {
    const { _col, _id, _type, _op, _v, _eeId, _createdAt, ...rest } = data;
    return {
      ...rest,
      id,
      _col:       this.name,
      _id:        id,
      _type:      'op',
      _op:        op,
      _v:         v,
      _eeId:      eeId,
      _createdAt: _createdAt ?? new Date().toISOString(),
      _updatedAt: new Date().toISOString()
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
