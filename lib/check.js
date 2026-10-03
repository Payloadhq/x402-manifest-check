/**
 * x402-manifest-check — core validation logic.
 *
 * Zero dependencies. Node 18+ (uses global fetch, URL, AbortController).
 *
 * What this validates:
 *   1. That <origin>/.well-known/x402 serves a valid JSON x402 manifest.
 *   2. That each listed endpoint carries the fields an agent needs to pay:
 *      path, price, asset, network (errors), plus method/payTo/description
 *      quality checks (warnings).
 *   3. Optionally (--probe): that an unpaid request to a listed endpoint
 *      returns HTTP 402 with machine-readable payment requirements, and that
 *      those requirements are sane and consistent with the manifest.
 *
 * Severity model:
 *   error   — the manifest or 402 is broken; agents cannot pay reliably.
 *   warning — usable, but missing something agents should have (e.g. payTo
 *             is not advertised in the manifest, so the recipient can't be
 *             verified before payment).
 *
 * Note on payTo: the reference implementation this tool was built against
 * (Payload's x402 Paid API Starter Kit) advertises payTo in the live 402
 * requirements, not in the manifest. So a missing manifest-level payTo is a
 * warning, while a missing payTo in the 402 requirements is an error.
 */
'use strict';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const KNOWN_NETWORKS = new Set([
  'base', 'ethereum', 'mainnet', 'polygon', 'solana', 'avalanche',
  'arbitrum', 'optimism', 'bsc', 'base-sepolia', 'sepolia',
]);

const PLACEHOLDER_PAYTO = new Set([
  '0xyourwallet', '0x0000000000000000000000000000000000000000', 'your-wallet-address',
  'todo', 'changeme', 'xxx',
]);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Normalize user input ("example.com", "http://localhost:3000/") to an origin URL. */
function normalizeOrigin(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('no URL provided');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('URL must be http(s): ' + input);
  }
  return u.origin;
}

function looksLikeAddress(payTo) {
  if (typeof payTo !== 'string' || !payTo) return false;
  if (/^0x[0-9a-fA-F]{40}$/.test(payTo)) return true; // EVM address
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(payTo)) return true; // base58 (e.g. Solana)
  return false;
}

function isPlaceholderPayTo(payTo) {
  return typeof payTo === 'string' && PLACEHOLDER_PAYTO.has(payTo.toLowerCase().trim());
}

async function fetchWithTimeout(url, { timeoutMs, headers } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, url: res.url };
  } finally {
    clearTimeout(t);
  }
}

function newReport(url) {
  return {
    url,
    manifestUrl: null,
    ok: true,
    errors: [],
    warnings: [],
    endpoints: [],
    probe: null,
    summary: '',
  };
}

function addError(report, code, message, context) {
  report.ok = false;
  report.errors.push({ code, message, ...(context ? { context } : {}) });
}

function addWarning(report, code, message, context) {
  report.warnings.push({ code, message, ...(context ? { context } : {}) });
}

/** Validate the manifest document itself. Returns the parsed manifest or null.
 *
 * Two manifest shapes are supported:
 *   - "endpoints"  — [{ method, path, price, asset, network, payTo?, description? }]
 *                    (Payload x402 Paid API Starter Kit shape)
 *   - "paid_routes" — [{ route_key, method, path, resource_url, price: "$0.01",
 *                    description?, ... }]  (x402 v2 / Bazaar discovery shape,
 *                    as served by live mainnet APIs)
 * Both are normalized to a common endpoint list. Asset/network are required
 * in the "endpoints" shape but only warned-about in "paid_routes", where the
 * format leaves payment details to the live 402 (verified by --probe).
 */
function validateManifestDoc(report, text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    addError(report, 'manifest-invalid-json', 'Manifest body is not valid JSON: ' + err.message);
    return null;
  }
  if (!isPlainObject(doc)) {
    addError(report, 'manifest-not-object', 'Manifest must be a JSON object at the top level.');
    return null;
  }
  const normalized = normalizeEndpoints(doc);
  if (!normalized) {
    addError(report, 'manifest-no-endpoints', 'Manifest has neither an "endpoints" array nor a "paid_routes" array.');
    return null;
  }
  doc._shape = normalized.shape;
  doc._normalized = normalized.list;
  report.manifestShape = normalized.shape;
  if (normalized.list.length === 0) {
    addWarning(report, 'manifest-empty-endpoints', 'Manifest lists zero endpoints.');
  }
  if (doc.baseUrl !== undefined && doc.baseUrl !== '' && !isValidUrl(doc.baseUrl)) {
    addWarning(report, 'manifest-bad-baseurl', `"baseUrl" is not a valid absolute http(s) URL: ${doc.baseUrl}`);
  }
  return doc;
}

/** Parse a price like "0.01" or "$0.01" into a decimal string, or null. */
function parsePrice(raw) {
  if (typeof raw === 'number') raw = String(raw);
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*$/);
  return m ? m[1] : null;
}

/**
 * Normalize the manifest's endpoint list across supported shapes.
 * Returns { shape, list } or null when no supported list exists.
 */
function normalizeEndpoints(doc) {
  if (Array.isArray(doc.endpoints)) {
    return {
      shape: 'endpoints',
      list: doc.endpoints.map((e) => ({
        raw: e,
        method: isPlainObject(e) ? e.method : undefined,
        path: isPlainObject(e) ? e.path : undefined,
        price: isPlainObject(e) ? e.price : undefined,
        asset: isPlainObject(e) ? e.asset : undefined,
        network: isPlainObject(e) ? e.network : undefined,
        payTo: isPlainObject(e) ? e.payTo : undefined,
        description: isPlainObject(e) ? e.description : undefined,
      })),
    };
  }
  if (Array.isArray(doc.paid_routes)) {
    return {
      shape: 'paid_routes',
      list: doc.paid_routes.map((e) => ({
        raw: e,
        method: isPlainObject(e) ? e.method : undefined,
        // paid_routes may use path templates like /price/{coin}; probe the concrete resource_path when given
        path: isPlainObject(e) ? (e.resource_path || e.path) : undefined,
        price: isPlainObject(e) ? parsePrice(e.price) : undefined,
        priceRaw: isPlainObject(e) ? e.price : undefined,
        asset: isPlainObject(e) ? (e.asset || e.currency) : undefined,
        network: isPlainObject(e) ? (e.network || e.chain) : undefined,
        payTo: isPlainObject(e) ? e.payTo : undefined,
        description: isPlainObject(e) ? e.description : undefined,
      })),
    };
  }
  return null;
}

/** Validate one manifest endpoint entry.
 *  strict=true  ("endpoints" shape): asset/network are errors when missing.
 *  strict=false ("paid_routes" shape): asset/network are warnings when missing,
 *                 since that shape leaves payment details to the live 402.
 */
function validateEndpoint(report, norm, index, strict) {
  const label = `endpoints[${index}]`;
  const ep = norm.raw;
  const path = norm.path;
  const ctx = typeof path === 'string' ? path : label;
  const info = { index, path: typeof path === 'string' ? path : null, method: 'GET', price: null, asset: null, network: null, payTo: null, checks: [] };

  if (!isPlainObject(ep)) {
    addError(report, 'endpoint-not-object', `${label} is not an object.`, { endpoint: label });
    report.endpoints.push(info);
    return info;
  }

  // path
  if (typeof norm.path !== 'string' || norm.path === '') {
    addError(report, 'endpoint-missing-path', `${label}: "path" is required.`, { endpoint: label });
  } else if (!norm.path.startsWith('/')) {
    addError(report, 'endpoint-bad-path', `${label}: "path" should start with "/": ${norm.path}`, { endpoint: ctx });
  } else {
    info.path = norm.path;
  }

  // method
  const method = (norm.method || 'GET').toUpperCase();
  info.method = method;
  if (!norm.method) {
    addWarning(report, 'endpoint-default-method', `${ctx}: "method" not set, assuming GET.`, { endpoint: ctx });
  } else if (!HTTP_METHODS.has(method)) {
    addError(report, 'endpoint-bad-method', `${ctx}: unknown HTTP method "${norm.method}".`, { endpoint: ctx });
  }

  // price ("0.01" or "$0.01" both accepted; normalized by parsePrice)
  const price = norm.price;
  info.price = price === undefined || price === null ? null : String(price);
  if (price === undefined || price === null || price === '') {
    const hint = norm.priceRaw !== undefined && norm.priceRaw !== norm.price
      ? ` (got ${JSON.stringify(norm.priceRaw)} — expected a decimal like "0.01" or "$0.01")`
      : ' (decimal string in asset units, e.g. "0.01")';
    addError(report, 'endpoint-missing-price', `${ctx}: "price" is required${hint}.`, { endpoint: ctx });
  } else {
    const n = Number(price);
    if (!Number.isFinite(n) || n <= 0) {
      addError(report, 'endpoint-bad-price', `${ctx}: "price" must be a positive decimal, got ${JSON.stringify(norm.priceRaw !== undefined ? norm.priceRaw : price)}.`, { endpoint: ctx });
    }
  }

  // asset — error in the strict ("endpoints") shape, warning in "paid_routes"
  info.asset = typeof norm.asset === 'string' ? norm.asset : null;
  if (typeof norm.asset !== 'string' || norm.asset.trim() === '') {
    const msg = `${ctx}: "asset" is not advertised (e.g. "USDC").` + (strict ? '' : ' The live 402 should name it — use --probe to verify.');
    if (strict) addError(report, 'endpoint-missing-asset', msg, { endpoint: ctx });
    else addWarning(report, 'endpoint-missing-asset', msg, { endpoint: ctx });
  }

  // network — error in the strict ("endpoints") shape, warning in "paid_routes"
  info.network = typeof norm.network === 'string' ? norm.network : null;
  if (typeof norm.network !== 'string' || norm.network.trim() === '') {
    const msg = `${ctx}: "network" is not advertised (e.g. "base").` + (strict ? '' : ' The live 402 should name it — use --probe to verify.');
    if (strict) addError(report, 'endpoint-missing-network', msg, { endpoint: ctx });
    else addWarning(report, 'endpoint-missing-network', msg, { endpoint: ctx });
  } else if (!KNOWN_NETWORKS.has(norm.network.toLowerCase().replace(/^eip155:/, ''))) {
    addWarning(report, 'endpoint-unknown-network', `${ctx}: network "${norm.network}" is not a commonly known x402 network — double-check the value.`, { endpoint: ctx });
  }

  // payTo — warning at manifest level (see module docstring)
  info.payTo = typeof norm.payTo === 'string' ? norm.payTo : null;
  if (typeof norm.payTo !== 'string' || norm.payTo.trim() === '') {
    addWarning(report, 'endpoint-no-payto', `${ctx}: "payTo" is not advertised. Agents cannot verify the recipient before paying; consider adding it.`, { endpoint: ctx });
  } else if (isPlaceholderPayTo(norm.payTo)) {
    addWarning(report, 'endpoint-placeholder-payto', `${ctx}: "payTo" looks like a placeholder (${norm.payTo}).`, { endpoint: ctx });
  } else if (!looksLikeAddress(norm.payTo)) {
    addWarning(report, 'endpoint-bad-payto', `${ctx}: "payTo" does not look like an EVM or Solana address: ${norm.payTo}`, { endpoint: ctx });
  }

  // description
  if (typeof norm.description !== 'string' || norm.description.trim() === '') {
    addWarning(report, 'endpoint-no-description', `${ctx}: no "description" — agents pick endpoints by description.`, { endpoint: ctx });
  }

  report.endpoints.push(info);
  return info;
}

/** Decode machine-readable payment requirements from a 402 response.
 * Returns { source, requirements } where requirements is either the v1
 * requirements object or the x402 v2 envelope ({ x402Version, accepts: [...] }).
 */
function extractRequirements(res) {
  // 1) payment-required header (base64-encoded JSON)
  const header = res.headers.get('payment-required');
  if (header) {
    try {
      const json = Buffer.from(String(header).trim(), 'base64').toString('utf8');
      const req = JSON.parse(json);
      if (isPlainObject(req)) return { source: 'payment-required header', requirements: req };
    } catch {
      return { source: 'payment-required header', requirements: null, decodeError: true };
    }
  }
  // 2) JSON body: v1 paymentRequirements, or the v2 envelope itself
  try {
    const body = JSON.parse(res.text);
    if (isPlainObject(body)) {
      const req = body.paymentRequirements || body.payment_requirements || null;
      if (isPlainObject(req)) return { source: 'JSON body', requirements: req };
      if (Array.isArray(body.accepts) || body.x402Version) {
        return { source: 'JSON body (x402 v2 envelope)', requirements: body };
      }
    }
  } catch {
    // not JSON — fine, header path already checked
  }
  return { source: null, requirements: null };
}

/** EVM chain IDs to names for CAIP-2 style network values ("eip155:8453"). */
const CHAIN_IDS = {
  1: 'ethereum', 8453: 'base', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism',
  56: 'bsc', 43114: 'avalanche', 84532: 'base-sepolia', 11155111: 'sepolia',
  42220: 'celo', 7777777: 'zora',
};

function normalizeNetworkName(network) {
  if (typeof network !== 'string') return null;
  const m = network.match(/^eip155:(\d+)$/i);
  if (m && CHAIN_IDS[Number(m[1])]) return `${network} (${CHAIN_IDS[Number(m[1])]})`;
  const short = network.toLowerCase().replace(/^eip155:/, '');
  if (KNOWN_NETWORKS.has(short)) return short;
  return network;
}

/** Known USDC contract addresses (6 decimals) for base-unit amount conversion. */
const USDC_CONTRACTS = new Set([
  '0x833589fcd6edbe608f4c7c32d4f71b54bda02913', // Base
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // Ethereum
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // Polygon
  '0x5425890298aed601595a70ab815c96711a31bc65', // Arbitrum
  '0x0b2c639c533813f4aa9d78336ed660f2de0d94',   // Optimism
  '0xceb6cd2cbfef1fc29f5ff1a5a123d5495fc0afb6', // Celo
]);

function isUsdcLike(r) {
  if (typeof r.asset === 'string' && r.asset.toLowerCase() === 'usdc') return true;
  if (typeof r.asset === 'string' && USDC_CONTRACTS.has(r.asset.toLowerCase())) return true;
  if (r.extra && typeof r.extra.name === 'string' && /usd\s*coin/i.test(r.extra.name)) return true;
  return false;
}

/**
 * Pick the effective requirements object from a v1 object or v2 envelope.
 * v2: { x402Version: 2, accepts: [{ scheme, network, asset, amount, payTo, ... }] }
 */
function pickRequirements(req) {
  if (Array.isArray(req.accepts) && req.accepts.length > 0 && isPlainObject(req.accepts[0])) {
    return { r: req.accepts[0], version: req.x402Version || 2, options: req.accepts.length };
  }
  return { r: req, version: req.x402Version || 1, options: 1 };
}

/** Extract an expiry TTL in seconds from v1 or v2 requirement fields. */
function probeExpiryTtl(r) {
  const issuedAt = Number(r.issuedAt);
  const expiresAt = Number(r.expiresAt);
  if (Number.isFinite(issuedAt) && Number.isFinite(expiresAt)) {
    return { ttlSec: expiresAt - issuedAt, alreadyExpired: expiresAt * 1000 < Date.now() };
  }
  for (const f of ['expiresInSec', 'maxTimeoutSeconds']) {
    if (r[f] !== undefined) {
      const t = Number(r[f]);
      if (Number.isFinite(t)) return { ttlSec: t };
      return { bad: r[f] };
    }
  }
  if (typeof r.expires === 'string') {
    const ms = Date.parse(r.expires);
    if (Number.isFinite(ms)) {
      return { ttlSec: Math.max(0, Math.round((ms - Date.now()) / 1000)), alreadyExpired: ms < Date.now() };
    }
  }
  return null;
}

/**
 * Compare a manifest price (decimal string) with 402 requirements.
 * Handles v1 decimal amounts, v2 human price ("$0.01"), and v2 base-unit
 * amounts ("10000" micro-USDC) when the asset is USDC-like.
 * Returns true (match), false (mismatch), or null (cannot compare).
 */
function pricesMatch(manifestPrice, r) {
  const mp = Number(manifestPrice);
  if (!Number.isFinite(mp)) return null;
  if (r.price !== undefined) {
    const hp = parsePrice(r.price);
    if (hp !== null && Number(hp) === mp) return true;
  }
  const amtRaw = r.amount !== undefined ? r.amount : r.price;
  const an = Number(String(amtRaw).replace(/^\$\s*/, ''));
  if (!Number.isFinite(an)) return null;
  if (an === mp) return true;
  if (Number.isInteger(an) && isUsdcLike(r) && Math.abs(an / 1e6 - mp) < 1e-9) return true;
  return false;
}

/** Validate the requirements object from a live 402, cross-checked against the manifest entry.
 * Handles both the v1 requirements shape and the x402 v2 envelope (accepts[]).
 */
function validateProbeRequirements(report, probe, extracted, manifestEp) {
  if (extracted.decodeError) {
    addError(report, 'probe-bad-requirements-header', 'The payment-required header is not valid base64 JSON.', { endpoint: probe.path });
    return;
  }
  if (!extracted.requirements) {
    addError(report, 'probe-no-requirements', 'HTTP 402 has no machine-readable payment requirements (no payment-required header and no paymentRequirements in the JSON body). Agents cannot self-serve payment.', { endpoint: probe.path });
    return;
  }
  const picked = pickRequirements(extracted.requirements);
  const req = picked.r;
  probe.requirementsSource = extracted.source + (picked.version >= 2 ? ` (x402 v2, ${picked.options} payment option${picked.options === 1 ? '' : 's'})` : '');
  probe.x402Version = picked.version;

  const amount = req.amount !== undefined ? req.amount : req.price;
  const n = Number(String(amount).replace(/^\$\s*/, ''));
  if (amount === undefined || !Number.isFinite(n) || n <= 0) {
    addError(report, 'probe-bad-amount', `402 requirements have no usable amount (got ${JSON.stringify(amount)}).`, { endpoint: probe.path });
  } else {
    probe.amount = String(amount);
  }
  if (typeof req.asset !== 'string' || !req.asset) {
    addError(report, 'probe-missing-asset', '402 requirements do not name the asset.', { endpoint: probe.path });
  } else {
    probe.asset = req.asset;
  }
  if (typeof req.network !== 'string' || !req.network) {
    addError(report, 'probe-missing-network', '402 requirements do not name the network.', { endpoint: probe.path });
  } else {
    probe.network = normalizeNetworkName(req.network);
  }
  const payTo = req.payTo !== undefined ? req.payTo : req.pay_to;
  if (typeof payTo !== 'string' || !payTo) {
    addError(report, 'probe-missing-payto', '402 requirements do not name the recipient (payTo).', { endpoint: probe.path });
  } else if (isPlaceholderPayTo(payTo)) {
    addError(report, 'probe-placeholder-payto', `402 requirements advertise a placeholder recipient: ${payTo}. Funds would go nowhere real.`, { endpoint: probe.path });
  } else if (!looksLikeAddress(payTo)) {
    addWarning(report, 'probe-bad-payto', `402 payTo does not look like an EVM or Solana address: ${payTo}`, { endpoint: probe.path });
  } else {
    probe.payTo = payTo;
  }

  // expiry sanity (v1 issuedAt/expiresAt, or v2 maxTimeoutSeconds / expires)
  const exp = probeExpiryTtl(req);
  if (exp && exp.bad !== undefined) {
    addError(report, 'probe-bad-expiry', `402 requirements carry an unusable expiry value: ${JSON.stringify(exp.bad)}.`, { endpoint: probe.path });
  } else if (exp && exp.ttlSec !== undefined) {
    const ttl = exp.ttlSec;
    probe.expiresInSec = ttl;
    if (exp.alreadyExpired) {
      addError(report, 'probe-expired-now', '402 requirements expired before this check ran.', { endpoint: probe.path });
    } else if (ttl <= 0) {
      addError(report, 'probe-expired', '402 requirements are already expired.', { endpoint: probe.path });
    } else if (ttl < 60) {
      addWarning(report, 'probe-short-expiry', `402 requirements expire in ${ttl}s — under 60s risks clock-skew rejections.`, { endpoint: probe.path });
    } else if (ttl > 3600) {
      addWarning(report, 'probe-long-expiry', `402 requirements are valid for ${ttl}s (over 1h) — long windows widen replay risk.`, { endpoint: probe.path });
    }
  } else {
    addWarning(report, 'probe-no-expiry', '402 requirements carry no expiry (issuedAt/expiresAt, maxTimeoutSeconds, or expires). Without expiry, a captured payment can be replayed.', { endpoint: probe.path });
  }

  const nonce = req.nonce || req.id;
  if (typeof nonce !== 'string' || !nonce) {
    addWarning(report, 'probe-no-nonce', '402 requirements carry no nonce (or id). Single-use nonces are the standard replay defense.', { endpoint: probe.path });
  }

  // manifest drift: does the live 402 agree with the manifest?
  if (manifestEp) {
    const drift = [];
    if (manifestEp.price != null) {
      const m = pricesMatch(manifestEp.price, req);
      if (m === false) {
        drift.push(`price: manifest says ${manifestEp.price}, 402 says ${probe.amount || JSON.stringify(amount)}`);
      }
    }
    if (probe.asset && manifestEp.asset && probe.asset !== manifestEp.asset) {
      drift.push(`asset: manifest says ${manifestEp.asset}, 402 says ${probe.asset}`);
    }
    if (probe.network && manifestEp.network) {
      const pn = probe.network.split(' ')[0];
      if (pn !== manifestEp.network && normalizeNetworkName(manifestEp.network).split(' ')[0] !== pn) {
        drift.push(`network: manifest says ${manifestEp.network}, 402 says ${probe.network}`);
      }
    }
    if (drift.length > 0) {
      addError(report, 'probe-manifest-drift', 'Manifest drift: the live 402 disagrees with the manifest — ' + drift.join('; ') + '.', { endpoint: probe.path });
    }
  }
}

async function checkManifest(origin, { timeoutMs = 10000 } = {}) {
  const report = newReport(origin);
  const manifestUrl = origin + '/.well-known/x402';
  report.manifestUrl = manifestUrl;

  let res;
  try {
    res = await fetchWithTimeout(manifestUrl, { timeoutMs, headers: { accept: 'application/json' } });
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    addError(report, 'manifest-unreachable', `Could not fetch ${manifestUrl}: ${reason}`);
    report.summary = 'manifest unreachable';
    return { report, doc: null, fetchError: true };
  }

  if (res.status === 404) {
    report.summary = 'no manifest found';
    return { report, doc: null, noManifest: true };
  }
  if (res.status !== 200) {
    addError(report, 'manifest-bad-status', `Manifest endpoint returned HTTP ${res.status} (expected 200).`);
    report.summary = 'manifest fetch failed';
    return { report, doc: null, fetchError: true };
  }

  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('json')) {
    addWarning(report, 'manifest-content-type', `Manifest served with content-type "${ctype}" instead of application/json.`);
  }

  const doc = validateManifestDoc(report, res.text);
  if (!doc) {
    report.summary = 'manifest invalid';
    return { report, doc: null, fetchError: true };
  }

  const strict = doc._shape === 'endpoints';
  for (let i = 0; i < doc._normalized.length; i++) {
    validateEndpoint(report, doc._normalized[i], i, strict);
  }

  const originHost = new URL(origin).host;
  if (doc.baseUrl) {
    try {
      const baseHost = new URL(doc.baseUrl).host;
      if (baseHost !== originHost) {
        addWarning(report, 'manifest-baseurl-mismatch', `Manifest baseUrl host (${baseHost}) differs from the checked origin (${originHost}). Probing will use the checked origin.`);
      }
    } catch {
      // already warned about bad baseUrl
    }
  } else {
    addWarning(report, 'manifest-no-baseurl', 'Manifest has no "baseUrl" — agents must guess how to join endpoint paths.');
  }

  report.summary = report.ok
    ? (report.warnings.length ? 'manifest valid with warnings' : 'manifest valid')
    : 'manifest has errors';
  return { report, doc, fetchError: false };
}

async function probeEndpoint(origin, manifestEp, { timeoutMs = 10000 } = {}) {
  const report = newReport(origin);
  const probe = { path: manifestEp.path, method: manifestEp.method || 'GET', status: null };
  report.probe = probe;

  const target = origin + manifestEp.path;
  probe.url = target;
  let res;
  try {
    res = await fetchWithTimeout(target, { timeoutMs });
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timed out after ${timeoutMs}ms` : err.message;
    addError(report, 'probe-unreachable', `Could not reach ${target}: ${reason}`, { endpoint: manifestEp.path });
    return report;
  }
  probe.status = res.status;

  if (res.status !== 402) {
    addError(report, 'probe-not-402', `Unpaid ${probe.method} ${manifestEp.path} returned HTTP ${res.status}, expected 402 Payment Required. The endpoint is not challenging for payment.`, { endpoint: manifestEp.path });
    return report;
  }

  const extracted = extractRequirements(res);
  validateProbeRequirements(report, probe, extracted, manifestEp);
  return report;
}

/**
 * Run the full check. Returns { report, exitCode }.
 * exitCode: 0 = pass (or no manifest — informational), 1 = validation failures,
 *           2 = operational/usage error.
 */
async function run(url, { probe = false, endpointPath = null, timeoutMs = 10000 } = {}) {
  let origin;
  try {
    origin = normalizeOrigin(url);
  } catch (err) {
    const report = newReport(String(url));
    addError(report, 'bad-url', err.message);
    report.summary = 'bad URL';
    return { report, exitCode: 2 };
  }

  const { report, doc, noManifest, fetchError } = await checkManifest(origin, { timeoutMs });

  if (noManifest) return { report, exitCode: 0 };
  if (fetchError) return { report, exitCode: report.errors.some(e => e.code === 'manifest-unreachable') ? 2 : 1 };

  if (probe) {
    let manifestEp = null;
    const normList = doc._normalized;
    const pick = (n) => ({ path: n.path, method: n.method || 'GET', price: n.price, asset: n.asset, network: n.network });
    if (endpointPath) {
      const found = normList.find(n => n.path === endpointPath);
      if (!found) {
        addError(report, 'probe-unknown-endpoint', `No endpoint with path "${endpointPath}" in the manifest.`);
        return { report, exitCode: 1 };
      }
      manifestEp = pick(found);
    } else {
      const first = normList.find(n => typeof n.path === 'string');
      if (!first) {
        addWarning(report, 'probe-skipped', 'No probale endpoint in the manifest; skipping probe.');
        return { report, exitCode: report.ok ? 0 : 1 };
      }
      manifestEp = pick(first);
    }
    const probeReport = await probeEndpoint(origin, manifestEp, { timeoutMs });
    report.probe = probeReport.probe;
    report.errors.push(...probeReport.errors);
    report.warnings.push(...probeReport.warnings);
    report.ok = report.ok && probeReport.ok;
    report.summary = report.ok
      ? (report.warnings.length ? 'manifest + probe passed with warnings' : 'manifest + probe passed')
      : 'probe found errors';
  }

  return { report, exitCode: report.ok ? 0 : 1 };
}

module.exports = {
  run,
  checkManifest,
  probeEndpoint,
  normalizeOrigin,
  validateManifestDoc,
  validateEndpoint,
  extractRequirements,
  normalizeEndpoints,
  parsePrice,
  pickRequirements,
  pricesMatch,
  normalizeNetworkName,
};
