import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedState } from "./seed.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, "..", "data.json");

const writeState = (state) => {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
};

const readState = () => {
  if (!fs.existsSync(DATA_FILE)) {
    writeState(seedState);
    return structuredClone(seedState);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      ...seedState,
      ...parsed,
      settings: { ...seedState.settings, ...(parsed.settings || {}) },
      products: parsed.products || seedState.products,
      sales: parsed.sales || [],
      returns: parsed.returns || [],
      customers: parsed.customers || [],
      staff: parsed.staff || []
    };
  } catch {
    writeState(seedState);
    return structuredClone(seedState);
  }
};

let cachedState = readState();

export const getState = () => cachedState;

export const updateState = (updater) => {
  const next = updater(structuredClone(cachedState));
  cachedState = next;
  writeState(cachedState);
  return cachedState;
};

