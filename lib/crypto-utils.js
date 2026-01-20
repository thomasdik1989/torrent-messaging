import crypto from 'crypto';

/**
 * Generate an ed25519 keypair
 * @returns {{ publicKey: Buffer, privateKey: Buffer }}
 */
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });

  // Extract the raw 32-byte keys from DER encoding
  // ed25519 public key in SPKI format has 12-byte header
  // ed25519 private key in PKCS8 format has 16-byte header + 2-byte length prefix
  const rawPublicKey = publicKey.subarray(-32);
  const rawPrivateKey = privateKey.subarray(-32);

  return {
    publicKey: rawPublicKey,
    privateKey: rawPrivateKey
  };
}

/**
 * Sign data with an ed25519 private key
 * @param {Buffer|string} data - Data to sign
 * @param {Buffer} privateKey - 32-byte raw private key
 * @returns {Buffer} 64-byte signature
 */
export function sign(data, privateKey) {
  const keyObject = crypto.createPrivateKey({
    key: Buffer.concat([
      // PKCS8 header for ed25519
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      privateKey
    ]),
    format: 'der',
    type: 'pkcs8'
  });

  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return crypto.sign(null, dataBuffer, keyObject);
}

/**
 * Verify a signature with an ed25519 public key
 * @param {Buffer|string} data - Original data
 * @param {Buffer} signature - 64-byte signature
 * @param {Buffer} publicKey - 32-byte raw public key
 * @returns {boolean} True if signature is valid
 */
export function verify(data, signature, publicKey) {
  try {
    const keyObject = crypto.createPublicKey({
      key: Buffer.concat([
        // SPKI header for ed25519
        Buffer.from('302a300506032b6570032100', 'hex'),
        publicKey
      ]),
      format: 'der',
      type: 'spki'
    });

    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    return crypto.verify(null, dataBuffer, keyObject, signature);
  } catch (err) {
    return false;
  }
}

/**
 * Create a signed message object
 * @param {string} content - Message content
 * @param {Buffer} publicKey - 32-byte public key
 * @param {Buffer} privateKey - 32-byte private key
 * @returns {{ content: string, timestamp: number, publicKey: string, signature: string }}
 */
export function createSignedMessage(content, publicKey, privateKey) {
  const timestamp = Date.now();
  const dataToSign = JSON.stringify({ content, timestamp, publicKey: publicKey.toString('hex') });
  const signature = sign(dataToSign, privateKey);

  return {
    content,
    timestamp,
    publicKey: publicKey.toString('hex'),
    signature: signature.toString('hex')
  };
}

/**
 * Verify a signed message
 * @param {object} message - Message object with content, timestamp, publicKey, signature
 * @returns {boolean} True if message signature is valid
 */
export function verifyMessage(message) {
  try {
    const { content, timestamp, publicKey, signature } = message;
    const dataToVerify = JSON.stringify({ content, timestamp, publicKey });
    return verify(
      dataToVerify,
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch (err) {
    return false;
  }
}

/**
 * Sign a manifest object
 * @param {object} manifest - Manifest with publicKey and messages array
 * @param {Buffer} privateKey - 32-byte private key
 * @returns {object} Manifest with signature added
 */
export function signManifest(manifest, privateKey) {
  const { publicKey, messages } = manifest;
  const dataToSign = JSON.stringify({ publicKey, messages });
  const signature = sign(dataToSign, privateKey);

  return {
    publicKey,
    messages,
    signature: signature.toString('hex')
  };
}

/**
 * Verify a manifest signature
 * @param {object} manifest - Manifest with publicKey, messages, and signature
 * @returns {boolean} True if manifest signature is valid
 */
export function verifyManifest(manifest) {
  try {
    const { publicKey, messages, signature } = manifest;
    const dataToVerify = JSON.stringify({ publicKey, messages });
    return verify(
      dataToVerify,
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch (err) {
    return false;
  }
}
