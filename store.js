

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- local files (fallback + migration source) ----------
const PROJECT_DATA_DIR = path.join(__dirname, 'data');
const DATA_FILES = ['tasks.json', 'config.json', 'activity.json', 'users.json'];

function resolveDataDir() {
  const candidates = [];
  if (process.env.MEOW_DATA_DIR) candidates.push(path.resolve(process.env.MEOW_DATA_DIR));
  candidates.push(path.join(os.homedir(), '.meow', 'data'));
  candidates.push(PROJECT_DATA_DIR);

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-test-' + process.pid);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      if (dir !== PROJECT_DATA_DIR) migrateFromOldLocal(dir);
      return dir;
    } catch (e) { /* try next */ }
  }
  return PROJECT_DATA_DIR;
}

// one-time: pull data out of the in-project ./data folder
function migrateFromOldLocal(newDir) {
  for (const f of DATA_FILES) {
    const src = path.join(PROJECT_DATA_DIR, f);
    const dest = path.join(newDir, f);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        console.log('[meow] migrated data/' + f + ' → ' + dest);
      }
    } catch (e) { /* ignore */ }
  }
}

const DATA_DIR = resolveDataDir();
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const DEFAULT_CONFIG = {
  timezone: 'Asia/Kolkata',
  admin: { passwordHash: '' },
  telegram: { bots: [], defaultBotId: null, chatId: '' },
  email: {
    host: 'smtp.gmail.com', port: 587, secure: false,
    user: '', pass: '', from: '', to: ''
  }
};

function hashPassword(pw) {
  return crypto.createHash('sha256').update('meow-salt:' + pw).digest('hex');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function mergeConfig(raw) {
  raw = raw || {};
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    admin: { ...DEFAULT_CONFIG.admin, ...(raw.admin || {}) },
    telegram: { ...DEFAULT_CONFIG.telegram, ...(raw.telegram || {}) },
    email: { ...DEFAULT_CONFIG.email, ...(raw.email || {}) }
  };
}

// ---------- local files: first-run bootstrap ----------
function ensureLocalFiles() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(TASKS_FILE)) {
    const now = new Date();
    const inTwoMin = new Date(now.getTime() + 2 * 60 * 1000);
    const tomorrow9 = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    tomorrow9.setHours(9, 0, 0, 0);
    if (tomorrow9 <= now) tomorrow9.setDate(tomorrow9.getDate() + 1);
    writeJson(TASKS_FILE, [
      { id: 'seed-1', title: 'Demo: this reminder fires 2 minutes after you start the app', dueAt: inTwoMin.toISOString(), createdAt: now.toISOString(), done: false },
      { id: 'seed-2', title: 'Submit project report', dueAt: tomorrow9.toISOString(), createdAt: now.toISOString(), done: false },
      { id: 'seed-3', title: 'Morning check-in', dueAt: null, createdAt: now.toISOString(), done: false, recurring: { type: 'weekdays' }, time: { h: 9, m: 0 } }
    ]);
  }
  if (!fs.existsSync(CONFIG_FILE)) writeJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (!fs.existsSync(ACTIVITY_FILE)) writeJson(ACTIVITY_FILE, []);
  if (!fs.existsSync(USERS_FILE)) writeJson(USERS_FILE, []);

  // migrate an old single-token config into the new bots[] list
  const raw = readJson(CONFIG_FILE, DEFAULT_CONFIG);
  if (raw.telegram && raw.telegram.botToken && (!raw.telegram.bots || !raw.telegram.bots.length)) {
    raw.telegram.bots = [{ id: 'b-migrated', token: raw.telegram.botToken, username: null }];
    if (!raw.telegram.defaultBotId) raw.telegram.defaultBotId = 'b-migrated';
    delete raw.telegram.botToken;
    writeJson(CONFIG_FILE, raw);
  }
  if (!raw.admin || !raw.admin.passwordHash) {
    raw.admin = raw.admin || {};
    const envPw = (process.env.MEOW_ADMIN_PASSWORD || '').trim();
    if (envPw.length >= 4) {
      // Deterministic: password comes from the environment (also a reset path).
      raw.admin.passwordHash = hashPassword(envPw);
      console.log('[meow] admin password initialised from MEOW_ADMIN_PASSWORD.');
    } else {
      // No password anywhere in the code: generate a one-time password and
      // print it once to the console. Change it after first login.
      const oneTime = crypto.randomBytes(9).toString('base64url');
      raw.admin.passwordHash = hashPassword(oneTime);
      console.log('\n============================================================');
      console.log('  MEOW: no admin password was set, so a one-time password');
      console.log('  was generated. Log in at /admin with it, then change it');
      console.log('  (Admin → Change password).');
      console.log('');
      console.log('  One-time admin password:  ' + oneTime);
      console.log('');
      console.log('  Lost it? Restart with MEOW_ADMIN_PASSWORD=<new> to reset,');
      console.log('  or delete the admin hash from your data/config file.');
      console.log('============================================================\n');
    }
    writeJson(CONFIG_FILE, raw);
  }
}

// ---------- in-memory state ----------
let tasks = [];
let users = [];
let activity = [];
let config = mergeConfig(readJson(CONFIG_FILE, DEFAULT_CONFIG));

// ---------- backend state ----------
let mongoClient = null;
let mongoDb = null;
let backend = { driver: 'files', connected: false, error: null };
const mongoReady = () => !!mongoDb;

// ---------- Mongo helpers ----------
function toDoc(doc) {
  const d = { ...doc };
  if (!d._id) {
    if (doc.chatId !== undefined) d._id = 'u_' + doc.chatId;
    else if (doc.id) d._id = doc.id;
  }
  return d;
}
function fromDoc(d) { const c = { ...d }; delete c._id; return c; }

async function connectMongo(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  await client.db('meow').command({ ping: 1 });
  mongoClient = client;
  mongoDb = client.db('meow');
  backend = { driver: 'mongo', connected: true, error: null };
}

async function loadFromMongo() {
  const [t, u, a, c] = await Promise.all([
    mongoDb.collection('tasks').find({}).toArray(),
    mongoDb.collection('users').find({}).toArray(),
    mongoDb.collection('activity').find({}).toArray(),
    mongoDb.collection('config').findOne({ _id: 'main' })
  ]);
  tasks = t.map(fromDoc);
  users = u.map(fromDoc);
  activity = a.map(fromDoc).slice(-200);
  if (c) config = mergeConfig(c);
}

// One-way: fill empty Mongo collections from local files. Never overwrites.
async function migrateLocalIntoMongo() {
  const results = {};
  const pairs = [['users', USERS_FILE], ['tasks', TASKS_FILE], ['activity', ACTIVITY_FILE]];
  for (const [colName, file] of pairs) {
    const count = await mongoDb.collection(colName).countDocuments();
    const local = readJson(file, []);
    if (count === 0 && local.length) {
      await mongoDb.collection(colName).insertMany(local.map(toDoc), { ordered: false });
      results[colName] = local.length;
    }
  }
  const cfgCount = await mongoDb.collection('config').countDocuments();
  if (cfgCount === 0) {
    const localCfg = readJson(CONFIG_FILE, null);
    if (localCfg) {
      await mongoDb.collection('config').insertOne(toDoc({ _id: 'main', ...localCfg }));
      results.config = true;
      config = mergeConfig(localCfg);
    }
  }
  return results;
}

// ---------- persist (write-through to active backend) ----------
async function persistTasks() {
  if (mongoReady()) {
    const col = mongoDb.collection('tasks');
    await col.deleteMany({});
    if (tasks.length) await col.insertMany(tasks.map(toDoc), { ordered: false });
    return;
  }
  writeJson(TASKS_FILE, tasks);
}
async function persistUsers() {
  if (mongoReady()) {
    const col = mongoDb.collection('users');
    await col.deleteMany({});
    if (users.length) await col.insertMany(users.map(toDoc), { ordered: false });
    return;
  }
  writeJson(USERS_FILE, users);
}
async function persistActivity() {
  if (mongoReady()) {
    const col = mongoDb.collection('activity');
    await col.deleteMany({});
    if (activity.length) await col.insertMany(activity.map(toDoc), { ordered: false });
    return;
  }
  writeJson(ACTIVITY_FILE, activity);
}
async function persistConfig() {
  const local = readJson(CONFIG_FILE, {});
  if (mongoReady()) {
    const doc = {
      _id: 'main',
      timezone: config.timezone,
      admin: config.admin,
      telegram: config.telegram,
      email: config.email,
      mongoUri: local.mongoUri || ''
    };
    await mongoDb.collection('config').replaceOne({ _id: 'main' }, doc, { upsert: true });
    return;
  }
  writeJson(CONFIG_FILE, {
    ...local,
    timezone: config.timezone,
    admin: config.admin,
    telegram: config.telegram,
    email: config.email
  });
}

// ---------- public API (same shape as before) ----------
function getTasks() { return tasks; }
function getUsers() { return users; }
function getConfig() { return config; }
function getActivity() { return activity; }
function getDataDir() { return DATA_DIR; }

async function saveTasks(list) { tasks = list; await persistTasks(); }
async function saveUsers(list) { users = list; await persistUsers(); }
async function saveConfig(cfg) { config = mergeConfig(cfg); await persistConfig(); }
async function addActivity(entry) {
  activity.push(entry);
  if (activity.length > 200) activity.splice(0, activity.length - 200);
  await persistActivity();
}

// ---------- database management ----------
function maskUri(uri) {
  if (!uri) return '';
  try {
    const u = new URL(uri);
    if (u.password) u.password = u.password.length > 6 ? '••••' + u.password.slice(-2) : '••••';
    return u.toString();
  } catch (e) {
    return uri.slice(0, 14) + '…';
  }
}

function getDatabaseInfo() {
  const local = readJson(CONFIG_FILE, {});
  const uri = local.mongoUri || '';
  return {
    driver: backend.driver,
    connected: backend.connected,
    error: backend.error || null,
    uri,
    uriMasked: maskUri(uri)
  };
}

// Full bootstrap: local files first, then (if configured) switch to Mongo.
async function initStore() {
  ensureLocalFiles();
  const localCfg = readJson(CONFIG_FILE, {});
  config = mergeConfig(localCfg);
  const uri = (process.env.MEOW_MONGO_URI || localCfg.mongoUri || '').trim();

  if (uri) {
    try {
      await connectMongo(uri);
      await loadFromMongo();
      const migrated = await migrateLocalIntoMongo();
      if (Object.keys(migrated).length) {
        console.log('[meow] migrated local data into MongoDB:', JSON.stringify(migrated));
      }
      console.log('[meow] using MongoDB (cloud) for data.');
      return;
    } catch (e) {
      mongoDb = null;
      mongoClient = null;
      backend = { driver: 'files', connected: false, error: e.message };
      console.error('[meow] MongoDB connection failed — using local files for now. Error:', e.message);
    }
  }

  tasks = readJson(TASKS_FILE, []);
  users = readJson(USERS_FILE, []);
  activity = readJson(ACTIVITY_FILE, []);
  if (!uri) console.log('[meow] using local files for data (no database configured yet).');
}

// Connect a (new) database: test it, load from it, migrate local data in,
// and remember the URI. Restores previous state if the new one fails.
async function setDatabase(uri) {
  uri = (uri || '').trim();
  if (!uri) throw new Error('Paste your MongoDB connection string.');
  if (!/^mongodb(\+srv)?:\/\//i.test(uri)) {
    throw new Error("That doesn't look like a MongoDB connection string (it should start with mongodb:// or mongodb+srv://).");
  }

  const prev = {
    client: mongoClient, db: mongoDb, tasks, users, activity, config, backend
  };
  try {
    await connectMongo(uri);
    await loadFromMongo();
    const migrated = await migrateLocalIntoMongo();

    const local = readJson(CONFIG_FILE, {});
    writeJson(CONFIG_FILE, { ...local, mongoUri: uri });
    await persistConfig();

    console.log('[meow] database connected.' + (Object.keys(migrated).length ? ' Migrated: ' + JSON.stringify(migrated) : ''));
    return getDatabaseInfo();
  } catch (e) {
    mongoClient = prev.client;
    mongoDb = prev.db;
    tasks = prev.tasks; users = prev.users; activity = prev.activity;
    config = prev.config; backend = prev.backend;
    throw new Error('Could not connect to that database: ' + (e.message || e));
  }
}

module.exports = {
  ensureLocalFiles,
  initStore,
  setDatabase,
  getDatabaseInfo,
  getDataDir: () => DATA_DIR,
  getTasks,
  saveTasks,
  getUsers,
  saveUsers,
  getConfig,
  saveConfig,
  getActivity,
  addActivity,
  hashPassword
};
