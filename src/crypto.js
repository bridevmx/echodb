'use strict';

/**
 * Crypto layer — identical outer cipher to Echo Entries UI, plus an optional
 * inner cipher layer that even the EE app admin cannot read.
 *
 * Layer 1 (outer) — matches Echo Entries UI exactly:
 *   key  = PBKDF2(userId, salt="journal-encryption-salt", 100k iter, SHA-256) → AES-256-GCM
 *   wire = base64( randomIV[12] | AES-GCM-encrypt(plaintext) )
 *
 * Layer 2 (inner, optional) — applied BEFORE layer 1:
 *   key  = PBKDF2(userSecret, salt="echodb-inner-encryption", 100k iter, SHA-256) → AES-256-GCM
 *   wire = base64( randomIV[12] | AES-GCM-encrypt(plaintext) )
 *
 * Encrypt:  plain → [inner(userSecret)] → outer(userId) → wire
 * Decrypt:  wire  → outer(userId) → [inner(userSecret)] → plain
 *
 * If userSecret is not provided, only the outer layer is applied (still
 * compatible with Echo Entries UI decryption).
 */

const { webcrypto } = require('node:crypto');
const subtle = webcrypto.subtle;

// PBKDF2 parameters — outer must match EE UI exactly
const OUTER_SALT       = 'journal-encryption-salt'; // hardcoded in EE bundle
const INNER_SALT       = 'echodb-inner-encryption';
const PBKDF2_ITER      = 100_000;
const PBKDF2_HASH      = 'SHA-256';
const AES_KEY_BITS     = 256;
const IV_BYTES         = 12;

// Key cache — avoid re-deriving on every operation
const _keyCache = new Map();

/**
 * Derive an AES-GCM key from a passphrase and a fixed salt.
 * Result is cached in-process.
 * @param {string} passphrase
 * @param {string} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(passphrase, salt) {
  const cacheKey = `${salt}:${passphrase}`;
  if (_keyCache.has(cacheKey)) return _keyCache.get(cacheKey);

  const enc      = new TextEncoder();
  const rawPass  = enc.encode(passphrase);
  const rawSalt  = enc.encode(salt);

  const keyMaterial = await subtle.importKey(
    'raw', rawPass, { name: 'PBKDF2' }, false, ['deriveKey']
  );

  const key = await subtle.deriveKey(
    { name: 'PBKDF2', salt: rawSalt, iterations: PBKDF2_ITER, hash: PBKDF2_HASH },
    keyMaterial,
    { name: 'AES-GCM', length: AES_KEY_BITS },
    false,
    ['encrypt', 'decrypt']
  );

  _keyCache.set(cacheKey, key);
  return key;
}

/**
 * Encrypt a UTF-8 string with AES-GCM.
 * Returns base64( IV[12] | ciphertext+tag ).
 * @param {string} plaintext
 * @param {CryptoKey} key
 * @returns {Promise<string>} base64
 */
async function _aesEncrypt(plaintext, key) {
  const iv        = webcrypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded   = new TextEncoder().encode(plaintext);
  const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);

  const combined = new Uint8Array(IV_BYTES + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), IV_BYTES);

  return Buffer.from(combined).toString('base64');
}

/**
 * Decrypt a base64 AES-GCM blob produced by _aesEncrypt.
 * @param {string} cipherB64
 * @param {CryptoKey} key
 * @returns {Promise<string>} plaintext
 */
async function _aesDecrypt(cipherB64, key) {
  const buf       = Buffer.from(cipherB64, 'base64');
  const iv        = buf.subarray(0, IV_BYTES);
  const ct        = buf.subarray(IV_BYTES);
  const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(decrypted);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @param {string} userId      - Echo Entries user UUID (outer layer key input)
 * @param {string} [userSecret] - optional extra secret (inner layer)
 * @returns {Promise<string>}  base64 ciphertext ready for entry_text
 */
async function encrypt(plaintext, userId, userSecret) {
  let data = plaintext;

  // Inner layer first (if secret provided)
  if (userSecret) {
    const innerKey = await deriveKey(userSecret, INNER_SALT);
    data = await _aesEncrypt(data, innerKey);
  }

  // Outer layer — matches EE UI exactly
  const outerKey = await deriveKey(userId, OUTER_SALT);
  return _aesEncrypt(data, outerKey);
}

/**
 * Decrypt a ciphertext produced by encrypt().
 * @param {string} cipherB64
 * @param {string} userId
 * @param {string} [userSecret]
 * @returns {Promise<string>} original plaintext
 */
async function decrypt(cipherB64, userId, userSecret) {
  // Outer layer first
  const outerKey = await deriveKey(userId, OUTER_SALT);
  let data = await _aesDecrypt(cipherB64, outerKey);

  // Inner layer (if secret provided)
  if (userSecret) {
    const innerKey = await deriveKey(userSecret, INNER_SALT);
    data = await _aesDecrypt(data, innerKey);
  }

  return data;
}

module.exports = { encrypt, decrypt, deriveKey };
