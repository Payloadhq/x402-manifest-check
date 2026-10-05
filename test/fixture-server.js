/**
 * Fixture server for x402-manifest-check tests.
 *
 * start(mode) spins up a server on an ephemeral port whose
 * /.well-known/x402 behaves according to `mode`, so the validator
 * can be exercised against a valid manifest, a broken manifest,
 * invalid JSON, a 404, and live 402 probes — including drift and
 * placeholder-recipient cases.
 *
 * Modes: good | broken | badjson | empty | html |
 *        probe | probedrift | probeplaceholder | probenoexpiry
 */
'use strict';

const http = require('http');

const PAYTO = '0xAbC1234567890aBc1234567890AbC1234567890aBc12';

function requirements({ amount = '0.05', payTo = PAYTO, ttl = 300 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const r = {
    scheme: 'exact',
    network: 'base',
    asset: 'USDC',
    amount: String(amount),
    payTo,
    resource: 'GET /api/paid',
    nonce: 'abc123nonce',
    issuedAt: now,
    expiresAt: now + ttl,
  };
  return r;
}

function challenge(reqs) {
  return {
    status: 402,
    headers: { 'payment-required': Buffer.from(JSON.stringify(reqs), 'utf8').toString('base64') },
    body: { error: 'payment_required', paymentRequirements: reqs },
  };
}

function goodManifest() {
  return {
    name: 'Fixture Paid API',
    description: 'Test fixture.',
    baseUrl: '',
    payment: { scheme: 'exact', asset: 'USDC' },
    endpoints: [
      { method: 'GET', path: '/api/paid', price: '0.05', asset: 'USDC', network: 'base', payTo: PAYTO, description: 'A paid thing.' },
      { method: 'GET', path: '/api/cheap', price: '0.01', asset: 'USDC', network: 'base', description: 'A cheap paid thing.' },
    ],
    generatedAt: new Date().toISOString(),
  };
}

function brokenManifest() {
  return {
    name: 'Broken',
    endpoints: [
      { method: 'GET', path: '/api/noprice', asset: 'USDC', network: 'base', description: 'no price' },
      { method: 'GET', path: '/api/badnet', price: '0.01', asset: 'USDC', network: '', description: 'empty network' },
      { method: 'GET', path: '/api/neg', price: '-1', asset: 'USDC', network: 'base', description: 'negative price' },
    ],
  };
}

/** x402 v2 / Bazaar discovery shape, as served by live mainnet APIs. */
function v2Manifest() {
  return {
    version: 1,
    resources: ['https://example.test/price', 'https://example.test/portfolio'],
    freeResources: ['https://example.test/', 'https://example.test/health'],
    paid_routes: [
      {
        route_key: 'GET /price',
        method: 'GET',
        path: '/price',
        resource_path: '/price',
        resource_url: 'https://example.test/price',
        price: '$0.01',
        description: 'Current prices.',
      },
      {
        route_key: 'GET /portfolio',
        method: 'GET',
        path: '/portfolio',
        resource_path: '/portfolio',
        resource_url: 'https://example.test/portfolio',
        price: '$0.05',
        asset: 'USDC',
        network: 'base',
        description: 'Market snapshot.',
      },
    ],
  };
}

function handlerFor(mode) {
  return (req, res) => {
    const send = (status, headers, body) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    const url = req.url;

    if (url === '/.well-known/x402') {
      switch (mode) {
        case 'good':
        case 'probe':
        case 'probeplaceholder':
        case 'probenoexpiry':
          return send(200, {}, goodManifest());
        case 'probedrift': {
          const m = goodManifest();
          m.endpoints[0].price = '0.99'; // manifest lies; the 402 will say 0.05
          return send(200, {}, m);
        }
        case 'broken':
          return send(200, {}, brokenManifest());
        case 'v2':
          return send(200, {}, v2Manifest());
        case 'probev2': {
          const m = v2Manifest();
          m.paid_routes = [{
            route_key: 'GET /api/paid',
            method: 'GET',
            path: '/api/paid',
            resource_path: '/api/paid',
            price: '$0.01',
            description: 'v2 probe fixture.',
          }];
          return send(200, {}, m);
        }
        case 'probev2symbol': {
          // Real-world rail shape: endpoints manifest with symbol asset + short
          // network, 402 with contract asset + CAIP-2 network + base-unit amount.
          return send(200, {}, {
            name: 'Symbol Fixture',
            description: 'Manifest uses USDC/base; 402 uses contract/eip155:8453.',
            baseUrl: 'http://127.0.0.1',
            endpoints: [
              { method: 'POST', path: '/api/paid', price: '0.01', asset: 'USDC', network: 'base', description: 'A paid thing.' },
            ],
          });
        }
        case 'badjson':
          return send(200, {}, '{not json');
        case 'html':
          return send(200, { 'content-type': 'text/html' }, '<html>nope</html>');
        case 'empty':
        default:
          return send(404, {}, { error: 'not found' });
      }
    }

    // probed endpoints: unpaid request -> kit-style 402
    if (mode === 'probe' && (url === '/api/paid' || url === '/api/cheap')) {
      const amount = url === '/api/cheap' ? '0.01' : '0.05';
      const c = challenge(requirements({ amount }));
      return send(c.status, c.headers, c.body);
    }
    if (mode === 'probedrift' && url === '/api/paid') {
      const c = challenge(requirements({ amount: '0.05' }));
      return send(c.status, c.headers, c.body);
    }
    if (mode === 'probeplaceholder' && url === '/api/paid') {
      const c = challenge(requirements({ payTo: '0xYourWallet' }));
      return send(c.status, c.headers, c.body);
    }
    if (mode === 'probenoexpiry' && url === '/api/paid') {
      const r = requirements();
      delete r.issuedAt; delete r.expiresAt; delete r.nonce;
      const c = challenge(r);
      return send(c.status, c.headers, c.body);
    }
    // x402 v2 envelope: accepts[] with base-unit amount, CAIP-2 network, ISO expiry
    if (mode === 'probev2' && url === '/api/paid') {
      const envelope = {
        x402Version: 2,
        error: 'Payment required',
        resource: { url: 'http://127.0.0.1/price', description: 'v2 fixture', mimeType: 'application/json' },
        method: 'GET',
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '10000',
          price: '$0.01',
          payTo: '0x68614873C5d624c07DCAA3aFF5243DD5027c3910',
          maxTimeoutSeconds: 300,
          extra: { name: 'USD Coin' },
          id: 'v2fixture1',
          expires: new Date(Date.now() + 300000).toISOString(),
        }],
      };
      return send(402, { 'payment-required': Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }, envelope);
    }
    // manifest-only fixture: /api/paid exists but doesn't challenge (wrong)
    if (mode === 'good' && url === '/api/paid') {
      return send(200, {}, { ok: true });
    }
    // symbol-manifest vs contract-402: no drift when they describe the same token/network
    if (mode === 'probev2symbol' && url === '/api/paid') {
      const envelope = {
        x402Version: 2,
        resource: { url: 'http://127.0.0.1/api/paid', description: 'symbol fixture', mimeType: 'application/json' },
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          amount: '10000',
          payTo: '0x68614873C5d624c07DCAA3aFF5243DD5027c3910',
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
          id: 'symbolfixture1',
        }],
      };
      return send(402, { 'payment-required': Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64') }, envelope);
    }

    return send(404, {}, { error: 'not found' });
  };
}

function start(mode = 'good') {
  const server = http.createServer(handlerFor(mode));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { start };
