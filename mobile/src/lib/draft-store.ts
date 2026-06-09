// In-memory per-session message drafts: survive navigating away and back
// within a session. Full on-device persistence arrives with the offline slice.
const drafts = new Map<string, string>();

export const draftStore = {
  get: (key: string) => drafts.get(key) ?? '',
  set: (key: string, value: string) => {
    if (value) drafts.set(key, value);
    else drafts.delete(key);
  },
};
