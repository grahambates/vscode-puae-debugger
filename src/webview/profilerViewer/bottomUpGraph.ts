// Bottom-up (leaf→callers) call graph builder — CPU branch only, the reversed twin of
// topDownGraph.ts. Ported from vscode-amiga-debug `client/table/bottomUpGraph.ts`.

import { Category, IProfileModel, IComputedNode, ILocation } from "../../shared/profilerTypes";
import { IGraphNode } from "./topDownGraph";

export class BottomUpNode implements IGraphNode {
  public static root(): BottomUpNode {
    return new BottomUpNode({
      id: -1,
      selfTime: 0,
      aggregateTime: 0,
      ticks: 0,
      category: Category.System,
      callFrame: { functionName: "(root)", lineNumber: -1, columnNumber: -1, scriptId: "0", url: "" },
      address: 0,
    });
  }

  public children: { [id: number]: BottomUpNode } = {};
  public aggregateTime = 0;
  public selfTime = 0;
  public ticks = 0;
  public childrenSize = 0;
  public filtered = true;

  public get id() { return this.location.id; }
  public get callFrame() { return this.location.callFrame; }
  public get category() { return this.location.category; }
  public get address() { return this.location.address; }

  constructor(public readonly location: ILocation, public readonly parent?: BottomUpNode) {}

  public addNode(node: IComputedNode): void {
    this.selfTime += node.selfTime;
    this.aggregateTime += node.aggregateTime;
    this.parent?.addNode(node);
  }
}

const processNode = (aggregate: BottomUpNode, node: IComputedNode, model: IProfileModel): void => {
  let child = aggregate.children[node.locationId];
  if (!child) {
    child = new BottomUpNode(model.locations[node.locationId], aggregate);
    aggregate.childrenSize++;
    aggregate.children[node.locationId] = child;
  }
  child.addNode(node);
  // node.parent === 0 means "parented directly under the synthetic call-tree root" (nodes[0],
  // buildProfileModel) — not a real caller frame, so the upward walk stops there, same as
  // topDownGraph.ts starting from nodes[0].children rather than nodes[0] itself.
  if (node.parent) {
    processNode(child, model.nodes[node.parent], model);
  }
};

// Build the reversed tree: every profiled leaf (a call-tree node with no children — the function
// actually executing when a sample landed) becomes a root-level entry keyed by its OWN location,
// with each caller up the parent chain becoming the next level down ("this function, called from
// X, called from Y, ..."). self/aggregate time at every level accumulate from every leaf
// occurrence that passes through that exact reversed path — answering "what does Foo's time
// actually come from" rather than top-down's "what does main() spend time in".
export const createBottomUpGraph = (model: IProfileModel): BottomUpNode => {
  const root = BottomUpNode.root();
  for (const node of model.nodes) {
    // id 0 is the synthetic call-tree root (buildProfileModel) — never a real leaf, even though
    // it satisfies children.length===0 for an empty/no-samples capture.
    if (node.id !== 0 && node.children.length === 0) {
      processNode(root, node, model);
    }
  }
  return root;
};
