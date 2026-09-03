'use strict';

/**
 * HTTP client for Echo Entries (Supabase PostgREST).
 * Handles auth, JWT refresh, and retries transparently.
 */

const SUPABASE_URL = 'https://veorhexddrwlwxtkuycb.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZlb3JoZXhkZHJ3bHd4dGt1eWNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDYxMzM4NzUsImV4cCI6MjA2MTcwOTg3NX0.oXmev5TAFTvRC76BdsXgse3nra15fcxuJl2T610_K7o';

class HttpClient {
  constructor() {
    this.jwt = null;
    this.refreshToken = null;
    this.jwtExpiresAt = 0; // unix seconds
  }

  // ─── AUTH ────────────────────────────────────────────────────────────────

  /**
   * Register a new Echo Entries account.
   * Matches the exact payload the EE UI sends on signup.
   *
   * @param {string} email
   * @param {string} password
   * @param {object} [meta]           - optional user metadata
   * @param {string} [meta.firstName]
   * @param {string} [meta.lastName]
   * @returns {Promise<{user, session}>}
   */
  async signup(email, password, meta = {}) {
    const { data } = await this._fetch(
      `${SUPABASE_URL}/auth/v1/signup`,
      {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          data: {
            first_name: meta.firstName ?? '',
            last_name:  meta.lastName  ?? '',
          },
          gotrue_meta_security: {}
        })
      }
    );

    // EE requires email confirmation — session may be null until verified
    if (data.access_token) this._applyAuth(data);
    return data;
  }

  async login(email, password) {
    const { data } = await this._fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      }
    );
    this._applyAuth(data);
    return data;
  }

  async _refreshJwt() {
    if (!this.refreshToken) throw new Error('[EchoEntriesDB] No refresh token — call login() first.');
    const { data } = await this._fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.refreshToken })
      }
    );
    this._applyAuth(data);
  }

  _applyAuth(data) {
    this.jwt = data.access_token;
    this.refreshToken = data.refresh_token;
    // expires_in is in seconds; refresh 60s early
    this.jwtExpiresAt = Math.floor(Date.now() / 1000) + (data.expires_in || 3600) - 60;
  }

  async _ensureJwt() {
    if (!this.jwt) throw new Error('[EchoEntriesDB] Not authenticated. Call db.init() first.');
    if (Math.floor(Date.now() / 1000) >= this.jwtExpiresAt) {
      await this._refreshJwt();
    }
  }

  // ─── REST ────────────────────────────────────────────────────────────────

  /**
   * Execute a PostgREST request against any table.
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} query  - PostgREST query string e.g. "?id=eq.xxx&select=*"
   * @param {Object} [body]
   * @param {string} [prefer]
   * @param {string} [table]  - defaults to 'journal_entries'
   * @returns {Promise<{data: any, status: number, ms: number}>}
   */
  async request(method, query = '', body = null, prefer = 'return=representation', table = 'journal_entries') {
    await this._ensureJwt();

    const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
    const headers = {
      apikey: ANON_KEY,
      Authorization: `Bearer ${this.jwt}`,
      'Content-Type': 'application/json',
      Prefer: prefer
    };

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const t0 = Date.now();
    const raw = await this._fetchWithRetry(url, opts);
    const ms = Date.now() - t0;

    return { data: raw.data, status: raw.status, ms };
  }

  // ─── INTERNALS ───────────────────────────────────────────────────────────

  async _fetchWithRetry(url, opts, retries = 3) {
    try {
      return await this._fetch(url, opts);
    } catch (err) {
      // Expired JWT — refresh and retry once
      if (err.status === 401 && retries > 0) {
        await this._refreshJwt();
        opts.headers.Authorization = `Bearer ${this.jwt}`;
        return this._fetchWithRetry(url, opts, retries - 1);
      }
      // Network error — wait and retry
      if (!err.status && retries > 0) {
        await sleep(1000);
        return this._fetchWithRetry(url, opts, retries - 1);
      }
      throw err;
    }
  }

  async _fetch(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      const err = new Error(
        `[EchoEntriesDB] HTTP ${res.status}: ${data?.message || data?.error || text}`
      );
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return { data, status: res.status };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = HttpClient;
