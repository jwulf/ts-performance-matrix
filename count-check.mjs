// Temporary script to verify matrix count after adding W100
const TOTAL_WORKERS = [10, 20, 50, 100];
const WORKERS_PER_PROCESS = [1, 2, 5, 10, 25, 50];
const SDK_MODES = ['rest', 'grpc-streaming', 'grpc-polling'];
const SDK_LANGUAGES = ['ts', 'python', 'csharp', 'java'];
const HANDLER_TYPES = ['cpu', 'http'];
const CLUSTERS = ['1broker', '3broker'];
const VALID_LANG_MODES = {
  ts: ['rest', 'grpc-polling'],
  python: ['rest'],
  csharp: ['rest'],
  java: ['rest', 'grpc-streaming', 'grpc-polling'],
};

let total = 0;
let w100 = 0;
let w100_1b = 0;
let w100_3b = 0;
const samples = [];

for (const cluster of CLUSTERS) {
  for (const W of TOTAL_WORKERS) {
    for (const WPP of WORKERS_PER_PROCESS) {
      if (WPP > W || W % WPP !== 0) continue;
      const P = W / WPP;
      for (const lang of SDK_LANGUAGES) {
        for (const mode of SDK_MODES) {
          if (!VALID_LANG_MODES[lang].includes(mode)) continue;
          for (const handler of HANDLER_TYPES) {
            total++;
            const id = `${cluster}-${lang}-W${W}-P${P}x${WPP}-${mode}-${handler}`;
            if (W === 100) {
              w100++;
              if (cluster === '1broker') w100_1b++;
              if (cluster === '3broker') w100_3b++;
              if (samples.length < 10) samples.push(id);
            }
          }
        }
      }
    }
  }
}

console.log('Total scenarios:', total);
console.log('W100 scenarios:', w100);
console.log('W100 1broker:', w100_1b);
console.log('W100 3broker:', w100_3b);
console.log('Sample W100 IDs:');
samples.forEach(s => console.log(' ', s));
