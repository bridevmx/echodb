'use strict';

const EchoEntriesDB = require('./src/EchoEntriesDB');
const MataroaDB     = require('./src/MataroaDB');
const MataroaClient = require('./src/MataroaClient');
const Collection    = require('./src/Collection');

/**
 * Unified EchoDB factory / entry-point.
 * Automatically resolves to the appropriate provider instance based on options:
 *  - 'mataroa': MataroaDB (https://mataroa.blog)
 *  - 'echoentries': EchoEntriesDB (default)
 */
class EchoDB {
  constructor(opts = {}) {
    if (opts.provider === 'mataroa' || opts.apiKey || (opts.username && !opts.email)) {
      return new MataroaDB(opts);
    }
    return new EchoEntriesDB(opts);
  }

  /**
   * Helper to register an account with a provider.
   * @param {object} opts
   * @param {'mataroa'|'echoentries'} [opts.provider]
   */
  static register(opts = {}) {
    if (opts.provider === 'mataroa' || opts.username) {
      return MataroaDB.register(opts);
    }
    return EchoEntriesDB.register(opts);
  }

  /**
   * Alias for register: provision a synchronized dual-host account.
   */
  static provisionAccount(opts = {}) {
    return EchoDB.register(opts);
  }
}

// Attach named exports to EchoDB class for seamless CJS/ESM interop
EchoDB.EchoDB           = EchoDB;
EchoDB.EchoEntriesDB    = EchoEntriesDB;
EchoDB.MataroaDB        = MataroaDB;
EchoDB.MataroaClient    = MataroaClient;
EchoDB.Collection       = Collection;
EchoDB.provisionAccount = EchoDB.register;
EchoDB.default          = EchoDB;

module.exports = EchoDB;
