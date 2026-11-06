// Marks an ESM output directory as `"type": "module"` so Node and bundlers treat it as ESM.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), process.argv[2] ?? 'dist/esm');
mkdirSync(dir, { recursive: true });
writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n');

