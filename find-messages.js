#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { verifyMessage, verifyManifest } from './lib/crypto-utils.js';
import { createDHT, getMutable, destroyDHT } from './lib/dht-store.js';
import { createClient, destroyClient, downloadJSON } from './lib/torrent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_INDEX_FILE = path.join(__dirname, 'data', 'local-index.json');
const MESSAGES_DIR = path.join(__dirname, 'data', 'messages');

// Load local index
function loadLocalIndex() {
  if (fs.existsSync(LOCAL_INDEX_FILE)) {
    return JSON.parse(fs.readFileSync(LOCAL_INDEX_FILE, 'utf8'));
  }
  return {};
}

// Try to load manifest from local files
function tryLoadLocalManifest(publicKeyHex) {
  try {
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

// Parse command line args
const args = process.argv.slice(2);
const publicKeyHex = args.find(arg => !arg.startsWith('--'));
const watchMode = args.includes('--watch');
const watchIntervalArg = args.find(arg => arg.startsWith('--interval='));
const watchInterval = watchIntervalArg ? parseInt(watchIntervalArg.split('=')[1]) * 1000 : 30000;

if (!publicKeyHex) {
  console.log('Usage: node find-messages.js <public-key> [--watch] [--interval=30]');
  console.log('');
  console.log('Options:');
  console.log('  --watch          Continuously monitor for new messages');
  console.log('  --interval=N     Poll interval in seconds (default: 30)');
  process.exit(1);
}

// Validate public key format
if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
  console.error('Error: Invalid public key format. Expected 64 hex characters.');
  process.exit(1);
}

const publicKey = Buffer.from(publicKeyHex, 'hex');

let dht = null;
let client = null;
let lastSeq = -1;
let knownInfohashes = new Set();

// Display messages from a manifest (local mode)
async function displayMessagesFromManifest(manifest) {
  // Verify manifest signature
  if (!verifyManifest(manifest)) {
    console.error('Warning: Manifest signature verification failed!');
  } else {
    console.log('Manifest signature verified');
  }

  console.log('');
  console.log('Found', manifest.messages.length, 'message(s)');
  console.log('');

  // Try to load messages from local files
  const files = fs.readdirSync(MESSAGES_DIR);
  const messageFiles = files.filter(f => f.startsWith('msg-'));

  for (let i = 0; i < manifest.messages.length; i++) {
    const msgInfo = manifest.messages[i];

    console.log('-'.repeat(60));
    console.log('Message', i + 1, '/', manifest.messages.length);
    console.log('Infohash:', msgInfo.infohash);
    console.log('Timestamp:', new Date(msgInfo.timestamp).toISOString());

    // Try to find matching local message file
    let message = null;
    for (const file of messageFiles) {
      try {
        const content = fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8');
        const parsed = JSON.parse(content);
        if (parsed.timestamp === msgInfo.timestamp && parsed.publicKey === manifest.publicKey) {
          message = parsed;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (message) {
      const isValid = verifyMessage(message);
      console.log('Signature:', isValid ? 'VALID' : 'INVALID');
      console.log('Source: local file');

      if (isValid) {
        console.log('');
        console.log('Content:');
        console.log('  ', message.content);
      }
    } else {
      console.log('Message not found locally, would need torrent download');
    }

    console.log('');
  }

  return true;
}

async function fetchAndDisplayMessages() {
  // Get manifest from DHT (with longer timeout for better propagation)
  console.log('Querying DHT for manifest (this may take up to 2 minutes)...');
  console.log('Make sure the publisher is running share-message.js to seed and announce!');
  console.log('');
  const result = await getMutable(dht, publicKey, 120000, 10);

  let manifestInfohash;
  let currentSeq;

  if (result && result.value) {
    manifestInfohash = result.value.toString('utf8');
    currentSeq = result.seq;
    console.log('Found manifest in DHT');
  } else {
    // DHT lookup failed
    console.log('');
    console.log('Could not find messages via DHT.');
    console.log('');
    console.log('Possible reasons:');
    console.log('  1. The publisher is not running (share-message.js must keep running to seed)');
    console.log('  2. DHT data has not propagated yet (try again in a few minutes)');
    console.log('  3. Network connectivity issues');
    console.log('');
    console.log('The publisher needs to run share-message.js continuously to:');
    console.log('  - Seed the torrent files');
    console.log('  - Re-announce to DHT every 60 seconds');
    return false;
  }

  // In watch mode, check if seq changed
  if (watchMode && currentSeq === lastSeq) {
    return false; // No new messages
  }

  console.log('Found manifest (seq:', currentSeq, ', infohash:', manifestInfohash, ')');
  lastSeq = currentSeq;

  // Try to load manifest locally first, then fall back to torrent download
  console.log('Loading manifest...');
  let manifest;

  // Check if we have the manifest locally
  const localManifest = tryLoadLocalManifest(publicKeyHex);
  if (localManifest) {
    manifest = localManifest;
    console.log('Loaded manifest from local files');
  } else {
    try {
      console.log('Downloading manifest via torrent...');
      manifest = await downloadJSON(client, manifestInfohash, 60000);
    } catch (err) {
      console.error('Failed to download manifest:', err.message);
      return false;
    }
  }

  // Verify manifest signature
  if (!verifyManifest(manifest)) {
    console.error('Warning: Manifest signature verification failed!');
  } else {
    console.log('Manifest signature verified');
  }

  console.log('');
  console.log('Found', manifest.messages.length, 'message(s)');
  console.log('');

  // Download and display each message
  for (let i = 0; i < manifest.messages.length; i++) {
    const msgInfo = manifest.messages[i];

    // Skip already known messages in watch mode
    if (watchMode && knownInfohashes.has(msgInfo.infohash)) {
      continue;
    }

    console.log('-'.repeat(60));
    console.log('Message', i + 1, '/', manifest.messages.length);
    console.log('Infohash:', msgInfo.infohash);
    console.log('Timestamp:', new Date(msgInfo.timestamp).toISOString());

    try {
      // Try to find message locally first
      let message = null;
      const files = fs.readdirSync(MESSAGES_DIR);
      for (const file of files) {
        if (file.startsWith('msg-')) {
          try {
            const content = fs.readFileSync(path.join(MESSAGES_DIR, file), 'utf8');
            const parsed = JSON.parse(content);
            if (parsed.timestamp === msgInfo.timestamp && parsed.publicKey === manifest.publicKey) {
              message = parsed;
              console.log('Found message locally');
              break;
            }
          } catch (e) {
            continue;
          }
        }
      }

      // Fall back to torrent download
      if (!message) {
        console.log('Downloading message via torrent...');
        message = await downloadJSON(client, msgInfo.infohash, 60000);
      }

      // Verify message signature
      const isValid = verifyMessage(message);
      console.log('Signature:', isValid ? 'VALID' : 'INVALID');

      if (isValid) {
        console.log('');
        console.log('Content:');
        console.log('  ', message.content);
      } else {
        console.log('Warning: Message signature verification failed!');
      }

      knownInfohashes.add(msgInfo.infohash);
    } catch (err) {
      console.error('Failed to download message:', err.message);
    }

    console.log('');
  }

  return true;
}

async function watchLoop() {
  console.log('');
  console.log('Watch mode active. Polling every', watchInterval / 1000, 'seconds...');
  console.log('Press Ctrl+C to stop');
  console.log('');

  while (true) {
    try {
      const hasNew = await fetchAndDisplayMessages();
      if (!hasNew && lastSeq >= 0) {
        console.log('[' + new Date().toISOString() + '] No new messages');
      }
    } catch (err) {
      console.error('Error during poll:', err.message);
    }

    await new Promise(resolve => setTimeout(resolve, watchInterval));
  }
}

async function main() {
  console.log('Finding messages for public key:', publicKeyHex);
  console.log('');

  try {
    // Initialize DHT and WebTorrent client
    console.log('Connecting to DHT network...');
    dht = await createDHT();
    console.log('DHT ready');

    console.log('Starting WebTorrent client...');
    client = createClient();
    console.log('WebTorrent ready');
    console.log('');

    if (watchMode) {
      await watchLoop();
    } else {
      await fetchAndDisplayMessages();

      console.log('='.repeat(60));
      console.log('Done');

      // Cleanup
      await destroyClient(client);
      await destroyDHT(dht);
    }

  } catch (err) {
    console.error('Error:', err.message);
    if (client) await destroyClient(client);
    if (dht) await destroyDHT(dht);
    process.exit(1);
  }
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
  console.log('');
  console.log('Shutting down...');
  if (client) await destroyClient(client);
  if (dht) await destroyDHT(dht);
  process.exit(0);
});

main();
