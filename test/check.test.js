/**
 * Tests for x402-manifest-check (node:test, zero dependencies).
 * Run: npm test
 */
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { start } = require('./fixture-server');
const { run } = require('../lib/check');

const BIN = path.join(__dirname, '..', 'bin', 'x402-manifest-check.js');

const MODES = ['good', 'broken', 'badjson', 'empty', 'html', 'v2', 'probe', 'probedrift', 'probeplaceholder', 'probenoexpiry', 'probev2'];
const servers = {};
const bases = {};

before(async () => {
  const started = await Promise.all(MODES.map(async (m) => [m, await start(m)]));
  for (const [m, s] of started) {
    servers[m] = s.server;
    bases[m] = s.base;
  }
});

after(() => {
  for (const s of Object.values(servers)) s.close();
});

function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

describe('manifest validation', () => {
  it('passes a valid manifest', async () => {
    const { report, exitCode } = await run(bases.good);
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);
    assert.equal(report.endpoints.length, 2);
  });

  it('fails a manifest with missing/bad fields', async () => {
    const { report, exitCode } = await run(bases.broken);
    assert.equal(exitCode, 1);
    assert.equal(report.ok, false);
    const codes = report.errors.map((e) => e.code);
    assert.ok(codes.includes('endpoint-missing-price'), 'missing price is an error');
    assert.ok(codes.includes('endpoint-missing-network'), 'empty network is an error');
    assert.ok(codes.includes('endpoint-bad-price'), 'negative price is an error');
  });

  it('fails invalid JSON', async () => {
    const { report, exitCode } = await run(bases.badjson);
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'manifest-invalid-json'));
  });

  it('reports no manifest cleanly on 404', async () => {
    const { report, exitCode } = await run(bases.empty);
    assert.equal(exitCode, 0);
    assert.equal(report.summary, 'no manifest found');
  });

  it('fails when the manifest is HTML, not JSON', async () => {
    const { report, exitCode } = await run(bases.html);
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'manifest-invalid-json'));
  });

  it('warns on missing payTo but still passes', async () => {
    const { report, exitCode } = await run(bases.good);
    // second endpoint /api/cheap has no payTo -> warning only
    assert.ok(report.warnings.some((w) => w.code === 'endpoint-no-payto'));
    assert.equal(exitCode, 0);
  });

  it('supports the x402 v2 paid_routes shape ("$0.01" prices)', async () => {
    const { report, exitCode } = await run(bases.v2);
    assert.equal(exitCode, 0);
    assert.equal(report.manifestShape, 'paid_routes');
    assert.equal(report.endpoints.length, 2);
    assert.equal(report.endpoints[0].price, '0.01');
    // asset/network not advertised in this shape -> warnings, not errors
    assert.ok(report.warnings.some((w) => w.code === 'endpoint-missing-asset'));
    assert.ok(report.warnings.some((w) => w.code === 'endpoint-missing-network'));
    assert.ok(!report.errors.some((e) => e.code === 'endpoint-missing-asset'));
  });
});

describe('probe validation', () => {
  it('passes a live 402 with machine-readable requirements', async () => {
    const { report, exitCode } = await run(bases.probe, { probe: true });
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.probe.status, 402);
    assert.equal(report.probe.requirementsSource, 'payment-required header');
    assert.equal(report.probe.amount, '0.05');
  });

  it('probes a specific endpoint with --endpoint', async () => {
    const { report, exitCode } = await run(bases.probe, { probe: true, endpointPath: '/api/cheap' });
    assert.equal(exitCode, 0);
    assert.equal(report.probe.path, '/api/cheap');
    assert.equal(report.probe.amount, '0.01');
  });

  it('fails on manifest drift (402 disagrees with manifest)', async () => {
    const { report, exitCode } = await run(bases.probedrift, { probe: true });
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'probe-manifest-drift'), 'drift detected');
  });

  it('fails on placeholder payTo in the 402', async () => {
    const { report, exitCode } = await run(bases.probeplaceholder, { probe: true });
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'probe-placeholder-payto'));
  });

  it('warns when 402 requirements lack expiry and nonce', async () => {
    const { report, exitCode } = await run(bases.probenoexpiry, { probe: true });
    assert.equal(exitCode, 0); // warnings only
    assert.ok(report.warnings.some((w) => w.code === 'probe-no-expiry'));
    assert.ok(report.warnings.some((w) => w.code === 'probe-no-nonce'));
  });

  it('fails when the endpoint does not challenge (no 402)', async () => {
    const { report, exitCode } = await run(bases.good, { probe: true, endpointPath: '/api/paid' });
    // mode 'good' serves /api/paid with 200 -> not a 402
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'probe-not-402'));
  });

  it('errors on unknown --endpoint path', async () => {
    const { report, exitCode } = await run(bases.probe, { probe: true, endpointPath: '/nope' });
    assert.equal(exitCode, 1);
    assert.ok(report.errors.some((e) => e.code === 'probe-unknown-endpoint'));
  });

  it('validates an x402 v2 402 (accepts[], base-unit amount, CAIP-2 network)', async () => {
    const { report, exitCode } = await run(bases.probev2, { probe: true });
    assert.equal(exitCode, 0, JSON.stringify(report.errors));
    assert.equal(report.probe.status, 402);
    assert.equal(report.probe.x402Version, 2);
    assert.equal(report.probe.network, 'eip155:8453 (base)');
    assert.equal(report.probe.amount, '10000');
    // no manifest drift: "$0.01" manifest == 10000 micro-USDC == "$0.01" in 402
    assert.ok(!report.errors.some((e) => e.code === 'probe-manifest-drift'));
    // v2 expiry (maxTimeoutSeconds) and id-as-nonce recognized
    assert.ok(!report.warnings.some((w) => w.code === 'probe-no-expiry'));
    assert.ok(!report.warnings.some((w) => w.code === 'probe-no-nonce'));
  });
});

describe('CLI', () => {
  it('prints help and exits 0', async () => {
    const { code, stdout } = await cli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/);
  });

  it('exits 2 on missing URL', async () => {
    const { code } = await cli([]);
    assert.equal(code, 2);
  });

  it('emits valid JSON with --json', async () => {
    const { code, stdout } = await cli([bases.good, '--json']);
    assert.equal(code, 0);
    const doc = JSON.parse(stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.endpoints.length, 2);
  });

  it('--json reports errors with exit 1', async () => {
    const { code, stdout } = await cli([bases.broken, '--json']);
    assert.equal(code, 1);
    const doc = JSON.parse(stdout);
    assert.equal(doc.ok, false);
    assert.ok(doc.errors.length > 0);
  });
});
