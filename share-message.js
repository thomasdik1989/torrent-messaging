#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSignedMessage, signManifest } from './lib/crypto-utils.js';
import { createDHT, getMutable, putMutable, destroyDHT } from './lib/dht-store.js';
import {
  createClient,
  destroyClient,
  seedJSON,
  downloadJSON,
  generateMessageFilename,
  generateManifestFilename
} from './lib/torrent-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_FILE = path.join(__dirname, 'data', 'keys.json');
const LOCAL_INDEX_FILE = path.join(__dirname, 'data', 'local-index.json');

const MESSAGES_DIR = path.join(__dirname, 'data', 'messages');

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
  console.log('');

  let dht = null;
  let client = null;

  try {
    // Initialize DHT and WebTorrent client
    console.log('Connecting to DHT network...');
    dht = await createDHT();
    console.log('DHT ready');

    console.log('Starting WebTorrent client...');
    client = createClient();
    console.log('WebTorrent ready');
    console.log('');

    // Get current manifest from DHT or local files
    console.log('Checking for existing manifest...');
    const existing = await getMutable(dht, publicKey, 15000);

    let manifest;
    let seq = 1;

    if (existing && existing.value) {
      console.log('Found existing manifest in DHT (seq:', existing.seq, ')');
      const existingInfohash = existing.value.toString('utf8');
      seq = existing.seq + 1;

      try {
        console.log('Downloading existing manifest...');
        manifest = await downloadJSON(client, existingInfohash, 30000);
        console.log('Downloaded manifest with', manifest.messages.length, 'existing messages');
      } catch (err) {
        console.log('Could not download existing manifest, checking local files...');
        manifest = tryLoadLocalManifest(keys.publicKey);
        if (manifest) {
          console.log('Loaded local manifest with', manifest.messages.length, 'existing messages');
        } else {
          manifest = { publicKey: keys.publicKey, messages: [] };
        }
      }
    } else {
      // Try local index and local files as fallback
      console.log('DHT query returned no results, checking local...');
      const localIndex = loadLocalIndex();
      const localEntry = localIndex[keys.publicKey];

      if (localEntry) {
        seq = localEntry.seq + 1;
        manifest = tryLoadLocalManifest(keys.publicKey);
        if (manifest) {
          console.log('Loaded local manifest with', manifest.messages.length, 'existing messages (seq:', localEntry.seq, ')');
        } else {
          manifest = { publicKey: keys.publicKey, messages: [] };
        }
      } else {
        manifest = tryLoadLocalManifest(keys.publicKey);
        if (manifest) {
          console.log('Found local manifest file with', manifest.messages.length, 'existing messages');
        } else {
          console.log('No existing manifest found, creating new one');
          manifest = { publicKey: keys.publicKey, messages: [] };
        }
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

    // Update DHT with new manifest infohash
    console.log('Publishing to DHT (seq:', seq, ')...');
    await putMutable(dht, publicKey, privateKey, manifestTorrent.infohash, seq);
    console.log('Published to DHT successfully!');

    // Also save to local index for reliable local retrieval
    const localIndex = loadLocalIndex();
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
    console.log('Keep this process running to seed the torrent and maintain DHT presence...');
    console.log('Press Ctrl+C to stop');

    // Periodically re-announce to DHT to maintain presence
    const reannounceInterval = setInterval(async () => {
      try {
        console.log(`[${new Date().toISOString()}] Re-announcing to DHT...`);
        await putMutable(dht, publicKey, privateKey, manifestTorrent.infohash, seq);
        console.log(`[${new Date().toISOString()}] DHT re-announcement successful`);
      } catch (err) {
        console.log(`[${new Date().toISOString()}] DHT re-announcement failed: ${err.message}`);
      }
    }, 60000); // Re-announce every 60 seconds

    // Keep running to seed
    process.on('SIGINT', async () => {
      console.log('');
      console.log('Shutting down...');
      clearInterval(reannounceInterval);
      if (client) await destroyClient(client);
      if (dht) await destroyDHT(dht);
      process.exit(0);
    });

  } catch (err) {
    console.error('Error:', err.message);
    if (client) await destroyClient(client);
    if (dht) await destroyDHT(dht);
    process.exit(1);
  }
}

main();
