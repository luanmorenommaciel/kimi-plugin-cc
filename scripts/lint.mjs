#!/usr/bin/env node
/**
 * Basic lint: verify all .mjs files parse correctly.
 */
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function findMjsFiles(dir, files = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      await findMjsFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      files.push(full);
    }
  }
  return files;
}

function checkFile(file) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--check', file], { stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      resolve({ file, ok: code === 0, stderr });
    });
  });
}

async function main() {
  const files = await findMjsFiles(ROOT);
  let errors = 0;

  for (const { file, ok, stderr } of await Promise.all(files.map(checkFile))) {
    if (!ok) {
      console.error(`Syntax error in ${path.relative(ROOT, file)}: ${stderr.trim()}`);
      errors++;
    }
  }

  if (errors === 0) {
    console.log(`✓ ${files.length} .mjs files parsed successfully`);
  } else {
    console.error(`✗ ${errors} file(s) with syntax errors`);
    process.exit(1);
  }
}

main();
