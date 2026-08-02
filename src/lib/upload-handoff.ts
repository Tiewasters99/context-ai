// One-shot file handoff between routes. The matter card opens the OS file
// picker *before* navigating (so upload is one click, not a Vault treasure
// hunt), then parks the picked File objects here for the Vault to collect on
// arrival. Router state can't carry Files (history.state is serialized), and
// a context provider would outlive its one real use — a module-level slot
// with take-once semantics is the whole requirement.
let pending: File[] | null = null;

export function setPendingUpload(files: File[] | FileList) {
  pending = Array.from(files);
}

/** Returns the parked files and clears the slot (one consumer, one delivery). */
export function takePendingUpload(): File[] | null {
  const files = pending;
  pending = null;
  return files;
}
