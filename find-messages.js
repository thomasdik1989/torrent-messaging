#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { verifyMessage, verifyManifest } from './lib/crypto-utils.js';
import { createClient, destroyClient, downloadJSON } from './lib/torrent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES_DIR = path.join(__dirname, 'data', 'messages');

// Signaling server URL (can be overridden via environment variable)
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

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
  console.log('');
  console.log('Environment:');
  console.log('  SERVER_URL       Signaling server URL (default: http://localhost:3000)');
  process.exit(1);
}

// Validate public key format
if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
  console.error('Error: Invalid public key format. Expected 64 hex characters.');
  process.exit(1);
}

let client = null;
let lastSeq = -1;
let knownInfohashes = new Set();

async function fetchAndDisplayMessages() {
  // Query signaling server
  console.log('Querying server for manifest...');
  let serverEntry;
  
  try {
    serverEntry = await lookupFromServer(publicKeyHex);
  } catch (err) {
    console.error('Could not reach server:', err.message);
    return false;
  }

  if (!serverEntry) {
    console.log('No messages found for this public key.');
    console.log('');
    console.log('Make sure the publisher has:');
    console.log('  1. Run share-message.js to publish messages');
    console.log('  2. The server is running and reachable');
    return false;
  }

  const manifestInfohash = serverEntry.manifestInfohash;
  const currentSeq = serverEntry.seq;

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
  if (localManifest && localManifest.messages) {
    // Check if local manifest matches the server's infohash (same seq means same content)
    manifest = localManifest;
    console.log('Loaded manifest from local files');
  } else {
    try {
      console.log('Downloading manifest via torrent...');
      manifest = await downloadJSON(client, manifestInfohash, 60000);
      console.log('Downloaded manifest');
    } catch (err) {
      console.error('Failed to download manifest:', err.message);
      console.log('');
      console.log('Make sure the publisher is running share-message.js to seed the torrents.');
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
      if (fs.existsSync(MESSAGES_DIR)) {
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
  console.log('Server:', SERVER_URL);
  console.log('');

  try {
    // Initialize WebTorrent client
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
    }

  } catch (err) {
    console.error('Error:', err.message);
    if (client) await destroyClient(client);
    process.exit(1);
  }
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
  console.log('');
  console.log('Shutting down...');
  if (client) await destroyClient(client);
  process.exit(0);
});

main();
