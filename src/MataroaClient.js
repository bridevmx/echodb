'use strict';

/**
 * HTTP and API client for Mataroa (https://mataroa.blog).
 * Supports automatic account registration, authentication, API key extraction,
 * and CRUD operations on Mataroa pages and posts.
 */

const MATAROA_BASE_URL = 'https://mataroa.blog';

class MataroaClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]      - Mataroa API key (Bearer token)
   * @param {string} [opts.baseUrl]     - Base URL (default: 'https://mataroa.blog/api')
   */
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || null;
    this.baseUrl = opts.baseUrl || `${MATAROA_BASE_URL}/api`;
  }

  // ─── AUTHENTICATION & REGISTRATION HELPERS ─────────────────────────────────

  /**
   * Automatically register a new account on mataroa.blog and extract its API key.
   *
   * Steps:
   *  1. GET /accounts/create/ (extract initial CSRF token & cookie)
   *  2. POST /accounts/create/ (redirects to /accounts/humanity-diagnostics/<uuid>/)
   *  3. GET /accounts/humanity-diagnostics/<uuid>/ (extract diagnosis CSRF token)
   *  4. POST /accounts/humanity-diagnostics/<uuid>/ (submits credentials, sets sessionid)
   *  5. GET /api/docs/ (parses HTML with session cookie to extract API key)
   *
   * @param {object} params
   * @param {string} params.username   - Subdomain, lowercase alphanumeric (no spaces)
   * @param {string} params.password   - Minimum 8 chars, not similar to username
   * @param {string} [params.email]    - Optional recovery email
   * @returns {Promise<{ username: string, email: string, apiKey: string, sessionid: string }>}
   */
  static async register({ username, password, email = '' }) {
    if (!username || typeof username !== 'string') {
      throw new Error('[MataroaClient] register() requires a username string.');
    }
    if (!password || typeof password !== 'string') {
      throw new Error('[MataroaClient] register() requires a password string.');
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(cleanUsername)) {
      throw new Error(`[MataroaClient] Invalid username '${username}'. Must be lowercase alphanumeric only.`);
    }
    if (password.length < 8) {
      throw new Error('[MataroaClient] Password must be at least 8 characters.');
    }

    // Step 1: GET /accounts/create/
    const step1Res = await fetch(`${MATAROA_BASE_URL}/accounts/create/`);
    let csrfCookie = extractCookie(step1Res, 'csrftoken');
    const step1Html = await step1Res.text();
    const csrfToken1 = extractCsrfToken(step1Html);
    if (!csrfToken1) throw new Error('[MataroaClient] Could not find CSRF token on create page.');

    // Step 2: POST /accounts/create/
    const step2Res = await fetch(`${MATAROA_BASE_URL}/accounts/create/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': `csrftoken=${csrfCookie}`,
        'referer': `${MATAROA_BASE_URL}/accounts/create/`
      },
      body: `csrfmiddlewaretoken=${encodeURIComponent(csrfToken1)}`,
      redirect: 'manual'
    });

    const redirectLocation = step2Res.headers.get('location');
    if (!redirectLocation) {
      throw new Error(`[MataroaClient] Step 2 failed: expected redirect, got status ${step2Res.status}`);
    }

    // Step 3: GET /accounts/humanity-diagnostics/<uuid>/
    const diagUrl = new URL(redirectLocation, MATAROA_BASE_URL).toString();
    const step3Res = await fetch(diagUrl, {
      headers: {
        'cookie': `csrftoken=${csrfCookie}`,
        'referer': `${MATAROA_BASE_URL}/accounts/create/`
      }
    });

    const newCsrfCookie = extractCookie(step3Res, 'csrftoken');
    if (newCsrfCookie) csrfCookie = newCsrfCookie;

    const step3Html = await step3Res.text();
    const csrfToken2 = extractCsrfToken(step3Html);
    if (!csrfToken2) throw new Error('[MataroaClient] Could not find CSRF token on diagnostics page.');

    // Step 4: POST /accounts/humanity-diagnostics/<uuid>/
    const bodyParams = new URLSearchParams({
      username: cleanUsername,
      email: email.trim(),
      password1: password,
      password2: password,
      csrfmiddlewaretoken: csrfToken2
    });

    const step4Res = await fetch(diagUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': `csrftoken=${csrfCookie}`,
        'referer': diagUrl,
        'origin': MATAROA_BASE_URL
      },
      body: bodyParams.toString(),
      redirect: 'manual'
    });

    if (step4Res.status === 200) {
      // Form validation error in Django
      const errorHtml = await step4Res.text();
      const formErrorMatch = errorHtml.match(/<span class=["']form-error["']>([^<]+)<\/span>/i) ||
                             errorHtml.match(/<ul class=["']errorlist["']>([\s\S]*?)<\/ul>/i);
      const errMsg = formErrorMatch ? stripHtml(formErrorMatch[0]) : 'Registration failed form validation';
      throw new Error(`[MataroaClient] Registration rejected: ${errMsg}`);
    }

    const sessionid = extractCookie(step4Res, 'sessionid');
    const finalCsrf = extractCookie(step4Res, 'csrftoken') || csrfCookie;

    if (!sessionid) {
      throw new Error(`[MataroaClient] No sessionid returned after registration. Status: ${step4Res.status}`);
    }

    // Step 5: GET /api/docs/ to extract API key
    const apiKey = await MataroaClient.fetchApiKeyFromDocs(sessionid, finalCsrf);

    return {
      username: cleanUsername,
      email: email.trim(),
      apiKey,
      sessionid
    };
  }

  /**
   * Log into an existing account on mataroa.blog and retrieve its API key.
   *
   * @param {object} params
   * @param {string} params.username
   * @param {string} params.password
   * @returns {Promise<{ username: string, apiKey: string, sessionid: string }>}
   */
  static async login({ username, password }) {
    if (!username || !password) {
      throw new Error('[MataroaClient] login() requires username and password.');
    }

    const cleanUsername = username.trim().toLowerCase();

    // 1. GET /accounts/login/
    const loginPageRes = await fetch(`${MATAROA_BASE_URL}/accounts/login/`);
    let csrfCookie = extractCookie(loginPageRes, 'csrftoken');
    const loginHtml = await loginPageRes.text();
    const csrfToken = extractCsrfToken(loginHtml);
    if (!csrfToken) throw new Error('[MataroaClient] Could not find CSRF token on login page.');

    // 2. POST /accounts/login/
    const postRes = await fetch(`${MATAROA_BASE_URL}/accounts/login/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cookie': `csrftoken=${csrfCookie}`,
        'referer': `${MATAROA_BASE_URL}/accounts/login/`,
        'origin': MATAROA_BASE_URL
      },
      body: new URLSearchParams({
        username: cleanUsername,
        password,
        csrfmiddlewaretoken: csrfToken
      }).toString(),
      redirect: 'manual'
    });

    if (postRes.status === 200) {
      const errorHtml = await postRes.text();
      const formErrorMatch = errorHtml.match(/<span class=["']form-error["']>([^<]+)<\/span>/i) ||
                             errorHtml.match(/<ul class=["']errorlist["']>([\s\S]*?)<\/ul>/i);
      const errMsg = formErrorMatch ? stripHtml(formErrorMatch[0]) : 'Invalid credentials';
      throw new Error(`[MataroaClient] Login failed: ${errMsg}`);
    }

    const sessionid = extractCookie(postRes, 'sessionid');
    const finalCsrf = extractCookie(postRes, 'csrftoken') || csrfCookie;

    if (!sessionid) {
      throw new Error('[MataroaClient] No sessionid received from login.');
    }

    // 3. Retrieve API Key
    const apiKey = await MataroaClient.fetchApiKeyFromDocs(sessionid, finalCsrf);

    return {
      username: cleanUsername,
      apiKey,
      sessionid
    };
  }

  /**
   * Fetches /api/docs/ with an authenticated session and scrapes the personal API Key.
   *
   * @param {string} sessionid
   * @param {string} [csrftoken]
   * @returns {Promise<string>}
   */
  static async fetchApiKeyFromDocs(sessionid, csrftoken = '') {
    const cookieHeader = `sessionid=${sessionid}${csrftoken ? `; csrftoken=${csrftoken}` : ''}`;
    const docsRes = await fetch(`${MATAROA_BASE_URL}/api/docs/`, {
      headers: {
        'cookie': cookieHeader,
        'referer': `${MATAROA_BASE_URL}/dashboard/`
      }
    });

    const docsHtml = await docsRes.text();
    const keyMatch = docsHtml.match(/API Key<\/h2>[\s\S]*?<code>([^<]+)<\/code>/i) ||
                     docsHtml.match(/API Key[\s\S]*?<code>([^<]+)<\/code>/i);

    const apiKey = keyMatch ? keyMatch[1].trim() : null;
    if (!apiKey || apiKey === 'your-api-key') {
      throw new Error('[MataroaClient] Could not find valid API key in /api/docs/. Ensure account is logged in.');
    }

    return apiKey;
  }

  // ─── REST API CALLS ────────────────────────────────────────────────────────

  /**
   * Execute an authenticated request against the Mataroa API.
   * Endpoints automatically ensure a trailing slash per Mataroa specification.
   *
   * @param {'GET'|'POST'|'PATCH'|'DELETE'} method
   * @param {string} endpoint - e.g. 'pages/', 'posts/my-slug/'
   * @param {object} [body]
   * @returns {Promise<{ ok: boolean, data: any, status: number, ms: number }>}
   */
  async request(method, endpoint, body = null) {
    if (!this.apiKey) {
      throw new Error('[MataroaClient] API key is required. Call register(), login(), or pass apiKey in constructor.');
    }

    // Mataroa requires trailing slash on all endpoints
    let cleanEndpoint = endpoint.replace(/^\/+/, '');
    if (!cleanEndpoint.endsWith('/')) {
      cleanEndpoint += '/';
    }

    const url = `${this.baseUrl}/${cleanEndpoint}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    const opts = { method, headers };
    if (body) {
      opts.body = JSON.stringify(body);
    }

    const t0 = Date.now();
    const raw = await this._fetchWithRetry(url, opts);
    const ms = Date.now() - t0;

    return { ok: raw.data?.ok ?? (raw.status >= 200 && raw.status < 300), data: raw.data, status: raw.status, ms };
  }

  // ─── Pages API ─────────────────────────────────────────────────────────────

  async listPages() {
    const res = await this.request('GET', 'pages/');
    return res.data?.page_list || [];
  }

  async getPage(slug) {
    const res = await this.request('GET', `pages/${slug}/`);
    return res.data;
  }

  async createPage({ title, slug, body = '', is_hidden = true }) {
    const res = await this.request('POST', 'pages/', {
      title,
      slug,
      body,
      is_hidden: Boolean(is_hidden)
    });
    return res.data;
  }

  async updatePage(slug, { title, body, is_hidden } = {}) {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (is_hidden !== undefined) payload.is_hidden = Boolean(is_hidden);

    const res = await this.request('PATCH', `pages/${slug}/`, payload);
    return res.data;
  }

  async deletePage(slug) {
    const res = await this.request('DELETE', `pages/${slug}/`);
    return res.data;
  }

  // ─── Posts API ─────────────────────────────────────────────────────────────

  async listPosts() {
    const res = await this.request('GET', 'posts/');
    return res.data?.post_list || [];
  }

  async getPost(slug) {
    const res = await this.request('GET', `posts/${slug}/`);
    return res.data;
  }

  async createPost({ title, body = '', published_at = null }) {
    const res = await this.request('POST', 'posts/', {
      title,
      body,
      published_at
    });
    return res.data;
  }

  async updatePost(slug, { title, body, published_at } = {}) {
    const payload = {};
    if (title !== undefined) payload.title = title;
    if (body !== undefined) payload.body = body;
    if (published_at !== undefined) payload.published_at = published_at;

    const res = await this.request('PATCH', `posts/${slug}/`, payload);
    return res.data;
  }

  async deletePost(slug) {
    const res = await this.request('DELETE', `posts/${slug}/`);
    return res.data;
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  async _fetchWithRetry(url, opts, retries = 3) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

      if (!res.ok) {
        const msg = data?.error || data?.detail || data?.message || text || `HTTP ${res.status}`;
        const err = new Error(`[MataroaClient] HTTP ${res.status}: ${msg}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return { data, status: res.status };
    } catch (err) {
      if (!err.status && retries > 0) {
        await sleep(1000);
        return this._fetchWithRetry(url, opts, retries - 1);
      }
      throw err;
    }
  }
}

// ─── Helper Functions ────────────────────────────────────────────────────────

function extractCookie(res, name) {
  const rawSetCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')];

  for (const c of rawSetCookies) {
    if (!c) continue;
    const match = c.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

function extractCsrfToken(html) {
  const match = html.match(/name=["']csrfmiddlewaretoken["']\s+value=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = MataroaClient;
