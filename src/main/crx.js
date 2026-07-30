// Chrome derives an extension's ID from the public half of the key it was
// signed with: sha256 of the SPKI DER, first 16 bytes, hex digits remapped
// from 0-9a-f to a-p. We need the ID up front, because the managed-policy
// entry that force-installs the extension is keyed by it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Stable location for the signing key + packed CRX, outside the repo so a
 *  `git pull` never clobbers them and the ID stays constant. */
function keyDir(app) {
  const dir = path.join(app.getPath('userData'), 'extension-build');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function keyPath(app) {
  return path.join(keyDir(app), 'focuslock.pem');
}

function crxPath(app) {
  return path.join(keyDir(app), 'focuslock.crx');
}

/** Create the signing key once and reuse it forever after. */
function ensureKey(app) {
  const file = keyPath(app);
  if (fs.existsSync(file)) return file;

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600 });
  return file;
}

function publicKeyDer(privatePem) {
  return crypto
    .createPublicKey(privatePem)
    .export({ type: 'spki', format: 'der' });
}

function idFromPublicKeyDer(der) {
  const digest = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const ch of digest) {
    id += String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16));
  }
  return id;
}

function extensionId(app) {
  const pem = fs.readFileSync(ensureKey(app), 'utf8');
  return idFromPublicKeyDer(publicKeyDer(pem));
}

module.exports = {
  keyDir,
  keyPath,
  crxPath,
  ensureKey,
  extensionId,
  idFromPublicKeyDer,
  publicKeyDer,
};
