import { describe, expect, it } from "vitest";
import { type ClusterInput, kMeansClusters } from "./clusterer.js";

function makeItem(id: string, vector: number[]): ClusterInput {
  return { id, vector, content: `Content for ${id}` };
}

describe("kMeansClusters", () => {
  it("returns empty array for empty input", () => {
    expect(kMeansClusters([], 3)).toEqual([]);
  });

  it("returns one cluster per item when k >= items.length", () => {
    const items = [makeItem("a", [1, 0]), makeItem("b", [0, 1])];
    const clusters = kMeansClusters(items, 5);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });

  it("clusters similar vectors together", () => {
    // Two clear clusters: near [1,0] and near [0,1]
    const items = [
      makeItem("a1", [1.0, 0.0]),
      makeItem("a2", [0.9, 0.1]),
      makeItem("a3", [0.8, 0.2]),
      makeItem("b1", [0.0, 1.0]),
      makeItem("b2", [0.1, 0.9]),
      makeItem("b3", [0.2, 0.8]),
    ];

    const clusters = kMeansClusters(items, 2);
    expect(clusters).toHaveLength(2);

    // Each cluster should have 3 members
    const sizes = clusters.map((c) => c.members.length).sort();
    expect(sizes).toEqual([3, 3]);

    // Items starting with 'a' should be in the same cluster
    const aCluster = clusters.find((c) => c.members.some((m) => m.id === "a1"));
    expect(aCluster).toBeDefined();
    expect(aCluster?.members.map((m) => m.id).sort()).toEqual(["a1", "a2", "a3"]);
  });

  it("handles k=1 (single cluster)", () => {
    const items = [makeItem("a", [1, 0]), makeItem("b", [0, 1])];
    const clusters = kMeansClusters(items, 1);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
  });

  it("all items are assigned to exactly one cluster", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem(`item-${i}`, [Math.random(), Math.random(), Math.random()]),
    );
    const clusters = kMeansClusters(items, 4);
    const allIds = clusters.flatMap((c) => c.members.map((m) => m.id)).sort();
    const expectedIds = items.map((i) => i.id).sort();
    expect(allIds).toEqual(expectedIds);
  });

  it("each cluster has a centroid", () => {
    const items = [makeItem("a", [1, 0, 0]), makeItem("b", [0, 1, 0]), makeItem("c", [0, 0, 1])];
    const clusters = kMeansClusters(items, 3);
    for (const cluster of clusters) {
      expect(cluster.centroid).toHaveLength(3);
      expect(cluster.centroid.every((v) => typeof v === "number")).toBe(true);
    }
  });
});
