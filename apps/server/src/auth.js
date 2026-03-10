import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import pg from "pg";
const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_FILE = process.env.AUTH_FILE
  ? path.resolve(process.env.AUTH_FILE)
  : path.join(__dirname, "..", "auth-data.json");

const DATABASE_URL = process.env.DATABASE_URL || "";
const USE_POSTGRES = Boolean(DATABASE_URL);
const AUTH_TABLE = "auth_state_store";
const pool = USE_POSTGRES ? new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSL_DISABLE === "true" ? false : { rejectUnauthorized: false }
}) : null;

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-env";
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || "7d";
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

const parseDurationMs = (value) => {
  const match = String(value).trim().match(/^(\d+)([smhd])$/i);
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const unitMap = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return amount * unitMap[unit];
};

const refreshTtlMs = parseDurationMs(REFRESH_TOKEN_EXPIRES_IN);

const baselineUserSpecs = [
  { id: "user-admin", role: "admin", username: "admin", name: "Admin User", password: "admin123" },
  { id: "user-rep-1", role: "cashier", username: "rep1", name: "Rep 1", password: "rep123" },
  { id: "user-rep-2", role: "cashier", username: "rep2", name: "Rep 2", password: "rep123" },
  { id: "user-rep-3", role: "cashier", username: "rep3", name: "Rep 3", password: "rep123" }
];

const createBaselineUser = (spec) => ({
  id: spec.id,
  role: spec.role,
  username: spec.username,
  name: spec.name,
  passwordHash: bcrypt.hashSync(spec.password, BCRYPT_ROUNDS),
  active: true,
  createdAt: new Date().toISOString()
});

const defaultUsers = baselineUserSpecs.map(createBaselineUser);

const normalizeUsers = (incomingUsers) => {
  const users = Array.isArray(incomingUsers) ? [...incomingUsers] : [];
  let changed = false;

  for (const spec of baselineUserSpecs) {
    const existing = users.find((item) => item.username === spec.username);
    if (!existing) {
      users.push(createBaselineUser(spec));
      changed = true;
      continue;
    }
    if (existing.role !== spec.role || existing.id !== spec.id || existing.active !== true) {
      existing.role = spec.role;
      existing.id = spec.id;
      existing.active = true;
      changed = true;
    }
    if (!existing.name) {
      existing.name = spec.name;
      changed = true;
    }
  }

  for (const user of users) {
    if (user.role === "cashier" && user.username === "cashier" && user.active !== false) {
      user.active = false;
      changed = true;
    }
  }

  return { users, changed };
};

const seedAuthState = { users: defaultUsers, refreshTokens: [] };

const ensurePgAuthStore = async () => {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${AUTH_TABLE} (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

const writeAuthStateFile = (state) => {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), "utf8");
};

const readAuthStateFile = () => {
  if (!fs.existsSync(AUTH_FILE)) {
    writeAuthStateFile(seedAuthState);
    return structuredClone(seedAuthState);
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    const sourceUsers = Array.isArray(parsed.users) && parsed.users.length ? parsed.users : defaultUsers;
    const normalized = normalizeUsers(sourceUsers);
    const state = {
      users: normalized.users,
      refreshTokens: Array.isArray(parsed.refreshTokens) ? parsed.refreshTokens : []
    };
    if (normalized.changed) writeAuthStateFile(state);
    return state;
  } catch {
    writeAuthStateFile(seedAuthState);
    return structuredClone(seedAuthState);
  }
};

const writeAuthStatePg = async (state) => {
  if (!pool) return;
  await ensurePgAuthStore();
  await pool.query(`
    INSERT INTO ${AUTH_TABLE} (id, state, updated_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW();
  `, [JSON.stringify(state)]);
};

const readAuthStatePg = async () => {
  if (!pool) return null;
  await ensurePgAuthStore();
  const result = await pool.query(`SELECT state FROM ${AUTH_TABLE} WHERE id = 1;`);
  if (result.rows.length) {
    const parsed = result.rows[0].state || {};
    const sourceUsers = Array.isArray(parsed.users) && parsed.users.length ? parsed.users : defaultUsers;
    const normalized = normalizeUsers(sourceUsers);
    const state = {
      users: normalized.users,
      refreshTokens: Array.isArray(parsed.refreshTokens) ? parsed.refreshTokens : []
    };
    if (normalized.changed) await writeAuthStatePg(state);
    return state;
  }
  const seed = readAuthStateFile();
  await writeAuthStatePg(seed);
  return seed;
};

let cachedAuthState = USE_POSTGRES ? await readAuthStatePg() : readAuthStateFile();
let authWriteQueue = Promise.resolve();

const persistAuthState = (state) => {
  if (!USE_POSTGRES) {
    writeAuthStateFile(state);
    return;
  }
  authWriteQueue = authWriteQueue
    .then(() => writeAuthStatePg(state))
    .catch((error) => {
      console.error("Postgres auth write failed:", error?.message || error);
    });
};

const updateAuthState = (updater) => {
  const next = updater(structuredClone(cachedAuthState));
  cachedAuthState = next;
  persistAuthState(next);
  return next;
};

const nowIso = () => new Date().toISOString();

const sanitizeUser = (user) => ({
  id: user.id,
  role: user.role,
  username: user.username,
  name: user.name
});

const buildAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, username: user.username, name: user.name },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );

const hashRefreshToken = (token) => crypto.createHash("sha256").update(token).digest("hex");
const createRefreshTokenValue = () => crypto.randomBytes(48).toString("hex");

const issueRefreshToken = (userId) => {
  const token = createRefreshTokenValue();
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + refreshTtlMs).toISOString();
  const entry = { id: crypto.randomUUID(), userId, tokenHash, createdAt: nowIso(), expiresAt, revokedAt: null };

  updateAuthState((state) => {
    state.refreshTokens.push(entry);
    return state;
  });

  return token;
};

const revokeTokenByHash = (tokenHash) => {
  updateAuthState((state) => {
    const token = state.refreshTokens.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
    if (token) token.revokedAt = nowIso();
    return state;
  });
};

const resolveRefreshToken = (refreshToken) => {
  const tokenHash = hashRefreshToken(refreshToken);
  const state = cachedAuthState;
  const token = state.refreshTokens.find((item) => item.tokenHash === tokenHash && !item.revokedAt);
  if (!token) return null;
  if (new Date(token.expiresAt).getTime() <= Date.now()) return null;

  const user = state.users.find((item) => item.id === token.userId && item.active);
  if (!user) return null;
  return { token, user, tokenHash };
};

export const loginUser = async ({ role, username, password }) => {
  const state = cachedAuthState;
  const user = state.users.find((item) => item.username === username && item.role === role && item.active);
  if (!user) return null;

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return null;

  const cleanUser = sanitizeUser(user);
  const accessToken = buildAccessToken(cleanUser);
  const refreshToken = issueRefreshToken(cleanUser.id);
  return { user: cleanUser, accessToken, refreshToken };
};

export const rotateRefreshToken = (refreshToken) => {
  const resolved = resolveRefreshToken(refreshToken);
  if (!resolved) return null;

  revokeTokenByHash(resolved.tokenHash);
  const cleanUser = sanitizeUser(resolved.user);
  return {
    user: cleanUser,
    accessToken: buildAccessToken(cleanUser),
    refreshToken: issueRefreshToken(cleanUser.id)
  };
};

export const revokeRefreshToken = (refreshToken) => {
  if (!refreshToken) return;
  revokeTokenByHash(hashRefreshToken(refreshToken));
};

export const verifyAccessToken = (token) => jwt.verify(token, JWT_SECRET);
export const listUsers = () => cachedAuthState.users.map(sanitizeUser);

export const getAuthStoreMeta = () => ({
  mode: USE_POSTGRES ? "postgres" : "file",
  authFile: AUTH_FILE,
  postgresTable: USE_POSTGRES ? AUTH_TABLE : null
});

export const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) {
    res.status(401).json({ message: "Missing access token" });
    return;
  }
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired access token" });
  }
};

export const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    res.status(403).json({ message: "Insufficient permissions" });
    return;
  }
  next();
};

export const extractSocketToken = (socket) => {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;
  const header = socket.handshake.headers?.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
};
