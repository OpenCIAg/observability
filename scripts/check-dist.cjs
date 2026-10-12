// Garante que todo entry point do "exports" existe no dist (tipos inclusive) antes do pack.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');
const missing = [];
for (const [sub, targets] of Object.entries(pkg.exports)) {
  if (typeof targets === 'string') continue;
  for (const file of Object.values(targets)) if (!fs.existsSync(path.join(__dirname, '..', file))) missing.push(`${sub} -> ${file}`);
}
for (const [sub, [file]] of Object.entries(pkg.typesVersions['*'])) {
  if (!fs.existsSync(path.join(__dirname, '..', file))) missing.push(`typesVersions ${sub} -> ${file}`);
}
if (missing.length) {
  console.error('dist incompleto:\n  ' + missing.join('\n  '));
  process.exit(1);
}
console.log('dist ok:', Object.keys(pkg.exports).join(' '));
