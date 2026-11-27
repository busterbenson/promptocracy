// Capability: an entry's owner (rule 703.4). Each catalog entry carries `requester`, the ref of the player whose commission made it (null for a starter entry). The host fills it from
// the ticket named by the entry's madeBy; it is never in the bundle or the public catalog, so no player id enters a game's repo.
// Storage: none (read from tickets). Adds: CatalogEntry.requester.
export default {
  name: "owner",
  sentence: "Every catalog entry knows its owner: entry.requester is the player (ref) whose commission made it, or null for a starter entry, so a rule can act for the owner of what a commission made (703.4).",
  storage: null,
  hooks: {},
  effects: {},
  /** @rule 703.4 */
  catalogEntry: (e) => ({ requester: e.requester ?? null }),
};
