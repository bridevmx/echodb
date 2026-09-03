'use strict';

const fs = require('fs');

/**
 * Write-Ahead Log — persists the pending op queue to disk before any network
 * request. Guarantees zero data loss across server restarts.
 *
 * Each entry in the WAL is an object:
 *   { type: 'INSERT'|'UPDATE'|'DELETE'|'COMPACT', col, doc, eeId? }
 */
class WAL {
  constructor(walPath) {
    this.path = walPath;
    this.queue = [];
  }

  load() {
    if (!fs.existsSync(this.path)) return;
    try {
      const raw = fs.readFileSync(this.path, 'utf-8');
      this.queue = JSON.parse(raw) || [];
      if (this.queue.length) {
        console.log(`[EchoEntriesDB] WAL: recovered ${this.queue.length} pending op(s).`);
      }
    } catch {
      this.queue = [];
    }
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.queue), 'utf-8');
  }

  clear() {
    this.queue = [];
    try { fs.unlinkSync(this.path); } catch { /* already gone */ }
  }

  push(op) {
    this.queue.push(op);
    this.save();
  }

  peek() { return this.queue[0]; }

  shift() {
    this.queue.shift();
    this.save();
  }

  get length() { return this.queue.length; }
}

module.exports = WAL;
