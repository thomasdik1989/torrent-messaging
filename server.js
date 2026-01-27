#!/usr/bin/env node

import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';

// In-memory SQLite-like storage using Map (for simplicity)
// For production we should use better-sqlite3 with :memory:
const db = new Map();

const PORT = process.env.PORT || 3000;

/**
 * Verify ed25519 signature
 */
function verifySignature(publicKeyHex, data, signatureHex) {
  try {
    const publicKey = Buffer.from(publicKeyHex, 'hex');
    const signature = Buffer.from(signatureHex, 'hex');

    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        publicKey
      ]),
      format: 'der',
      type: 'spki'
    });

    return crypto.verify(null, Buffer.from(data, 'utf8'), keyObject, signature);
  } catch (err) {
    return false;
  }
}

/**
 * Handle announce request (publisher registers/updates their manifest)
 */
function handleAnnounce(body, res) {
  try {
    const { publicKey, manifestInfohash, seq, signature } = JSON.parse(body);

    // Validate required fields
    if (!publicKey || !manifestInfohash || seq === undefined || !signature) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required fields' }));
      return;
    }

    // Validate formats
    if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid public key format' }));
      return;
    }

    if (!/^[0-9a-fA-F]{40}$/.test(manifestInfohash)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid infohash format' }));
      return;
    }

    // Verify signature
    const dataToVerify = JSON.stringify({ publicKey, manifestInfohash, seq });
    if (!verifySignature(publicKey, dataToVerify, signature)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // Check sequence number (must be higher than existing)
    const existing = db.get(publicKey);
    if (existing && existing.seq >= seq) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Sequence number must be higher than current', currentSeq: existing.seq }));
      return;
    }

    // Store the entry
    db.set(publicKey, {
      manifestInfohash,
      seq,
      updatedAt: Date.now()
    });

    console.log(`[${new Date().toISOString()}] Announce: ${publicKey.slice(0, 16)}... -> ${manifestInfohash} (seq: ${seq})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, seq }));

  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
  }
}

/**
 * Handle lookup request (subscriber queries by public key)
 */
function handleLookup(publicKey, res) {
  // Validate format
  if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid public key format' }));
    return;
  }

  const entry = db.get(publicKey);

  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  console.log(`[${new Date().toISOString()}] Lookup: ${publicKey.slice(0, 16)}... -> ${entry.manifestInfohash}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    publicKey,
    manifestInfohash: entry.manifestInfohash,
    seq: entry.seq,
    updatedAt: entry.updatedAt
  }));
}

/**
 * Handle stats request
 */
function handleStats(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    entries: db.size,
    memoryUsage: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  }));
}

/**
 * Main request handler
 */
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // POST /announce
  if (req.method === 'POST' && path === '/announce') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => handleAnnounce(body, res));
    return;
  }

  // GET /lookup/:publicKey
  if (req.method === 'GET' && path.startsWith('/lookup/')) {
    const publicKey = path.slice(8);
    handleLookup(publicKey, res);
    return;
  }

  // GET /stats
  if (req.method === 'GET' && path === '/stats') {
    handleStats(res);
    return;
  }

  // GET / - health check
  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', entries: db.size }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Signaling server running on http://localhost:${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log('  POST /announce          - Register/update manifest infohash');
  console.log('  GET  /lookup/:publicKey - Look up manifest by public key');
  console.log('  GET  /stats             - Server statistics');
  console.log('');
});
