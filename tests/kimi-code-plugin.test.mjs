import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const MANIFEST = path.join(ROOT, 'kimi.plugin.json');

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : '';
}

test('kimi.plugin.json is valid per the Kimi Code plugin schema', () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  assert.match(m.name, /^[a-z0-9][a-z0-9_-]{0,63}$/, 'name must match the plugin id regex');
  assert.ok(m.version && m.description, 'version and description required');
  assert.ok(m.interface?.displayName, 'interface.displayName required');
  for (const key of ['skills', 'commands']) {
    assert.ok(m[key]?.startsWith('./'), `${key} must be a ./ path`);
    const dir = path.join(ROOT, m[key]);
    assert.ok(fs.statSync(dir).isDirectory(), `${key} dir must exist: ${m[key]}`);
    assert.ok(path.resolve(dir).startsWith(ROOT), `${key} must stay inside the plugin root`);
  }
  // No unsupported runtime fields
  for (const bad of ['tools', 'apps', 'inject', 'configFile']) {
    assert.equal(m[bad], undefined, `unsupported field: ${bad}`);
  }
});

test('every Kimi Code command file has description frontmatter and a prompt body', () => {
  const dir = path.join(ROOT, 'plugins/kimi-code/commands');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, 'expected at least 5 commands');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf-8');
    const fm = frontmatter(text);
    assert.match(fm, /description:\s*\S/, `${f} needs a description`);
    assert.ok(text.replace(/^---\n[\s\S]*?\n---/, '').trim().length > 50, `${f} needs a real prompt body`);
    // Native commands must not depend on the Claude Code broker
    assert.ok(!text.includes('broker.mjs'), `${f} must not reference the broker`);
    assert.ok(!text.includes('CLAUDE_PLUGIN_ROOT'), `${f} must not reference Claude paths`);
  }
});

test('crank-loop skill exists with valid frontmatter', () => {
  const skill = path.join(ROOT, 'plugins/kimi-code/skills/crank-loop/SKILL.md');
  const text = fs.readFileSync(skill, 'utf-8');
  const fm = frontmatter(text);
  assert.match(fm, /name:\s*crank-loop/);
  assert.match(fm, /description:\s*\S/);
});

test('kimi.plugin.json is included in the npm package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  assert.ok(pkg.files.includes('kimi.plugin.json') || pkg.files.includes('plugins/'), 'manifest must ship');
});
