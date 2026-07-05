// Bottom-up (leaf→callers) call graph builder — CPU branch only, the reversed twin of
// topDownGraph.ts. Ported from vscode-amiga-debug `client/table/bottomUpGraph.ts`, with a
// corrected time-accumulation model (the original propagated each ancestor node's full subtree
// aggregateTime up through the reversed chain, causing exponential double-counting and "Total
// time" values well above 100%).

import { Category, IProfileModel, IComputedNode, ILocation } from "../../shared/profilerTypes";
import { IGraphNode } from "./topDownGraph";

export class BottomUpNode implements IGraphNode {
  public static root(): BottomUpNode {
    return new BottomUpNode({
      id: -1,
      selfTime: 0,
      aggregateTime: 0,
      category: Category.System,
      callFrame: { functionName: "(root)", lineNumber: -1, columnNumber: -1, scriptId: "0", url: "" },
      address: 0,
    });
  }

  public children: { [id: number]: BottomUpNode } = {};
  public aggregateTime = 0;
  public selfTime = 0;
  public childrenSize = 0;
  public filtered = true;

  public get id() { return this.location.id; }
  public get callFrame() { return this.location.callFrame; }
  public get category() { return this.location.category; }
  public get address() { return this.location.address; }

  constructor(public readonly location: ILocation, public readonly parent?: BottomUpNode) {}
}

// Walk from a leaf node's parent up the call chain, distributing `leafSelfTime` as the
// contribution of this leaf to each ancestor's bottom-up context entry. `leafSelfTime` is kept
// constant throughout the recursion (NOT replaced with the ancestor's own selfTime/aggregateTime):
// every ancestor entry represents "how much leaf time flowed through this caller", so each level
// gets the same original leaf time, not a cumulative or subtree value.
const processNode = (aggregate: BottomUpNode, node: IComputedNode, leafSelfTime: number, model: IProfileModel): void => {
  let child = aggregate.children[node.locationId];
  if (!child) {
    child = new BottomUpNode(model.locations[node.locationId], aggregate);
    aggregate.childrenSize++;
    aggregate.children[node.locationId] = child;
  }
  child.selfTime += leafSelfTime;
  child.aggregateTime += leafSelfTime; // nested entries: aggregate = self (leaf time via this path)
  if (node.parent) {
    processNode(child, model.nodes[node.parent], leafSelfTime, model);
  }
};

// Build the reversed tree: every profiled leaf (a call-tree node with no children — the function
// actually executing when a sample landed) becomes a root-level entry keyed by its OWN location,
// with each caller up the parent chain becoming the next level down ("this function, called from
// X, called from Y, ..."). self time at every level accumulates the original leaf's self time —
// answering "what fraction of leaf F's time came via caller X" for each nested entry.
//
// Top-level aggregateTime is taken from model.locations (precomputed inclusive time from the
// call tree), so "Total time" for a top-level entry = that function's inclusive time across ALL
// invocations, correctly bounded by the frame duration.
export const createBottomUpGraph = (model: IProfileModel): BottomUpNode => {
  const root = BottomUpNode.root();

  for (const node of model.nodes) {
    // id 0 is the synthetic call-tree root (buildProfileModel) — never a real leaf.
    if (node.id !== 0 && node.children.length === 0) {
      let topEntry = root.children[node.locationId];
      if (!topEntry) {
        topEntry = new BottomUpNode(model.locations[node.locationId], root);
        root.childrenSize++;
        root.children[node.locationId] = topEntry;
      }
      topEntry.selfTime += node.selfTime;

      // Walk up the call chain to build the reversed caller context.
      // node.parent === 0 means "parented directly under the synthetic root" — stop there.
      if (node.parent) {
        processNode(topEntry, model.nodes[node.parent], node.selfTime, model);
      }
    }
  }

  // Top-level aggregateTime = inclusive time from the call-tree locations (correctly computed by
  // buildProfileModel as selfTime + subtree, summed across all call contexts for this function).
  // This gives a "Total time" that can be > self time (when the function calls others) but never
  // exceeds 100% of the frame for non-recursive programs.
  for (const topEntry of Object.values(root.children)) {
    const loc = model.locations[topEntry.location.id];
    topEntry.aggregateTime = loc ? loc.aggregateTime : topEntry.selfTime;
  }

  return root;
};
