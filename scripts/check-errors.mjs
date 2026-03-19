import fs from 'fs';
const d = JSON.parse(fs.readFileSync('/tmp/analysis-cache/run-1773706367477.json', 'utf8'));
const http = d.filter(s => s.handlerType === 'http');
console.log('total scenarios:', d.length);
console.log('http scenarios:', http.length);
const withErr = http.filter(s => s.processResults?.some(p => p.errorTypes && Object.keys(p.errorTypes).length > 0));
console.log('with errorTypes on processResults:', withErr.length);
if (withErr.length > 0) {
  console.log('sample errorTypes:', JSON.stringify(withErr[0].processResults[0].errorTypes));
}
