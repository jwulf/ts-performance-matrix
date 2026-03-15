import { generateMatrix } from '../src/config.js';

const m = generateMatrix();
// Simulate distribution to 8 lanes (4 1broker, 4 3broker)
const lanes1b: string[][] = [[], [], [], []];
const lanes3b: string[][] = [[], [], [], []];
let i1 = 0, i3 = 0;
for (const s of m) {
  if (s.id.startsWith('1broker')) { lanes1b[i1 % 4].push(s.id); i1++; }
  else { lanes3b[i3 % 4].push(s.id); i3++; }
}
// Find first java-http in each lane
for (let l = 0; l < 4; l++) {
  const idx = lanes1b[l].findIndex(id => id.includes('java') && id.includes('http'));
  if (idx >= 0) console.log(`1broker lane ${l}: java http at position ${idx+1}/${lanes1b[l].length}: ${lanes1b[l][idx]}`);
}
for (let l = 0; l < 4; l++) {
  const idx = lanes3b[l].findIndex(id => id.includes('java') && id.includes('http'));
  if (idx >= 0) console.log(`3broker lane ${l}: java http at position ${idx+1}/${lanes3b[l].length}: ${lanes3b[l][idx]}`);
}
