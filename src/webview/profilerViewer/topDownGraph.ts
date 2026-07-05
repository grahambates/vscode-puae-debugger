// Top-down call graph builder — CPU branch only (DMA/Copper/Blitter deferred).
// Ported from vscode-amiga-debug `src/client/table/topDownGraph.ts`, stripped of
// the shrinkler orig* fields, the IAmigaProfileBase param, and all DMA logic.

import { Category, CallFrame, IProfileModel, IComputedNode, ILocation } from "../../shared/profilerTypes";
import { channelStyle } from "./dma";

export interface IGraphNode {
  id: number;
  selfTime: number;
  aggregateTime: number;
  category: Category;
  callFrame: CallFrame;
  address: number;
  children: { [id: number]: IGraphNode };
  childrenSize: number;
  parent?: IGraphNode;
  filtered: boolean;
  dmaColor?: string; // set on synthetic DMA-channel rows → renders a color dot
}

export class TopDownNode implements IGraphNode {
  public static root(): TopDownNode {
    return new TopDownNode({
      id: -1,
      category: Category.System,
      selfTime: 0,
      aggregateTime: 0,
      callFrame: { functionName: "(root)", lineNumber: -1, columnNumber: -1, scriptId: "0", url: "" },
      address: 0,
    });
  }

  public children: { [id: number]: TopDownNode } = {};
  public aggregateTime = 0;
  public selfTime = 0;
  public childrenSize = 0;
  public filtered = true;
  public dmaColor?: string; // set on synthetic DMA leaf rows → renders a color dot

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

// DMA channel grouping, mirroring the old vscode-amiga-debug time view: a "DMA" root
// holds one node per bus-type; types with multiple sub-channels (CPU Code/Data, Copper
// MOVE/WAIT/SKIP, Bitplane planes, Sprites, Audio channels) become an expandable parent,
// while single-channel types (Blitter, Disk, Refresh) are leaves directly under "DMA".
// `key` matches channelStyle().key; `label` is the (short) leaf name under its parent.
const DMA_GROUPS: { type: string; single?: boolean; members: [string, string][] }[] = [
  { type: "CPU", members: [["cpu-code", "Code"], ["cpu-data", "Data"]] },
  { type: "Copper", members: [["cop-move", "Copper"], ["cop-wait", "Wait"], ["cop-skip", "Skip"]] },
  { type: "Blitter", single: true, members: [["blitter", "Blitter"]] },
  { type: "Bitplane", members: [["bpl1", "Plane 1"], ["bpl2", "Plane 2"], ["bpl3", "Plane 3"], ["bpl4", "Plane 4"], ["bpl5", "Plane 5"], ["bpl6", "Plane 6"]] },
  { type: "Sprite", members: [["spr0", "Sprite 0"], ["spr1", "Sprite 1"], ["spr2", "Sprite 2"], ["spr3", "Sprite 3"], ["spr4", "Sprite 4"], ["spr5", "Sprite 5"], ["spr6", "Sprite 6"], ["spr7", "Sprite 7"]] },
  { type: "Audio", members: [["aud0", "Channel 0"], ["aud1", "Channel 1"], ["aud2", "Channel 2"], ["aud3", "Channel 3"]] },
  { type: "Disk", single: true, members: [["disk", "Disk"]] },
  { type: "Refresh", single: true, members: [["refresh", "Refresh"]] },
];

// Build the profile tree. With DMA present, the root has two group nodes — "CPU" (the
// function call tree) and "DMA" (per-type bus totals); without DMA, the CPU functions
// hang directly under root (unchanged).
export const createTopDownGraph = (model: IProfileModel): TopDownNode => {
  // Allocator for synthetic group/leaf locations (negative ids never collide with
  // real location ids (≥0) or the root (-1)).
  let synthId = -1000;
  const makeNode = (name: string, parent: TopDownNode, color?: string): TopDownNode => {
    const loc: ILocation = {
      id: synthId--,
      selfTime: 0,
      aggregateTime: 0,
      category: Category.System,
      callFrame: { functionName: name, url: "", scriptId: "#dma", lineNumber: -1, columnNumber: 0 },
      address: 0,
    };
    const n = new TopDownNode(loc, parent);
    if (color) n.dmaColor = color;
    parent.children[loc.id] = n;
    parent.childrenSize++;
    return n;
  };

  const root = TopDownNode.root();

  // CPU side: process the function call tree under a "CPU" wrapper (or the root itself
  // when there's no DMA to group against).
  const cpuRoot = model.dma ? makeNode("CPU", root) : root;
  if (model.nodes.length > 0) {
    for (const ch of model.nodes[0].children) {
      const node = model.nodes[ch];
      processNode(cpuRoot, node, model);
      cpuRoot.selfTime += node.aggregateTime;
      cpuRoot.aggregateTime += node.aggregateTime;
    }
  }

  if (!model.dma) return root;

  // DMA side: tally slots per channel key, then build the grouped tree.
  const dma = model.dma;
  const N = dma.owner.length;
  const byKey = new Map<string, { color: string; slots: number }>();
  for (let i = 0; i < N; i++) {
    const st = channelStyle(dma.owner[i], dma.flags[i]);
    if (!st) continue;
    let e = byKey.get(st.key);
    if (!e) { e = { color: st.color, slots: 0 }; byKey.set(st.key, e); }
    e.slots++;
  }
  if (byKey.size === 0) return root;

  const perSlot = N > 0 ? (model.duration || 0) / N : 0;
  const dmaRoot = makeNode("DMA", root);

  for (const group of DMA_GROUPS) {
    const present = group.members.filter(([key]) => (byKey.get(key)?.slots ?? 0) > 0);
    if (present.length === 0) continue;

    // Single-channel types are a leaf directly under "DMA"; multi-channel types get an
    // expandable parent named by the type.
    const parent = group.single ? dmaRoot : makeNode(group.type, dmaRoot);
    for (const [key, label] of present) {
      const e = byKey.get(key)!;
      const time = e.slots * perSlot;
      const leaf = makeNode(label, parent, e.color);
      leaf.selfTime = time;
      leaf.aggregateTime = time;
      if (parent !== dmaRoot) parent.aggregateTime += time;
      dmaRoot.aggregateTime += time;
    }
  }

  return root;
};
