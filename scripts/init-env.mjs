// Create switch/.env from switch/.env.example with fresh random secrets (no openssl needed).
// Mirrors deploy/local/generate-env-secrets.sh in the Switch repo.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../switch/', import.meta.url));
if (existsSync(`${dir}.env`) && !process.argv.includes('--force')) { console.log('switch/.env already exists (use --force to regenerate).'); process.exit(0); }
let s = readFileSync(`${dir}.env.example`, 'utf8');
const hex = (n) => randomBytes(n).toString('hex');
for (const k of ['DB_PASSWORD', 'DB_OWNER_PASSWORD', 'AGENT_REGISTRATION_TOKEN', 'GATEWAY_ADMIN_PASSWORD', 'MATTERMOST_ADMIN_PASSWORD', 'MATTERMOST_USER_PASSWORD']) {
  s = s.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${hex(24)}`);
}
s = s.replace(/^SECRET_KEYS=.*$/m, `SECRET_KEYS=signoff:${hex(32)}`);
writeFileSync(`${dir}.env`, s);
console.log('Wrote switch/.env with fresh secrets. Next: npm run switch:up');
