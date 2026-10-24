// Admin tool for the partner API (netlify/functions/partner-api.mts): issue and
// revoke a partner's API keys, and decide which units and pools a partner may
// see. Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (for example `netlify dev:exec node scripts/partner-key.mjs ...`) and
// migration 0060 applied to the TVC ERP project.
//
//   node scripts/partner-key.mjs units                            # the unit catalogue and pools
//   node scripts/partner-key.mjs create-pool <poolId> "<name>"
//   node scripts/partner-key.mjs add-to-pool <poolId> <unitId>...
//   node scripts/partner-key.mjs grant-unit <partnerId> <unitId>...
//   node scripts/partner-key.mjs grant-pool <partnerId> <poolId>
//   node scripts/partner-key.mjs revoke-unit <partnerId> <unitId>
//   node scripts/partner-key.mjs revoke-pool <partnerId> <poolId>
//   node scripts/partner-key.mjs issue <partnerId> "<key name>" [--expires 2027-10-01] [--print-sql]
//   node scripts/partner-key.mjs keys [partnerId]
//   node scripts/partner-key.mjs revoke <keyId>
//
// `issue --print-sql` needs NO database access and no secrets: it generates the key locally and prints
// the key plus an INSERT statement (the hash only) for you to run in the Supabase SQL editor. Use it for a
// real partner key, so the key exists only on your machine and in the channel you hand it over on (never
// in a chat with an AI assistant, a ticket or a repository).
//
// `issue` prints the key ONCE. It is not stored (only its SHA-256 hash is), so
// it cannot be shown again: copy it straight to the partner's secure channel.
// Two active keys per partner are fine, which is how a key is rotated: issue
// the new one, let the partner switch, then revoke the old one.
import { userInfo } from 'node:os';
import { generatePartnerKey } from './lib/partner-keys.mjs';
import {
  insertKey,
  listKeys,
  revokeKey,
  listUnits,
  createPool,
  grantUnits,
  grantPool,
  revokeUnitGrant,
  revokePoolGrant,
  setUnitPool,
} from './lib/partner-db.mjs';

const [command, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === '--expires') {
    flags.expires = rest[i + 1];
    i += 1;
  } else if (rest[i] === '--print-sql') {
    flags.printSql = true;
  } else {
    args.push(rest[i]);
  }
}

const PARTNER_ID = /^[a-z0-9][a-z0-9-]{1,31}$/;

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: see the header of scripts/partner-key.mjs');
  process.exit(2);
}

function needPartner(id) {
  if (!id || !PARTNER_ID.test(id)) usage('partnerId must be 2-32 lowercase letters, digits or dashes (e.g. linger)');
}

try {
  switch (command) {
    case 'units': {
      for (const u of await listUnits()) {
        const owner = u.owner_type === 'member' ? `member ${u.owner_farm_unit}` : 'TVC';
        console.log(`${u.id.padEnd(8)} ${String(u.capacity).padStart(2)}  ${u.active ? 'active  ' : 'inactive'}  ${owner.padEnd(12)} pool=${u.pool_id ?? '-'}  ${u.name}`);
      }
      break;
    }
    case 'create-pool': {
      const [id, name] = args;
      if (!id || !name) usage('create-pool needs <poolId> "<name>"');
      await createPool(id, name);
      console.log(`Pool ${id} saved.`);
      break;
    }
    case 'add-to-pool': {
      const [poolId, ...unitIds] = args;
      if (!poolId || unitIds.length === 0) usage('add-to-pool needs <poolId> <unitId>...');
      await setUnitPool(unitIds, poolId);
      console.log(`${unitIds.length} unit(s) moved into pool ${poolId}.`);
      break;
    }
    case 'grant-unit': {
      const [partnerId, ...unitIds] = args;
      needPartner(partnerId);
      if (unitIds.length === 0) usage('grant-unit needs at least one <unitId>');
      await grantUnits(partnerId, unitIds);
      console.log(`${partnerId} may now see ${unitIds.join(', ')}.`);
      break;
    }
    case 'grant-pool': {
      const [partnerId, poolId] = args;
      needPartner(partnerId);
      if (!poolId) usage('grant-pool needs <poolId>');
      await grantPool(partnerId, poolId);
      console.log(`${partnerId} may now see pool ${poolId}.`);
      break;
    }
    case 'revoke-unit': {
      const [partnerId, unitId] = args;
      needPartner(partnerId);
      if (!unitId) usage('revoke-unit needs <unitId>');
      await revokeUnitGrant(partnerId, unitId);
      console.log(`${partnerId} can no longer see ${unitId}.`);
      break;
    }
    case 'revoke-pool': {
      const [partnerId, poolId] = args;
      needPartner(partnerId);
      if (!poolId) usage('revoke-pool needs <poolId>');
      await revokePoolGrant(partnerId, poolId);
      console.log(`${partnerId} can no longer see pool ${poolId}.`);
      break;
    }
    case 'issue': {
      const [partnerId, name] = args;
      needPartner(partnerId);
      if (!name) usage('issue needs a "<key name>", for example "Linger production"');
      let expiresAt = null;
      if (flags.expires) {
        const parsed = new Date(`${flags.expires}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime())) usage('--expires must be a date like 2027-10-01');
        expiresAt = parsed.toISOString();
      }
      const { key, prefix, hash } = generatePartnerKey();
      if (flags.printSql) {
        const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
        console.log('Run this in the Supabase SQL editor (TVC ERP). It contains only the key\'s hash:');
        console.log('');
        console.log('insert into partner_api_keys (partner_id, name, key_prefix, key_hash, created_by, expires_at)');
        console.log(`values (${q(partnerId)}, ${q(name)}, ${q(prefix)}, ${q(hash)}, ${q(userInfo().username)}, ${expiresAt ? q(expiresAt) : 'null'});`);
        console.log('');
        console.log(`Prefix: ${prefix}… (quote this to the partner to confirm they received the right key)`);
        console.log('');
        console.log('API key (shown once, never stored; hand it over on a secure channel):');
        console.log(key);
        break;
      }
      const row = await insertKey({ partnerId, name, prefix, hash, createdBy: userInfo().username, expiresAt });
      console.log(`Key id:  ${row.id}`);
      console.log(`Partner: ${partnerId}`);
      console.log(`Prefix:  ${prefix}…`);
      console.log('');
      console.log('API key (shown once, not stored; send it over a secure channel):');
      console.log(key);
      break;
    }
    case 'keys': {
      const rows = await listKeys(args[0]);
      for (const k of rows) {
        const state = k.revoked_at ? 'revoked' : k.expires_at && new Date(k.expires_at) <= new Date() ? 'expired' : 'active';
        console.log(`${k.id}  ${k.partner_id.padEnd(10)} ${state.padEnd(8)} ${k.key_prefix}…  last used ${k.last_used_at ?? 'never'}  "${k.name}"`);
      }
      if (rows.length === 0) console.log('No keys.');
      break;
    }
    case 'revoke': {
      const [keyId] = args;
      if (!keyId) usage('revoke needs <keyId>');
      const row = await revokeKey(keyId);
      console.log(row ? `Key ${row.key_prefix}… revoked; it stops working on its next request.` : 'No active key with that id.');
      break;
    }
    default:
      usage(command ? `Unknown command "${command}"` : undefined);
  }
} catch (err) {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
}
