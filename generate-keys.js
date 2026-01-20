#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateKeypair } from './lib/crypto-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Check if keys already exist
if (fs.existsSync(KEYS_FILE)) {
  const existing = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
  console.log('Keys already exist!');
  console.log('');
  console.log('Public Key (share this):');
  console.log(existing.publicKey);
  console.log('');
  console.log('To generate new keys, delete data/keys.json first.');
  process.exit(0);
}

// Generate new keypair
console.log('Generating ed25519 keypair...');
const { publicKey, privateKey } = generateKeypair();

// Save keys
const keys = {
  publicKey: publicKey.toString('hex'),
  privateKey: privateKey.toString('hex'),
  createdAt: new Date().toISOString()
};

fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));

console.log('');
console.log('Keys generated and saved to data/keys.json');
console.log('');
console.log('Public Key (share this):');
console.log(keys.publicKey);
console.log('');
console.log('Keep your private key secret! Never share data/keys.json');
