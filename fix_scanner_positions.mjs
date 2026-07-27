import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

code = code.replace(
  'if (activeOpenCount < settings.max_concurrent_trades) {',
  'const maxPositions = settings.max_concurrent_positions || 3;\n        if (activeOpenCount < maxPositions) {'
);

code = code.replace(
  'Active: ${activeOpenCount}/${settings.max_concurrent_trades}',
  'Active: ${activeOpenCount}/${maxPositions}'
);

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Fixed max_concurrent_positions in scanner loop');
