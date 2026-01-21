import DHT from 'bittorrent-dht';
import crypto from 'crypto';

// Well-known DHT bootstrap nodes - using many for better connectivity
const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
  { host: 'dht.aelitis.com', port: 6881 },
  { host: 'router.silotis.us', port: 6881 }
];

/**
 * Create and bootstrap a DHT instance
 * @returns {Promise<DHT>}
 */
export function createDHT() {
  return new Promise((resolve, reject) => {
    const dht = new DHT({
      verify: crypto.verify,
      bootstrap: BOOTSTRAP_NODES
    });

    let resolved = false;
    let nodeCount = 0;

    dht.on('ready', () => {
      console.log('DHT listening, waiting for nodes...');
    });

    // Wait for nodes to be added - need more for reliable BEP44
    dht.on('node', (node) => {
      nodeCount++;
      if (!resolved && nodeCount >= 20) {
        resolved = true;
        console.log(`Connected to ${nodeCount} DHT nodes`);
        resolve(dht);
      }
    });

    dht.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    // Start listening
    dht.listen();

    // Timeout if bootstrap takes too long - but still resolve with whatever we have
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.log(`Bootstrap timeout after 30s, connected to ${nodeCount} nodes`);
        if (nodeCount > 0) {
          resolve(dht);
        } else {
          // Try to manually bootstrap
          console.log('Attempting manual bootstrap...');
          for (const node of BOOTSTRAP_NODES) {
            dht.addNode(node);
          }
          setTimeout(() => {
            const finalCount = dht.toJSON().nodes?.length || 0;
            console.log(`After manual bootstrap: ${finalCount} nodes`);
            resolve(dht);
          }, 10000);
        }
      }
    }, 30000);
  });
}

/**
 * Get a mutable item from DHT by public key (BEP44)
 * @param {DHT} dht - DHT instance
 * @param {Buffer} publicKey - 32-byte ed25519 public key
 * @param {number} timeout - Timeout in milliseconds
 * @param {number} retries - Number of retry attempts
 * @returns {Promise<{ seq: number, value: Buffer } | null>}
 */
export function getMutable(dht, publicKey, timeout = 30000, retries = 3) {
  return new Promise((resolve) => {
    let resolved = false;
    let bestResult = null;
    let attemptCount = 0;

    const attemptGet = () => {
      attemptCount++;
      console.log(`DHT lookup attempt ${attemptCount}/${retries + 1}...`);

      dht.get(publicKey, (err, result) => {
        if (resolved) return;

        if (err) {
          console.log(`DHT get error: ${err.message}`);
        }

        if (result && result.v) {
          // Keep the result with highest sequence number
          if (!bestResult || result.seq > bestResult.seq) {
            bestResult = {
              seq: result.seq,
              value: result.v
            };
            console.log(`Found result with seq: ${result.seq}`);
          }
        }
      });
    };

    // Start first attempt
    attemptGet();

    // Schedule retry attempts
    for (let i = 1; i <= retries; i++) {
      setTimeout(() => {
        if (!resolved && !bestResult) {
          attemptGet();
        }
      }, i * 5000); // Retry every 5 seconds
    }

    // Final timeout - resolve with whatever we have
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        if (bestResult) {
          console.log(`DHT lookup succeeded with seq: ${bestResult.seq}`);
        } else {
          console.log('DHT lookup timed out with no results');
        }
        resolve(bestResult);
      }
    }, timeout);

    // Also resolve early if we get a result
    const checkInterval = setInterval(() => {
      if (bestResult && !resolved) {
        // Wait a bit more for potentially better results
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeoutId);
            clearInterval(checkInterval);
            resolve(bestResult);
          }
        }, 3000);
      }
    }, 1000);
  });
}

/**
 * Put a mutable item to DHT (BEP44)
 * @param {DHT} dht - DHT instance
 * @param {Buffer} publicKey - 32-byte ed25519 public key
 * @param {Buffer} privateKey - 32-byte ed25519 private key
 * @param {Buffer|string} value - Value to store (max 1000 bytes)
 * @param {number} seq - Sequence number (must be higher than previous)
 * @param {number} retries - Number of retries
 * @returns {Promise<Buffer>} - Hash of the stored item
 */
export function putMutable(dht, publicKey, privateKey, value, seq, retries = 3) {
  return new Promise((resolve, reject) => {
    const valueBuffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');

    if (valueBuffer.length > 1000) {
      reject(new Error('Value exceeds 1000 byte limit for BEP44'));
      return;
    }

    // Create the signing function for BEP44
    const sign = (buf) => {
      const keyObject = crypto.createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          privateKey
        ]),
        format: 'der',
        type: 'pkcs8'
      });
      return crypto.sign(null, buf, keyObject);
    };

    const opts = {
      k: publicKey,
      v: valueBuffer,
      seq: seq,
      sign: sign
    };

    const attemptPut = (attemptsLeft) => {
      // Check if DHT has nodes
      const nodes = dht.toJSON().nodes;
      if ((!nodes || nodes.length === 0) && attemptsLeft > 0) {
        console.log(`Waiting for DHT nodes... (${attemptsLeft} retries left)`);
        setTimeout(() => attemptPut(attemptsLeft - 1), 5000);
        return;
      }

      dht.put(opts, (err, hash) => {
        if (err) {
          if (attemptsLeft > 0 && err.message.includes('No nodes')) {
            console.log(`Retrying DHT put... (${attemptsLeft} retries left)`);
            setTimeout(() => attemptPut(attemptsLeft - 1), 5000);
          } else {
            reject(err);
          }
        } else {
          resolve(hash);
        }
      });
    };

    attemptPut(retries);
  });
}

/**
 * Destroy DHT instance
 * @param {DHT} dht
 * @returns {Promise<void>}
 */
export function destroyDHT(dht) {
  return new Promise((resolve) => {
    dht.destroy(() => {
      resolve();
    });
  });
}
