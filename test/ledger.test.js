'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createLedgerStore } = require('../ledger-store');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'split-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'ledger.json');
  return { file, store: createLedgerStore(file) };
}
function unavailable(fn) { assert.throws(fn, { code: 'LEDGER_UNAVAILABLE', status: 503 }); }
test('first run initializes durable empty ledger; operations survive fresh process', t => {
  const { file, store } = fixture(t);
  assert.deepEqual(store.read(), { expenses: [], settlements: [] });
  const ledger = store.read();
  ledger.expenses.push({ id: 'expense', amountCentsCAD: 500 }); store.write(ledger);
  ledger.settlements.push({ id: 'settlement', amountCentsCAD: 250 }); store.write(ledger);
  const { execFileSync } = require('node:child_process');
  const raw = execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./ledger-store").createLedgerStore(process.argv[1]).read()))', file], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.deepEqual(JSON.parse(raw), ledger);
  assert.ok(fs.readdirSync(`${file}.backups`).length >= 2);
});
for (const raw of ['{broken', '', '{}', 'null', '{"expenses":[],"settlements":{}}']) {
  test(`damaged ledger blocks reads and writes: ${JSON.stringify(raw)}`, t => {
    const { file, store } = fixture(t); store.read();
    const backups = fs.readdirSync(`${file}.backups`);
    fs.writeFileSync(file, raw);
    unavailable(() => store.read());
    unavailable(() => store.write({ expenses: [], settlements: [] }));
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.deepEqual(fs.readdirSync(`${file}.backups`), backups);
  });
}
test('missing established ledger fails closed across restart', t => {
  const { file, store } = fixture(t); store.read(); fs.unlinkSync(file);
  unavailable(() => createLedgerStore(file).read());
  assert.equal(fs.existsSync(file), false);
});
for (const code of ['EACCES', 'EIO']) {
  test(`read failure ${code} never mutates files`, t => {
    const { file, store } = fixture(t); store.read(); const before = fs.readFileSync(file);
    const io = Object.create(fs);
    io.readFileSync = (target, ...args) => { if (target === file) throw Object.assign(new Error(code), { code }); return fs.readFileSync(target, ...args); };
    const broken = createLedgerStore(file, io);
    unavailable(() => broken.read()); unavailable(() => broken.write({ expenses: [], settlements: [] }));
    assert.deepEqual(fs.readFileSync(file), before);
  });
}
test('backup failure aborts write and preserves primary', t => {
  const { file, store } = fixture(t); store.read();
  const ledger = store.read(); ledger.expenses.push({ id: 'one' }); store.write(ledger);
  const before = fs.readFileSync(file);
  const io = Object.create(fs); io.mkdirSync = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  unavailable(() => createLedgerStore(file, io).write({ expenses: [], settlements: [] }));
  assert.deepEqual(fs.readFileSync(file), before);
});
test('explicit recovery validates backup and preserves damaged bytes', t => {
  const { file, store } = fixture(t); store.read();
  const ledger = store.read(); ledger.expenses.push({ id: 'saved' }); store.write(ledger);
  ledger.settlements.push({ id: 'next' }); store.write(ledger);
  const backup = fs.readdirSync(`${file}.backups`).map(n => path.join(`${file}.backups`, n)).find(p => JSON.parse(fs.readFileSync(p)).expenses.length);
  fs.writeFileSync(file, '{damaged');
  assert.throws(() => store.recover(file)); assert.equal(fs.readFileSync(file, 'utf8'), '{damaged');
  const preserved = store.recover(backup);
  assert.equal(fs.readFileSync(preserved, 'utf8'), '{damaged');
  assert.equal(store.read().expenses[0].id, 'saved');
});
// Exercise the actual synchronous server handlers without starting OIDC or
// any Photo Wall/startup routines. Production auth middleware is not changed.
function routes(file) {
  const handlers = {};
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, auth, handler) => { handlers[`${method} ${url}`] = handler; }]));
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const block = source.slice(source.indexOf('  const LEDGER_PATH ='), source.indexOf('  // Receipt uploads:'));
  vm.runInNewContext(block, { app, process: { env: { LEDGER_PATH: file } }, path, __dirname: path.join(__dirname, '..'), require: p => require(path.join(__dirname, '..', p)), crypto: require('node:crypto'), requireAuth() {}, activePeople: () => ['Moiz', 'Noor'], displayName: () => 'Moiz' });
  return (method, url, body = {}, id) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
    handlers[`${method} ${url}`]({ body, params: { id }, session: { user: {} } }, res);
    return res;
  };
}
test('expense and settlement create/delete handlers persist and reject damaged storage', t => {
  const { file } = fixture(t); let call = routes(file);
  const expense = { payer: 'Moiz', desc: 'Lunch', amountCentsCAD: 100, currency: 'CAD', shares: { Moiz: 50, Noor: 50 }, splitMode: 'equal' };
  const e = call('post', '/api/expenses', expense); assert.equal(e.statusCode, 201);
  const s = call('post', '/api/settlements', { from: 'Noor', to: 'Moiz', amountCentsCAD: 50 }); assert.equal(s.statusCode, 201);
  call = routes(file); assert.equal(call('get', '/api/expenses').body.expenses.length, 1);
  assert.equal(call('delete', '/api/expenses/:id', {}, e.body.expense.id).statusCode, 200);
  assert.equal(call('delete', '/api/settlements/:id', {}, s.body.settlement.id).statusCode, 200);
  fs.writeFileSync(file, '{bad');
  for (const [method, url, body] of [['get','/api/expenses',{}], ['post','/api/expenses',expense], ['post','/api/settlements',{ from:'Noor',to:'Moiz',amountCentsCAD:50 }], ['delete','/api/expenses/:id',{}], ['delete','/api/settlements/:id',{}]]) unavailable(() => call(method, url, body, 'id'));
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad');
});
test('failed primary rename preserves primary and its backup, removes temp files', t => {
  const { file, store } = fixture(t); store.read();
  const before = fs.readFileSync(file);
  const io = Object.create(fs);
  io.renameSync = (from, to) => { if (to === file) throw Object.assign(new Error('rename failed'), { code: 'EIO' }); return fs.renameSync(from, to); };
  unavailable(() => createLedgerStore(file, io).write({ expenses: [{ id: 'new' }], settlements: [] }));
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(path.dirname(file)).some(n => n.endsWith('.tmp')), false);
});
test('storage errors produce understandable JSON 503; unrelated errors pass through', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('  app.use((err, req, res, next) => {');
  let handler;
  vm.runInNewContext(source.slice(start, source.indexOf("  app.use((req, res) => res.status(404)", start)), { app: { use(fn) { handler = fn; } }, console: { error() {} } });
  const res = { status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  const { LedgerError } = require('../ledger-store');
  handler(new LedgerError(new Error('read failed')), {}, res, () => assert.fail());
  assert.equal(res.code, 503); assert.equal(res.body.code, 'LEDGER_UNAVAILABLE');
  assert.match(res.body.error, /administrator/);
  const other = new Error('other'); handler(other, {}, {}, err => assert.equal(err, other));
});
