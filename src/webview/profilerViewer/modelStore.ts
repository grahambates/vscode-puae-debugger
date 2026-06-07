import { useSyncExternalStore } from "react";
import { IProfileModel } from "../../shared/profilerTypes";

// The profile model carries large typed arrays (DMA grid + RAM snapshot). It is kept HERE,
// outside React's props/state, on purpose: React's *development* build deep-serializes every
// component's props on each render for its performance/components track, and walking those
// arrays cost ~1s per capture. (The production build strips that instrumentation — esbuild sets
// NODE_ENV=production when minifying — so shipped extensions were always fine; this only bit the
// dev loop.) So the model is never a prop or hook value: useModelVersion() drives re-renders and
// components read getProfileModel() during render.
let model: IProfileModel | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function setProfileModel(next: IProfileModel | null): void {
  model = next;
  version++;
  for (const l of listeners) l();
}

// Read during render. Safe because setProfileModel updates `model` before bumping the version
// that triggers the re-render, so the value is consistent with this render pass.
export function getProfileModel(): IProfileModel | null {
  return model;
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const getVersion = (): number => version;

// Subscribe a component to model changes (returns the current version, which changes on each
// setProfileModel). The returned value is just a number, so nothing large is ever serialized.
export function useModelVersion(): number {
  return useSyncExternalStore(subscribe, getVersion);
}
