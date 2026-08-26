import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = 500 * 1024 * 1024;
const MAX_CERT_SIZE = 10 * 1024 * 1024;
const MAX_PROFILE_SIZE = 10 * 1024 * 1024;
const SIGN_TIMEOUT_MS = 15 * 60 * 1000;
const TMP_ROOT = path.join(os.tmpdir(), 'ipa-signer');
const configuredOrigins = (process.env.ALLOWED_ORIGIN || '').split(',').map(v => v.trim()).filter(Boolean);
const allowedOrigins = new Set(['https://scarlet-ipainstall.github.io', ...configuredOrigins]);

await fs.mkdir(TMP_ROOT, { recursive: true });
app.disable('x-powered-by');

// CORS for the GitHub Pages signer. No credentials/cookies are used by the API.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.has(origin) || allowedOrigins.has('*'))) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.has('*') ? '*' : origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signer-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const upload = multer({
  dest: TMP_ROOT,
  limits: { fileSize: MAX_FILE_SIZE, files: 3, fields: 1, parts: 4 }
});

const recentRequests = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 3;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}
function rateAllowed(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const recent = (recentRequests.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  recentRequests.set(ip, recent);
  return true;
}
function hasExt(file, ...extensions) {
  return extensions.includes(path.extname(file.originalname || '').toLowerCase());
}
async function removeUploads(files = []) {
  await Promise.all(files.filter(Boolean).map(file => fs.rm(file.path || file, { force: true }).catch(() => {})));
}

// Lightweight endpoints intentionally do not execute zsign. They must respond
// immediately so a sleeping SnapDeploy container can be woken by normal HTTP traffic.
app.get('/', (_req, res) => res.json({ ok: true, service: 'ipa-signer', status: 'online' }));
app.get('/health', async (req, res) => {
  if (req.query.deep === '1') {
    try {
      await exec('zsign', ['-h'], { timeout: 5000, maxBuffer: 256 * 1024 });
      return res.json({ ok: true, ready: true, signer: 'zsign', maxIpaMB: 500 });
    } catch {
      return res.status(503).json({ ok: false, ready: false, error: 'zsign is unavailable' });
    }
  }
  res.json({ ok: true, ready: true, signer: 'zsign', maxIpaMB: 500 });
});

app.post('/sign', upload.fields([
  { name: 'ipa', maxCount: 1 },
  { name: 'p12', maxCount: 1 },
  { name: 'provision', maxCount: 1 }
]), async (req, res) => {
  const ipa = req.files?.ipa?.[0];
  const p12 = req.files?.p12?.[0];
  const profile = req.files?.provision?.[0];
  const uploaded = [ipa, p12, profile];
  let workDir = null;

  try {
    if (!rateAllowed(req)) {
      await removeUploads(uploaded);
      return res.status(429).json({ error: 'Too many signing requests. Please wait a few minutes.' });
    }
    const password = String(req.body?.p12_password ?? '');
    if (!ipa || !p12 || !profile) {
      await removeUploads(uploaded);
      return res.status(400).json({ error: 'IPA, P12, and provisioning profile are required.' });
    }
    if (!password) {
      await removeUploads(uploaded);
      return res.status(400).json({ error: 'The P12 password is required.' });
    }
    if (!hasExt(ipa, '.ipa')) {
      await removeUploads(uploaded);
      return res.status(400).json({ error: 'The app file must end in .ipa.' });
    }
    if (!hasExt(p12, '.p12', '.pfx')) {
      await removeUploads(uploaded);
      return res.status(400).json({ error: 'The certificate must be .p12 or .pfx.' });
    }
    if (!hasExt(profile, '.mobileprovision')) {
      await removeUploads(uploaded);
      return res.status(400).json({ error: 'The provisioning profile must end in .mobileprovision.' });
    }
    if (ipa.size > MAX_FILE_SIZE) {
      await removeUploads(uploaded);
      return res.status(413).json({ error: 'The IPA exceeds the 500 MB maximum.' });
    }
    if (p12.size > MAX_CERT_SIZE || profile.size > MAX_PROFILE_SIZE) {
      await removeUploads(uploaded);
      return res.status(413).json({ error: 'The certificate or provisioning profile is unexpectedly large.' });
    }

    workDir = await fs.mkdtemp(path.join(TMP_ROOT, 'job-'));
    const inputIpa = path.join(workDir, 'input.ipa');
    const cert = path.join(workDir, 'certificate.p12');
    const provision = path.join(workDir, 'profile.mobileprovision');
    const output = path.join(workDir, 'signed.ipa');

    await Promise.all([
      fs.rename(ipa.path, inputIpa),
      fs.rename(p12.path, cert),
      fs.rename(profile.path, provision)
    ]);

    await exec('zsign', ['-q', '-z', '0', '-k', cert, '-p', password, '-m', provision, '-o', output, inputIpa], {
      timeout: SIGN_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024
    });

    const stat = await fs.stat(output);
    if (!stat.isFile() || stat.size === 0) throw new Error('zsign produced no output');

    await Promise.all([
      fs.rm(inputIpa, { force: true }),
      fs.rm(cert, { force: true }),
      fs.rm(provision, { force: true })
    ]);

    const base = path.basename(ipa.originalname || 'app.ipa', '.ipa').replace(/[^A-Za-z0-9._-]/g, '_');
    const cleanupDir = workDir;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="signed-${base}.ipa"`);
    res.setHeader('Content-Length', String(stat.size));
    res.sendFile(output, async () => {
      await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => {});
    });
    workDir = null;
  } catch (err) {
    console.error('IPA signing error:', err?.message || err);
    await removeUploads(uploaded);
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Upload exceeds the 500 MB maximum.' });
    if (err?.killed || err?.signal === 'SIGTERM') return res.status(504).json({ error: 'Signing timed out. Large IPAs can take several minutes.' });
    return res.status(500).json({ error: 'Signing failed. Check the IPA, P12 password, certificate, and provisioning profile.' });
  }
});

app.use((err, _req, res, _next) => {
  console.error('Upload error:', err?.message || err);
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Upload exceeds the 500 MB maximum.' });
  if (err?.code === 'LIMIT_PART_COUNT' || err?.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Too many uploaded parts.' });
  return res.status(400).json({ error: 'Invalid multipart upload.' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`IPA signer listening on ${PORT}; max IPA 500 MB`));
server.requestTimeout = SIGN_TIMEOUT_MS;
server.headersTimeout = SIGN_TIMEOUT_MS + 30000;
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of recentRequests) {
    const recent = times.filter(t => now - t < RATE_WINDOW_MS);
    if (recent.length) recentRequests.set(ip, recent); else recentRequests.delete(ip);
  }
}, RATE_WINDOW_MS).unref();
process.on('SIGTERM', () => server.close(() => process.exit(0)));
