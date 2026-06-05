// Top-down call graph builder — CPU branch only (DMA/Copper/Blitter deferred).
// Ported from vscode-amiga-debug `src/client/table/topDownGraph.ts`, stripped of
// the shrinkler orig* fields, the IAmigaProfileBase param, and all DMA logic.

import { Category, CallFrame, IProfileModel, IComputedNode, ILocation } from "../../shared/profilerTypes";

export interface IGraphNode {
  id: number;
  selfTime: number;
  aggregateTime: number;
  ticks: number;
  category: Category;
  callFrame: CallFrame;
  address: number;
  children: { [id: number]: IGraphNode };
  childrenSize: number;
  parent?: IGraphNode;
  filtered: boolean;
}

export class TopDownNode implements IGraphNode {
  public static root(): TopDownNode {
    return new TopDownNode({
      id: -1,
      category: Category.System,
      selfTime: 0,
      aggregateTime: 0,
      ticks: 0,
      callFrame: { functionName: "(root)", lineNumber: -1, columnNumber: -1, scriptId: "0", url: "" },
      address: 0,
    });
  }

  public children: { [id: number]: TopDownNode } = {};
  public aggregateTime = 0;
  public selfTime = 0;
  public ticks = 0;
  public childrenSize = 0;
  public filtered = true;

  public get id() { return this.location.id; }
  public get callFrame() { return this.location.callFrame; }
  public get category() { return this.location.category; }
  public get address() { return this.location.address; }

  constructor(public readonly location: ILocation, public readonly parent?: TopDownNode) {}

  public addNode(node: IComputedNode) {
    this.selfTime += node.selfTime;
    this.aggregateTime += node.aggregateTime;
  }
}

const processNode = (aggregate: TopDownNode, node: IComputedNode, model: IProfileModel): void => {
  let child = aggregate.children[node.locationId];
  if (!child) {
    child = new TopDownNode(model.locations[node.locationId], aggregate);
    aggregate.childrenSize++;
    aggregate.children[node.locationId] = child;
  }
  child.addNode(node);
  for (const ch of node.children) {
    processNode(child, model.nodes[ch], model);
  }
};

// Build a top-down call tree from the profile model. Since our model has no
// `amiga` DMA data, all nodes hang directly under root (no "CPU" wrapper node).
export const createTopDownGraph = (model: IProfileModel): TopDownNode => {
  const root = TopDownNode.root();
  if (model.nodes.length > 0) {
    for (const ch of model.nodes[0].children) {
      processNode(root, model.nodes[ch], model);
    }
  }
  return root;
};
