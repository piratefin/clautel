/**
 * Free license replacement: same export surface as src/license.ts but no
 * license checks. Always allows use and reports Max plan (unlimited bots).
 * Copy over src/license.ts after pulling upstream, e.g. run:
 *   node scripts/apply-free-license.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./config.js";

// --- Constants (minimal for helpers that are still used) ---

const DODO_CHECKOUT_URL = "https://checkout.dodopayments.com";
const DODO_CUSTOMER_URL = "https://customer.dodopayments.com";
const SUCCESS_PAGE_URL = "https://clautel.com/success";

export type PlanTier = "pro" | "max";

const PAYMENT_PRODUCTS: Record<PlanTier, string> = {
  pro: "pdt_0NZ6rPbGSyjuJsUJKmXaY",
  max: "pdt_0NZ6rUPAClxiXuf21uJYO",
};

const PLAN_LABELS: Record<PlanTier, string> = {
  pro: "Pro ($4/mo)",
  max: "Max ($9/mo)",
};

const PLAN_ORDER: Record<PlanTier, number> = { pro: 0, max: 1 };

const LICENSE_FILE = path.join(DATA_DIR, "license.json");
const INTEGRITY_KEY_FILE = path.join(DATA_DIR, ".integrity-key");
const INTEGRITY_KEY_LENGTH = 64;
const CLAUTEL_CONFIG_FILE = path.join(DATA_DIR, "config.json");

let _integrityKeyCache: Buffer | null = null;

function getIntegrityKey(): Buffer {
  if (_integrityKeyCache) return _integrityKeyCache;
  try {
    if (fs.existsSync(INTEGRITY_KEY_FILE)) {
      const key = fs.readFileSync(INTEGRITY_KEY_FILE);
      if (key.length === INTEGRITY_KEY_LENGTH) {
        _integrityKeyCache = key;
        return _integrityKeyCache;
      }
    }
  } catch {}
  const newKey = crypto.randomBytes(INTEGRITY_KEY_LENGTH);
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(INTEGRITY_KEY_FILE, newKey, { mode: 0o600 });
  _integrityKeyCache = newKey;
  return newKey;
}

// --- Types ---

export interface LicenseState {
  licenseKey: string | null;
  instanceId: string | null;
  status: "active" | "grace" | "expired";
  plan: PlanTier;
  lastValidatedAt: string | null;
  lastValidationResult: boolean;
  graceStartedAt: string | null;
  warningsSent: number;
  checksum: string;
  formatVersion?: number;
}

export interface LicenseCheckResult {
  allowed: boolean;
  warning?: string;
  reason?: string;
}

// --- Helpers (unchanged for CLI/manager) ---

export function getPaymentUrl(plan: PlanTier = "pro"): string {
  const product = PAYMENT_PRODUCTS[plan];
  const redirect = encodeURIComponent(SUCCESS_PAGE_URL);
  return `${DODO_CHECKOUT_URL}/buy/${product}?quantity=1&redirect_url=${redirect}`;
}

export function getPlanLabel(plan: PlanTier): string {
  return PLAN_LABELS[plan];
}

let _claudePlanCache: { tier: PlanTier; timestamp: number } | null = null;
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

function getStoredPlan(): PlanTier | null {
  try {
    if (fs.existsSync(CLAUTEL_CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CLAUTEL_CONFIG_FILE, "utf-8"));
      if (raw.claudePlan === "pro" || raw.claudePlan === "max") return raw.claudePlan;
    }
  } catch {}
  return null;
}

export function saveClaudePlan(tier: PlanTier): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    let existing: Record<string, unknown> = {};
    try {
      if (fs.existsSync(CLAUTEL_CONFIG_FILE)) {
        existing = JSON.parse(fs.readFileSync(CLAUTEL_CONFIG_FILE, "utf-8"));
      }
    } catch {}
    existing.claudePlan = tier;
    fs.writeFileSync(CLAUTEL_CONFIG_FILE, JSON.stringify(existing, null, 2), { mode: 0o600 });
    invalidatePlanCache();
  } catch {}
}

function autoDetectClaudePlan(): PlanTier {
  const claudeConfigPath = path.join(os.homedir(), ".claude.json");
  try {
    if (fs.existsSync(claudeConfigPath)) {
      const raw = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"));
      if (raw.hasOpusPlanDefault === true) return "max";
    }
  } catch {}
  return "pro";
}

export function detectClaudePlan(): { tier: PlanTier } {
  if (_claudePlanCache && Date.now() - _claudePlanCache.timestamp < PLAN_CACHE_TTL_MS) {
    return { tier: _claudePlanCache.tier };
  }
  const stored = getStoredPlan();
  const tier = stored ?? autoDetectClaudePlan();
  _claudePlanCache = { tier, timestamp: Date.now() };
  return { tier };
}

export function invalidatePlanCache(): void {
  _claudePlanCache = null;
}

export function isUnderLicensed(licensePlan: PlanTier, claudePlan: PlanTier): boolean {
  return PLAN_ORDER[claudePlan] > PLAN_ORDER[licensePlan];
}

export function isOverLicensed(licensePlan: PlanTier, claudePlan: PlanTier): boolean {
  return PLAN_ORDER[claudePlan] < PLAN_ORDER[licensePlan];
}

export function getCustomerPortalUrl(): string {
  return DODO_CUSTOMER_URL;
}

// --- Free build: always Max plan, unlimited bots ---

export function getBotLimit(_plan: PlanTier): number {
  return Infinity;
}

export function getLicensePlan(): PlanTier {
  return "max";
}

// --- State I/O (kept so load/save/defaultLicenseState still work) ---

export function computeChecksum(state: Omit<LicenseState, "checksum">): string {
  const payload = JSON.stringify({
    licenseKey: state.licenseKey,
    instanceId: state.instanceId,
    status: state.status,
    plan: state.plan,
    lastValidatedAt: state.lastValidatedAt,
    lastValidationResult: state.lastValidationResult,
    graceStartedAt: state.graceStartedAt,
    warningsSent: state.warningsSent,
    formatVersion: state.formatVersion,
  });
  return crypto.createHmac("sha256", getIntegrityKey()).update(payload).digest("hex");
}

export function generateInstanceName(ownerId?: number): string {
  const raw = `${os.hostname()}|${os.platform()}|${os.arch()}|${ownerId ?? ""}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export function defaultLicenseState(): LicenseState {
  const state: Omit<LicenseState, "checksum"> = {
    licenseKey: null,
    instanceId: null,
    status: "expired",
    plan: "pro",
    lastValidatedAt: null,
    lastValidationResult: false,
    graceStartedAt: null,
    warningsSent: 0,
    formatVersion: undefined,
  };
  return { ...state, checksum: computeChecksum(state) };
}

export function loadLicense(): LicenseState {
  try {
    if (!fs.existsSync(LICENSE_FILE)) return defaultLicenseState();
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf-8"));
    if (!raw.plan) raw.plan = "pro";
    const { checksum, ...rest } = raw as LicenseState;
    const expected = computeChecksum(rest);
    if (typeof checksum === "string" && checksum.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(checksum), Buffer.from(expected))) {
      return raw as LicenseState;
    }
    const expired = defaultLicenseState();
    expired.status = "expired";
    saveLicense(expired);
    return expired;
  } catch {
    return defaultLicenseState();
  }
}

let _cache: LicenseState | null = null;

export function saveLicense(state: LicenseState): void {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const { checksum: _, ...rest } = state;
  const fresh: LicenseState = { ...rest, checksum: computeChecksum(rest) };
  fs.writeFileSync(LICENSE_FILE, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  _cache = fresh;
}

export function flushLicenseSync(): void {
  if (_cache) saveLicense(_cache);
}

export function invalidateCache(): void {
  _cache = null;
}

// --- Free build: no license gates ---

export async function activateLicense(
  _key: string,
  _ownerId?: number,
  _plan?: PlanTier
): Promise<{ success: boolean; instanceId?: string; error?: string }> {
  return { success: true, instanceId: "free" };
}

export async function validateLicense(_state: LicenseState): Promise<"valid" | "invalid" | "error"> {
  return "valid";
}

export async function deactivateLicense(
  _state: LicenseState
): Promise<{ success: boolean; error?: string }> {
  return { success: true };
}

export async function checkLicenseForStartup(): Promise<LicenseCheckResult> {
  return { allowed: true };
}

export function checkLicenseForQuery(): LicenseCheckResult {
  return { allowed: true };
}

export function startPeriodicValidation(): NodeJS.Timeout {
  return setInterval(() => {}, 999999);
}

export function getLicenseInfo(): string {
  return "Status: Free (Max plan, no license required)";
}
