import fs from 'fs';

let code = fs.readFileSync('server.ts', 'utf8');

// Lower the confidence threshold or adjust logic
code = code.replace(
  'const minThreshold = 0.70;',
  'const minThreshold = 0.60;'
);

// If filters are disabled, we don't penalize. The code already does:
// const sessionConfirmed = !settings.session_filter_enabled || (currentUtcHour >= 0 && currentUtcHour <= 21);
// Which means if settings.session_filter_enabled is false, sessionConfirmed is true.
// And filterPenalty is only added if !sessionConfirmed.
// So filterPenalty is 0 when filters are disabled.
// But we still need base confidence to be higher so it passes 0.60 easily.

code = code.replace(
  'let biasScore = settings.htf_bias_enabled ? 0.12 : 0.05;',
  'let biasScore = settings.htf_bias_enabled ? 0.12 : 0.12;'
);

code = code.replace(
  'let displacementScore = settings.displacement_filter_enabled ? 0.12 : 0.04;',
  'let displacementScore = settings.displacement_filter_enabled ? 0.12 : 0.12;'
);

fs.writeFileSync('server.ts', code, 'utf8');
console.log('Fixed filters logic');
