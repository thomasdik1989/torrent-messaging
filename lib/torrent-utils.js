import WebTorrent from 'webtorrent';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Readable } from 'stream';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data', 'messages');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Common trackers
const TRACKERS = [
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.opentrackr.org:1337',
  'udp://open.stealth.si:80/announce',
  'udp://exodus.desync.com:6969/announce'
];

/**
 * Create a WebTorrent client
 * @returns {WebTorrent}
 */
export function createClient() {
  return new WebTorrent({
    dht: true,
    tracker: true
  });
}

/**
 * Destroy a WebTorrent client
 * @param {WebTorrent} client
 * @returns {Promise<void>}
 */
export function destroyClient(client) {
  return new Promise((resolve) => {
    client.destroy((err) => {
      resolve();
    });
  });
}

/**
 * Seed a JSON object as a torrent
 * @param {WebTorrent} client
 * @param {object} data - Data to seed
 * @param {string} filename - Filename for the torrent
 * @returns {Promise<{ infohash: string, magnetURI: string }>}
 */
export function seedJSON(client, data, filename) {
  return new Promise((resolve, reject) => {
    const content = JSON.stringify(data, null, 2);

    // Save to local data directory for seeding
    const filePath = path.join(DATA_DIR, filename);
    fs.writeFileSync(filePath, content);

    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Seed timeout for ${filename}`));
      }
    }, 30000);

    const torrent = client.seed(filePath, { announce: TRACKERS }, (torrent) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve({
        infohash: torrent.infoHash,
        magnetURI: torrent.magnetURI
      });
    });

    // Handle torrent-specific errors
    if (torrent && torrent.on) {
      torrent.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    }
  });
}

/**
 * Download a torrent by infohash and return its content
 * @param {WebTorrent} client
 * @param {string} infohash - Torrent infohash
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<object>} - Parsed JSON content
 */
export function downloadJSON(client, infohash, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const magnetURI = `magnet:?xt=urn:btih:${infohash}&tr=${TRACKERS.map(t => encodeURIComponent(t)).join('&tr=')}`;

    let resolved = false;
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Download timeout for ${infohash}`));
      }
    }, timeout);

    // Check if we already have this file locally
    const files = fs.readdirSync(DATA_DIR);
    for (const file of files) {
      const filePath = path.join(DATA_DIR, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const hash = crypto.createHash('sha1').update(content).digest('hex');
        // Try to match by reading existing torrents
        // This is a simplified check - in production you'd use proper torrent metadata
      } catch (e) {
        // Ignore read errors
      }
    }

    client.add(magnetURI, { path: DATA_DIR }, (torrent) => {
      torrent.on('done', () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);

        const file = torrent.files[0];
        if (!file) {
          reject(new Error('No file in torrent'));
          return;
        }

        file.getBuffer((err, buffer) => {
          if (err) {
            reject(err);
            return;
          }

          try {
            const data = JSON.parse(buffer.toString('utf8'));
            resolve(data);
          } catch (e) {
            reject(new Error('Invalid JSON in torrent'));
          }
        });
      });

      torrent.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    });
  });
}

/**
 * Generate a unique filename for a message
 * @param {string} publicKey
 * @param {number} timestamp
 * @returns {string}
 */
export function generateMessageFilename(publicKey, timestamp) {
  const hash = crypto.createHash('sha256')
    .update(`${publicKey}-${timestamp}`)
    .digest('hex')
    .slice(0, 8);
  return `msg-${hash}.json`;
}

/**
 * Generate a filename for a manifest
 * @param {string} publicKey
 * @param {number} seq
 * @returns {string}
 */
export function generateManifestFilename(publicKey, seq) {
  const keyPrefix = publicKey.slice(0, 8);
  return `manifest-${keyPrefix}-${seq}.json`;
}
