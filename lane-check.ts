import { generateMatrix, type ClusterConfig } from './src/config.js';

const scenarios = generateMatrix();
const lanes = 8;

const byCluster = new Map<ClusterConfig, typeof scenarios>();
for (const s of scenarios) {
  const arr = byCluster.get(s.cluster) || [];
  arr.push(s);
  byCluster.set(s.cluster, arr);
}

const clusterEntries = [...byCluster.entries()];
const totalScenarios = clusterEntries.reduce((s, [, sc]) => s + sc.length, 0);

const clusterLaneCounts = new Map<ClusterConfig, number>();
let allocatedLanes = 0;
for (const [cluster, sc] of clusterEntries) {
  const share = Math.max(1, Math.floor((sc.length / totalScenarios) * lanes));
  clusterLaneCounts.set(cluster, share);
  allocatedLanes += share;
}
const sorted = clusterEntries.sort((a, b) => b[1].length - a[1].length);
let remainder = lanes - allocatedLanes;
for (const [cluster] of sorted) {
  if (remainder <= 0) break;
  clusterLaneCounts.set(cluster, clusterLaneCounts.get(cluster)! + 1);
  remainder--;
}

type ClusterGroup = { cluster: ClusterConfig; scenarios: typeof scenarios };
const laneAssignments: ClusterGroup[][] = [];
for (const [cluster, clusterScenarios] of clusterEntries) {
  const numLanes = clusterLaneCounts.get(cluster)!;
  const chunkSize = Math.ceil(clusterScenarios.length / numLanes);
  for (let l = 0; l < numLanes; l++) {
    const slice = clusterScenarios.slice(l * chunkSize, (l + 1) * chunkSize);
    if (slice.length > 0) {
      laneAssignments.push([{ cluster, scenarios: slice }]);
    }
  }
}

console.log(`Total: ${totalScenarios} scenarios\n`);
for (let i = 0; i < laneAssignments.length; i++) {
  for (const group of laneAssignments[i]) {
    console.log(`lane ${i}: ${group.cluster} — ${group.scenarios.length} scenarios`);
    console.log(`  first: ${group.scenarios[0].id}`);
    console.log(`  last:  ${group.scenarios[group.scenarios.length - 1].id}`);
  }
}
