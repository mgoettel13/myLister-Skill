import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { operations } from '../dist/tools.js';

// Uses Codex's OAuth store through its protocol, never reads or prints credentials.
// Only requests tool inventory. No account data reads or writes are performed.
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--production') || args.length > 1) {
  throw new Error('Usage: node scripts/verify-installed-metadata.mjs [--production]');
}
const name = args.includes('--production') ? 'mylister-production' : 'mylister';
const child = spawn(process.env.CODEX_CLI_PATH || 'codex', ['app-server', '--stdio'], {
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
});
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
child.stderr.resume();
const rejectAll = () => {
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Codex metadata process stopped before completing the check'));
  }
  pending.clear();
};
child.on('error', rejectAll);
child.on('exit', rejectAll);
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method && message.id !== undefined) {
    child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only metadata verifier does not handle interactive requests' } })}\n`);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  if (message.error) entry.reject(new Error('Codex rejected the metadata request'));
  else entry.resolve(message.result);
});
function request(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Timed out checking installed metadata'));
    }, 90_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  await request('initialize', { clientInfo: { name: 'mylister-metadata-check', version: '1.0.0' } });
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  let found;
  let cursor;
  do {
    const page = await request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', limit: 100, cursor });
    found = page.data.find(server => server.name === name);
    cursor = page.nextCursor;
  } while (!found && cursor);
  assert.ok(found, `${name} is not installed`);
  assert.equal(found.authStatus, 'oAuth', `${name} requires OAuth sign-in`);
  const live = Object.values(found.tools);
  assert.deepEqual(live.map(tool => tool.name).sort(), [...operations.keys()].sort(), 'Tool names differ');
  for (const tool of live) {
    const expected = operations.get(tool.name).tool;
    assert.deepEqual(tool.annotations, expected.annotations, `${tool.name}: annotation mismatch`);
    assert.deepEqual(tool.inputSchema, expected.inputSchema, `${tool.name}: input schema mismatch`);
  }
  console.log(`PASS ${name}: all ${live.length} deployed tool schemas and annotations match the reviewed build`);
} catch (error) {
  // Assertion operands contain metadata only, but keep output small and deterministic.
  console.error(`FAIL ${name}: ${String(error.message).split('\n')[0]}`);
  process.exitCode = 1;
} finally {
  lines.close();
  child.stdin.end();
  child.kill();
}
