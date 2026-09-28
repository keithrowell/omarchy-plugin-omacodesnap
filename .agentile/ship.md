---
# No human_checkpoint: ship runs unattended once verify passes (see loop.md).
---

# Ship — how work reaches trunk

1. Fast-forward or squash-merge `spec/<slug>` into `master` from the main
   checkout (not from the builder's worktree). Message: `<slug>: <spec title>`.
2. Run the deploy gate, `bin/install`, so the installed plugin symlink picks up
   the change immediately (it is a symlink into `~/.config/omarchy/plugins/`,
   so this is cheap and reversible).
3. Delete the branch and remove the worktree.
4. Trunk must launch after every ship. If `bin/omacodesnap` no longer starts,
   revert the merge on `master` and halt the loop with the reason.
