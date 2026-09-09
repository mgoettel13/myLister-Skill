import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const packages = [
  { name: 'mylister', endpoint: 'https://mylister-connector-staging.up.railway.app/mcp' },
  { name: 'mylister-production', endpoint: 'https://mcp.mylister.dev/mcp' },
];

for (const { name, endpoint } of packages) {
  test(`${name} package binds only its intended endpoint without embedded credentials`, () => {
    const root = new URL(`../../plugins/${name}/`, import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL('.codex-plugin/plugin.json', root), 'utf8'));
    assert.equal(manifest.name, name);
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.equal(manifest.skills, './skills/');
    assert.ok(existsSync(new URL('skills/mylister/SKILL.md', root)));
    assert.ok(existsSync(new URL(manifest.interface.logo, root)));
    const mcp = JSON.parse(readFileSync(new URL(manifest.mcpServers, root), 'utf8'));
    assert.deepEqual(mcp, { mcpServers: { [name]: { type: 'http', url: endpoint } } });
  });
}
