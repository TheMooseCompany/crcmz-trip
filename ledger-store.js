'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class LedgerError extends Error {
  constructor(cause) {
    super('Split ledger is unavailable. No changes were saved. Ask an administrator to check storage and recover the ledger from backup.', { cause });
    this.code = 'LEDGER_UNAVAILABLE';
    this.status = 503;
  }
}
function validate(raw) {
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.expenses) || !Array.isArray(value.settlements)) {
    throw new Error('Invalid ledger structure');
  }
  return value;
}
function createLedgerStore(filename, io = fs) {
  const backups = `${filename}.backups`;
  function atomicWrite(target, raw) {
    const tmp = `${target}.${crypto.randomUUID()}.tmp`;
    let fd;
    try {
      fd = io.openSync(tmp, 'wx', 0o600);
      io.writeFileSync(fd, raw);
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(tmp, target);
      const dir = io.openSync(path.dirname(target), 'r');
      try { io.fsyncSync(dir); } finally { io.closeSync(dir); }
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      try { io.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  function snapshot(raw) {
    validate(raw);
    io.mkdirSync(backups, { recursive: true });
    // Immutable content-addressed snapshots: never rotate away a good backup.
    const target = path.join(backups, `${crypto.createHash('sha256').update(raw).digest('hex')}.json`);
    try {
      const existing = io.readFileSync(target, 'utf8');
      if (existing !== raw) throw new Error('Backup integrity check failed');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      atomicWrite(target, raw);
    }
  }
  function read() {
    try {
      let raw;
      try { raw = io.readFileSync(filename, 'utf8'); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        // A backup directory is durable evidence of previous initialization.
        // lstat also rejects dangling symlinks instead of treating them as new.
        try { io.lstatSync(filename); throw new Error('Ledger path exists'); }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        try { io.lstatSync(backups); throw new Error('Ledger missing after initialization'); }
        catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
        io.mkdirSync(path.dirname(filename), { recursive: true });
        raw = JSON.stringify({ expenses: [], settlements: [] }, null, 2);
        snapshot(raw);
        atomicWrite(filename, raw);
      }
      return validate(raw);
    } catch (e) { throw new LedgerError(e); }
  }
  function write(value) {
    try {
      const raw = JSON.stringify(value, null, 2);
      validate(raw);
      // Re-read and validate immediately before any write, even if the caller
      // previously read successfully. All app mutations are synchronous.
      read();
      const previous = io.readFileSync(filename, 'utf8');
      snapshot(previous);
      atomicWrite(filename, raw);
    } catch (e) { throw e instanceof LedgerError ? e : new LedgerError(e); }
  }
  function recover(source) {
    // Offline only: caller must stop the app and explicitly choose a snapshot.
    const raw = io.readFileSync(source, 'utf8');
    validate(raw);
    io.mkdirSync(path.dirname(filename), { recursive: true });
    let preserved = null;
    try {
      preserved = `${filename}.damaged-${crypto.randomUUID()}`;
      io.copyFileSync(filename, preserved, fs.constants.COPYFILE_EXCL);
      const fd = io.openSync(preserved, 'r');
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    } catch (e) { if (e.code !== 'ENOENT') throw e; preserved = null; }
    snapshot(raw);
    atomicWrite(filename, raw);
    return preserved;
  }
  return { read, write, recover };
}
module.exports = { createLedgerStore, LedgerError };

if (require.main === module) {
  const [action, source] = process.argv.slice(2);
  if (action !== 'recover' || !source) {
    console.error('Usage: node ledger-store.js recover /path/to/chosen-backup.json');
    process.exitCode = 1;
  } else {
    try {
      const target = process.env.LEDGER_PATH || path.join(__dirname, 'data', 'ledger.json');
      const preserved = createLedgerStore(target).recover(source);
      console.log(`Ledger recovered. Previous file preserved at: ${preserved || '(ledger was missing)'}`);
    } catch (e) { console.error(`Recovery failed: ${e.message}`); process.exitCode = 1; }
  }
}
