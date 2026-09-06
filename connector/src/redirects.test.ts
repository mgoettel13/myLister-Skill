import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedRedirect } from './redirects.js';

test('native Codex callbacks allow explicit loopback ports only when configured', () => {
  assert.equal(allowedRedirect('http://127.0.0.1:54321/callback', [], false), false);
  assert.equal(allowedRedirect('http://127.0.0.1:54321/callback', [], true), true);
  assert.equal(allowedRedirect('http://localhost:43123/callback/server-id', [], true), true);
  for (const uri of ['http://192.168.1.1:1234/callback', 'http://127.0.0.1.evil.example:1234/callback', 'http://localhost:1234/admin', 'http://localhost:1234/callback?next=evil', 'http://user@localhost:1234/callback', 'http://localhost/callback']) {
    assert.equal(allowedRedirect(uri, [], true), false, uri);
  }
});
