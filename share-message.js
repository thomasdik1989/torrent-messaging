#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { createSignedMessage, signManifest, sign } from './lib/crypto-utils.js';
import {
  createClient,
  destroyClient,
  seedJSON,
  generateMessageFilename,
  generateManifestFilename
} from './lib/torrent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, 'data', 'keys.json');
const LOCAL_INDEX_FILE = path.join(__dirname, 'data', 'local-index.json');
const MESSAGES_DIR = path.join(__dirname, 'data', 'messages');

// Signaling server URL (can be overridden via environment variable)
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

// Load or create local index
function loadLocalIndex() {
  if (fs.existsSync(LOCAL_INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(LOCAL_INDEX_FILE, 'utf8'));
  }
  return {};
}

// Save local index
function saveLocalIndex(index) {
  fs.writeFileSync(LOCAL_INDEX_FILE, JSON.stringify(index, null, 2));
}

// Try to load manifest from local files
function tryLoadLocalManifest(publicKeyHex) {
  try {
    if (!fs.existsSync(MESSAGES_DIR)) return null;
    const files = fs.readdirSync(MESSAGES_DIR);
    const keyPrefix = publicKeyHex.slice(0, 8);
    const manifestFiles = files.filter(f => f.startsWith(`manifest-${keyPrefix}`));

    if (manifestFiles.length === 0) return null;

    // Sort by seq number and get the latest
    manifestFiles.sort((a, b) => {
      const seqA = parseInt(a.split('-')[2].replace('.json', ''));
      const seqB = parseInt(b.split('-')[2].replace('.json', ''));
      return seqB - seqA;
    });

    const latestManifest = fs.readFileSync(path.join(MESSAGES_DIR, manifestFiles[0]), 'utf8');
    return JSON.parse(latestManifest);
  } catch (e) {
    return null;
  }
}

// Announce to signaling server
async function announceToServer(publicKeyHex, privateKey, manifestInfohash, seq) {
  return new Promise((resolve, reject) => {
    const dataToSign = JSON.stringify({ publicKey: publicKeyHex, manifestInfohash, seq });
    const signature = sign(dataToSign, privateKey).toString('hex');

    const payload = JSON.stringify({
      publicKey: publicKeyHex,
      manifestInfohash,
      seq,
      signature
    });

    const url = new URL(SERVER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: '/announce',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Server error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// Lookup from signaling server
async function lookupFromServer(publicKeyHex) {
  return new Promise((resolve, reject) => {
    const url = new URL(SERVER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: `/lookup/${publicKeyHex}`,
      method: 'GET'
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error(`Server error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

// Get message from command line args
const messageContent = process.argv[2] || 'test';

async function main() {
  // Load keys
  if (!fs.existsSync(KEYS_FILE)) {
    console.error('Error: No keys found. Run generate-keys.js first.');
    process.exit(1);
  }

  const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  const publicKey = Buffer.from(keys.publicKey, 'hex');
  const privateKey = Buffer.from(keys.privateKey, 'hex');

  console.log('Using public key:', keys.publicKey);
  console.log('Message:', messageContent);
  console.log('Server:', SERVER_URL);
  console.log('');

  let client = null;

  try {
    // Initialize WebTorrent client
    console.log('Starting WebTorrent client...');
    client = createClient();
    console.log('WebTorrent ready');
    console.log('');

    // Check for existing manifest (local first, then server)
    console.log('Checking for existing manifest...');
    let manifest;
    let seq = 1;

    // Try local index first
    const localIndex = loadLocalIndex();
    const localEntry = localIndex[keys.publicKey];

    if (localEntry) {
      seq = localEntry.seq + 1;
      manifest = tryLoadLocalManifest(keys.publicKey);
      if (manifest) {
        console.log('Loaded local manifest with', manifest.messages.length, 'existing messages (seq:', localEntry.seq, ')');
      }
    }

    // If no local manifest, try server
    if (!manifest) {
      try {
        const serverEntry = await lookupFromServer(keys.publicKey);
        if (serverEntry) {
          seq = serverEntry.seq + 1;
          console.log('Found existing entry on server (seq:', serverEntry.seq, ')');
        }
      } catch (err) {
        console.log('Could not reach server, continuing with local data');
      }
    }

    // If still no manifest, create new one
    if (!manifest) {
      manifest = tryLoadLocalManifest(keys.publicKey);
      if (manifest) {
        console.log('Found local manifest file with', manifest.messages.length, 'existing messages');
      } else {
        console.log('No existing manifest found, creating new one');
        manifest = { publicKey: keys.publicKey, messages: [] };
      }
    }

    console.log('');

    // Create signed message
    console.log('Creating signed message...');
    const message = createSignedMessage(messageContent, publicKey, privateKey);
    const messageFilename = generateMessageFilename(keys.publicKey, message.timestamp);

    // Seed message as torrent
    console.log('Seeding message torrent...');
    const messageTorrent = await seedJSON(client, message, messageFilename);
    console.log('Message torrent infohash:', messageTorrent.infohash);

    // Add message to manifest
    manifest.messages.push({
      infohash: messageTorrent.infohash,
      timestamp: message.timestamp
    });

    // Sign and seed manifest
    console.log('Creating updated manifest...');
    const signedManifest = signManifest(manifest, privateKey);
    const manifestFilename = generateManifestFilename(keys.publicKey, seq);

    console.log('Seeding manifest torrent...');
    const manifestTorrent = await seedJSON(client, signedManifest, manifestFilename);
    console.log('Manifest torrent infohash:', manifestTorrent.infohash);

    console.log('');

    // Announce to signaling server
    console.log('Announcing to server (seq:', seq, ')...');
    try {
      await announceToServer(keys.publicKey, privateKey, manifestTorrent.infohash, seq);
      console.log('Announced to server successfully!');
    } catch (err) {
      console.log('Warning: Could not announce to server:', err.message);
      console.log('Messages will still be available via torrent if you share the infohash directly.');
    }

    // Save to local index
    localIndex[keys.publicKey] = {
      manifestInfohash: manifestTorrent.infohash,
      seq: seq,
      updatedAt: Date.now()
    };
    saveLocalIndex(localIndex);
    console.log('Updated local index');

    console.log('');
    console.log('='.repeat(60));
    console.log('Message shared successfully!');
    console.log('='.repeat(60));
    console.log('');
    console.log('Public Key:', keys.publicKey);
    console.log('Message Infohash:', messageTorrent.infohash);
    console.log('Manifest Infohash:', manifestTorrent.infohash);
    console.log('Sequence Number:', seq);
    console.log('Total Messages:', manifest.messages.length);
    console.log('');
    console.log('Share your public key with others so they can find your messages:');
    console.log('  node find-messages.js', keys.publicKey);
    console.log('');
    console.log('Keep this process running to seed the torrent...');
    console.log('Press Ctrl+C to stop');

    // Keep running to seed
    process.on('SIGINT', async () => {
      console.log('');
      console.log('Shutting down...');
      if (client) await destroyClient(client);
      process.exit(0);
    });

  } catch (err) {
    console.error('Error:', err.message);
    if (client) await destroyClient(client);
    process.exit(1);
  }
}

main();
