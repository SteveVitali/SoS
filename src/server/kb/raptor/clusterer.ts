/**
 * K-means clustering for RAPTOR tree construction.
 * Clusters embedding vectors into semantically similar groups.
 */

import { createLogger } from "../../../shared/logger.js";

const log = createLogger("server:kb:raptor:clusterer");

export interface ClusterInput {
  id: string;
  vector: number[];
  content: string;
}

export interface Cluster {
  centroid: number[];
  members: ClusterInput[];
}

/**
 * Compute Euclidean distance between two vectors.
 */
function euclideanDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Compute the centroid (mean vector) of a set of vectors.
 */
function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= vectors.length;
  }
  return centroid;
}

/**
 * K-means clustering on embedding vectors.
 *
 * @param items - Items with embedding vectors to cluster
 * @param k - Number of clusters
 * @param maxIterations - Maximum iterations for convergence (default: 20)
 * @returns Array of clusters
 */
export function kMeansClusters(items: ClusterInput[], k: number, maxIterations = 20): Cluster[] {
  if (items.length === 0) return [];
  if (k <= 0) k = 1;
  if (k >= items.length) {
    // Each item is its own cluster
    return items.map((item) => ({
      centroid: [...item.vector],
      members: [item],
    }));
  }

  const _dim = items[0].vector.length;

  // Initialize centroids using k-means++ initialization
  const centroids: number[][] = [];
  // Pick first centroid randomly
  const firstIdx = Math.floor(Math.random() * items.length);
  centroids.push([...items[firstIdx].vector]);

  // Pick remaining centroids with probability proportional to distance
  for (let c = 1; c < k; c++) {
    const distances = items.map((item) => {
      let minDist = Infinity;
      for (const centroid of centroids) {
        const d = euclideanDistance(item.vector, centroid);
        if (d < minDist) minDist = d;
      }
      return minDist * minDist; // square for probability weighting
    });

    const totalDist = distances.reduce((sum, d) => sum + d, 0);
    if (totalDist === 0) {
      // All points identical, just pick sequentially
      centroids.push([...items[c % items.length].vector]);
      continue;
    }

    let target = Math.random() * totalDist;
    for (let i = 0; i < items.length; i++) {
      target -= distances[i];
      if (target <= 0) {
        centroids.push([...items[i].vector]);
        break;
      }
    }
    // Safety: if we didn't pick, add the last item
    if (centroids.length <= c) {
      centroids.push([...items[items.length - 1].vector]);
    }
  }

  // Iterative assignment and update
  let assignments = new Array(items.length).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each item to the nearest centroid
    const newAssignments = items.map((item) => {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclideanDistance(item.vector, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      return bestCluster;
    });

    // Check convergence
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      if (newAssignments[i] !== assignments[i]) {
        changed = true;
        break;
      }
    }
    assignments = newAssignments;

    if (!changed) {
      log.info("K-means converged", { iterations: iter + 1, k });
      break;
    }

    // Update centroids
    for (let c = 0; c < k; c++) {
      const memberVectors = items.filter((_, i) => assignments[i] === c).map((item) => item.vector);
      if (memberVectors.length > 0) {
        centroids[c] = computeCentroid(memberVectors);
      }
    }
  }

  // Build cluster objects
  const clusters: Cluster[] = [];
  for (let c = 0; c < k; c++) {
    const members = items.filter((_, i) => assignments[i] === c);
    if (members.length > 0) {
      clusters.push({
        centroid: centroids[c],
        members,
      });
    }
  }

  log.info("Clustering complete", {
    items: items.length,
    k,
    clusters_created: clusters.length,
    sizes: clusters.map((c) => c.members.length),
  });

  return clusters;
}
