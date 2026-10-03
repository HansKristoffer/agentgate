# Skill system review and refactor plan

Reviewed 2026-10-02 against the current working tree, including the new untracked skill files and their integration into the desktop app, daemon, CLI, store, setup, and peer sync. The initial review did not modify the implementation. The approved refactor has since been implemented; the original findings below remain as the rationale and regression checklist.

## Implementation status — 2026-10-02

All ten implementation areas are complete in this working tree:

| Area | Result |
| --- | --- |
| API boundaries | Guard precedes checkout/shim handlers; checkout registration uses bounded JSON, validated IDs, and canonical paths. |
| Replication | Byte-bounded change pages and resumable pulls transfer inventories above 16 MiB; continuation cursors are validated. |
| Bundle validation | Shared protocol schema protects local writes, previews, peer merges, and imports, including encoded/record limits, base64, path collisions, and required Markdown. |
| Filesystem recovery | Failed publication restores the old copy; reconciliation isolates failures, repairs damaged caches, recovers interrupted swaps, and reports local health. |
| Concurrent edits | Editor and asynchronous updates check stored revisions; source collisions fail before any installation writes. |
| Compatibility | Management API 2, peer protocol 4, backup format 3; older backup formats 1/2 remain importable when their records validate. Desktop validates status at runtime. |
| Import lifecycle | Pinned skills CLI 1.7.0, immutable preview tokens, bounded cache/import concurrency/output, cancellation of subprocess groups, and shutdown draining. Updates fetch fresh content through the same bounded importer. |
| Assignments | Shared desktop controls preserve every explicit assignment, including globally available, repository-owned, and unavailable skills. |
| Worktrees | Independent periodic repair, bounded retries, watcher recovery, explicit local mirroring opt-in, and awaitable `skills prepare`. Foreign and committed repository links are preserved. |
| Simplification | Import adapter and filesystem reconciliation extracted; normalized content digests and accurate decoded sizes; unchanged writes skipped; one project catalog per reconciliation pass. |

Validation performed:

- `bun test`: **114 passed, 0 failed**, including malformed ingestion, stale writes, preview expiry/cancellation, rollback/restart recovery, watcher failures, delayed worktrees, and inventories above 16 MiB.
- `bun run typecheck`, `bun run build:frontend`, and `bun run check:native`: **passed**.
- `bun run build`: **passed** for macOS arm64/x64 and Linux arm64/x64.
- `bun scripts/smoke.ts dist/agentgate-darwin-arm64`: **passed**, including compiled skill creation, assignment, and awaited checkout preparation with both `.agents` and `.claude` links.
- Live pinned CLI import from an isolated local source: **passed**, confirming the external JSON/path contract.
- Browser QA using a fixture-backed native bridge: project saves retain explicit assignments, editor saves carry the captured revision, installation submits only the preview token and selected IDs, and reconciliation errors are visible. A project input-pattern error found during QA was fixed.

Deployment and remaining live validation:

- Upgrade the desktop app and all paired daemons together because API/peer versions changed. Existing data is preserved; case-variant project duplicates are reported for deliberate cleanup rather than silently merged.
- Directory publication uses a recoverable rename sequence with a brief interval between renames; it does not promise an uninterrupted pathname swap.
- Native JSON backup restore is limited to 16 MiB. Larger backups use the documented file-based CLI restore; staged desktop restore was not added.
- Watchers provide eventual convergence. Use `skills prepare` before launching an agent when first-session readiness must be awaited. Existing agent discovery paths were retained.
- A real native app session, first-session discovery in actual Claude/Codex versions, and offline catch-up between two physical Tailscale nodes remain live integration checks. Browser fixtures, filesystem regressions, and local HTTP peer tests cover those boundaries without claiming to replace these checks.

The overall design is worth keeping: SQLite holds the complete skill bundle, peer sync distributes it, and each daemon materializes a local copy exposed through agent symlinks. Transactional installation and assignment, preservation of foreign skill folders, and keeping the skills.sh search adapter isolated are useful foundations.

The immediate work should fix correctness at the boundaries. Splitting files comes after those fixes, using the regression tests to preserve behavior.

## Review evidence

- `bun test`: **86 passed, 0 failed**, including five skill tests.
- `bun run typecheck`: **passed** across the workspace.
- Additional isolated checks used in-memory databases and temporary folders. They reproduced the browser-request guard bypass, update/delete and update/edit races, oversized peer responses, failed filesystem publication, malformed bundle acceptance, missed cache repair, case-variant project records, and inaccurate size reporting.
- Preview/cache behavior, desktop assignment loss, version compatibility, subprocess lifecycle, and watcher weaknesses below were established by source inspection. No live skills.sh fetch, native UI session, real agent discovery check, or physical-machine sync was performed.
- No usable codebase-memory index existed for this checkout; discovery used repository files and targeted text searches.

Priority: **P0** = address immediately; **P1** = address before relying on the feature across machines; **P2** = follow-up reliability or simplification work.

## 1. Put checkout registration behind the API guard — P0

**Finding:** [`daemon.ts`](../apps/agentgate/src/daemon.ts#L74) registers `/api/checkout` before the `/api/*` middleware. Its handler returns without reaching the browser-header guard. It also calls `c.req.json()` directly, accepting JSON sent as `text/plain`.

**Reproduction:** A loopback request carrying `Origin: https://example.com`, `Sec-Fetch-Site: cross-site`, and `Content-Type: text/plain` received **200** from `/api/checkout`; the same headers received **403** from `/api/projects/scan`. Checkout registration can remember a supplied repository/project mapping and trigger filesystem writes.

**Change:**

- Register the guard before every `/api/*` handler, including checkout and shim routes.
- Keep checkout registration loopback-only and use the same bounded JSON/content-type validation as management writes.
- Validate the supplied project identifier and canonicalize the checkout path before persisting it.

**Acceptance:** Browser-origin POSTs, form/plain-text bodies, invalid JSON, and tailnet requests cannot register a checkout or change files. The local MCP shim can still register a valid repository.

## 2. Bound sync pages by bytes — P1

**Finding:** [`Store.changes()`](../apps/agentgate/src/store.ts#L248) returns every record after the cursor. [`doPull()`](../apps/agentgate/src/sync.ts#L70) reads at most 16 MiB. Skill records make that limit easy to exceed, including on the first pull of a newly paired node.

**Reproduction:** Six skills, each within the current 3 MiB encoded-payload limit, produced a **18,876,223-byte** change-feed JSON body. Pull failed with `request exceeds 16 MiB`; the receiving cursor stayed at **0**, and an account record preceding the skills was also not transferred. Subsequent attempts encounter the same response.

**Change:**

- Add a byte-bounded page operation for the peer feed, preserving the existing read-snapshot invariant.
- Size the serialized response, including the escaped record data and envelope. Leave room for one maximum-size record and heartbeat metadata.
- Advance the acknowledged cursor only to the last included sequence. A snapshot high-water mark must not cause unseen records to be skipped.
- Drain additional pages with bounded work and cancellation, retaining transactional validation/merge for each page.
- Coordinate any changed feed contract with the sync protocol version.

**Acceptance:** Initial pairing and offline catch-up transfer inventories exceeding 16 MiB, including non-skill records. Tests cover multiple pages, concurrent writes between pages, rollback/invalid batches, and interruption followed by retry.

**Related limit:** Large skill inventories can also produce backups that `/api/backup` cannot restore because management bodies have the same 16 MiB limit. Define and document the supported API restore size, provide a clear error, and cover larger recovery through the existing file-based CLI. If the app must restore every export itself, add staged/chunked restore with a final transactional commit.

## 3. Validate complete bundles at the storage boundary — P1

**Finding:** [`schemas.skill`](../apps/agentgate/src/store.ts#L63) validates relative paths, but bundle size is checked only in [`putSkill()`](../apps/agentgate/src/skills.ts#L349). Sync merges and backup imports bypass that helper. The schema accepts missing `SKILL.md`, duplicate paths, a file and a descendant of that file, and invalid base64.

**Reproduction:** All those malformed shapes passed `parseData()`, as did an encoded payload larger than `MAX_SKILL`. A bundle containing both `scripts` and `scripts/run.sh` failed materialization and prevented a later healthy skill from being written.

**Change:**

- Define one reusable bundle validator used by local writes, fetched previews, peer merges, and backup imports.
- Require exactly one nonempty root `SKILL.md`; validate base64, unique paths, file/directory collisions, and reserved internal paths such as `.agentgate-rev`.
- Handle path collisions on supported case-insensitive filesystems explicitly. Reject bundles that cannot be represented faithfully there.
- Enforce per-file, file-count, aggregate encoded-payload, and complete serialized-record limits. Count JSON metadata toward the 4 MiB record limit.
- Check file size/count and traversal limits before reading whole files in `readSkill()`. Report unsupported symlinks instead of silently producing an incomplete bundle.
- Reject duplicate normalized IDs within one fetched pack before installing any member.
- Keep frontmatter parsing compatible with existing skills, but give the handwritten editor clear feedback for malformed YAML and mismatched names.

**Acceptance:** A malformed peer batch or backup fails before committing records. A malformed fetched pack fails before returning an installable preview. Boundary tests cover limits, path collisions, marker files, empty Markdown, and executable files.

## 4. Preserve working disk copies and isolate reconciliation errors — P1

**Finding:** [`SkillLinks.write()`](../apps/agentgate/src/skills.ts#L231) renames the current directory to `.old`, then publishes `.tmp`, but unconditionally removes both temporary paths in `finally`. If publication fails, the old copy is deleted. [`sync()`](../apps/agentgate/src/skills.ts#L214) catches one error around the entire pass, so one failing skill or checkout interrupts unrelated work and leaves only a console message.

**Reproduction:** Injecting a failure into the second rename left the skill directory absent and the store root empty. The database record remained available for a later repair, but the previous working disk copy was lost. Separately, deleting `SKILL.md` while leaving the revision marker made subsequent reconciliation skip repair indefinitely.

**Change:**

- Implement explicit prepare, publish, rollback, and cleanup steps. Preserve or restore `.old` when publication fails; recover interrupted swaps before removing leftovers on startup.
- Treat directory replacement as a two-step operation with a brief availability gap. If uninterrupted agent reads are required, follow up with immutable version directories and an atomically replaced symlink pointer.
- Restrict cleanup to recognized managed skill directories and temporary artifacts.
- Reconcile each skill and each checkout independently. Publish links only to successfully available bundles, and continue processing healthy entries after an error.
- Store node-local reconciliation errors, last attempt/success, and pending state. Expose them in status and the desktop Skills view so a committed record is distinguishable from a usable local skill.
- Check essential bundle completeness before trusting the marker. Define a bounded integrity check for other missing/changed files without re-decoding every bundle on every poll.

**Acceptance:** Failed publication retains the previous copy; restart recovers interrupted swaps. One unwritable checkout does not block another. A missing materialized file is repaired, and the app shows actionable failure status until reconciliation succeeds.

## 5. Protect asynchronous updates and editor saves from stale writes — P1

**Finding:** [`updateSkill()`](../apps/agentgate/src/skills.ts#L400) captures a record, waits for a fetch, then writes the captured record without checking whether it changed. The editor also submits without a revision precondition. The desktop action lock protects only that app instance, while CLI commands, peers, and other clients remain independent writers.

**Reproduction:** Starting an update, deleting the skill, then completing the fetch recreated the skill. Editing while the fetch was pending replaced the new local edit with downloaded content.

**Change:**

- Capture the record identity `(rev, node, updated_at)` before the fetch. Inside a short transaction, re-read it and commit only if it is unchanged and still live.
- Return a specific conflict response on a changed/deleted record; do not retry by overwriting newer work.
- Return a revision token with the editor payload and require it when saving an existing skill. Make creation reject an existing ID inside the operation itself, rather than relying on a desktop pre-check.
- Coalesce updates of the same skill within the process. Reuse existing lease support if cross-process download deduplication is needed; keep the revision check even with a lease.
- Preserve the original source selector so update need not retry a full-pack fetch after every kind of error. Use typed failures and retry only a supported selector fallback.

**Acceptance:** Tests cover update/delete, update/edit, edit/edit, delete-and-recreate under the same ID, and a peer merge during fetch. Conflicts retain the newer record and give the user a refresh/retry path.

## 6. Make API and upgrade compatibility explicit — P1

**Finding:** [`API_VERSION`](../packages/protocol/src/index.ts#L3) is still **1**, while `Status` now requires `skills`, `skillConflicts`, and `checkouts`. [`status()`](../apps/desktop/src/api.ts) checks only the version. A new app can accept an old daemon response and then access missing arrays. Sync was bumped to **3**, but [`docs/operations.md`](operations.md) still describes protocol 2.

**Change:**

- Bump the management API version for the new required response and any preview/revision contract changes in this plan.
- Validate the essential status response at runtime so an incompatible daemon produces an upgrade message before rendering views.
- Update upgrade and recovery documentation, including paired-node protocol requirements and backups containing skill records. Decide whether the backup format also needs a version bump so older clients fail clearly.
- Preserve the existing omission behavior for `PUT /projects`: a client omitting `skills` must not clear assignments.

**Acceptance:** New-app/old-daemon and old-app/new-daemon combinations fail with a clear version message. Skill backups round-trip on the supported version, and protocol mismatches retain records/cursors unchanged.

## 7. Bind installation to the exact preview and bound import work — P1

**Finding:** [`fetchCached()`](../apps/agentgate/src/api.ts#L289) caches by `${source}#${skill}` for ten minutes with a 16-entry limit. An expired/evicted preview is silently fetched again on installation; the reviewed audit/content can differ from what is installed. Entry count does not bound the bytes retained across large packs, and concurrent misses start duplicate subprocesses. The delimiter also permits ambiguous keys.

[`fetchSkills()`](../apps/agentgate/src/skills.ts#L69) runs floating `skills@1`, buffers stdout/stderr without limits, and allows 180 seconds. The native bridge times out after 120 seconds, and update can attempt two fetches. Request/daemon cancellation is not propagated to the importer; killing the runner alone may leave descendants or open pipes.

**Change:**

- Return an opaque preview token identifying an immutable fetched artifact, its source/selector, and audit metadata. Install selected IDs from that artifact.
- Expired/missing tokens require a fresh preview; never substitute newly fetched bytes during install.
- Bound retained bytes, pack size, TTL, and active imports. Deduplicate in-flight fetches with structured keys and release cache state on shutdown.
- Pin a tested exact skills CLI version behind a small adapter. Validate its JSON contract and report incompatible output clearly.
- Propagate request and daemon abort signals, cap output streams, and terminate/drain subprocess work with a bounded cleanup deadline on supported platforms.
- Initially use an overall operation deadline shorter than the bridge's 120 seconds, including fallback/cleanup. Add a job API only if real imports need to exceed that budget.
- Preview same-source updates separately from name collisions with another source or a handwritten skill. The current `installed` boolean labels both as “updates it,” although installation rejects the latter.

**Acceptance:** Tests with an injected importer cover token expiry/eviction, changed upstream content, cache limits, concurrent requests, malformed CLI output, oversized logs, hanging children, cancellation, and daemon shutdown. Routine tests do not depend on npm or skills.sh availability.

## 8. Preserve explicit assignments and share their interpretation — P1 for data loss; P2 for cleanup

**Finding:** [`Projects.tsx`](../apps/desktop/src/views/Projects.tsx#L44) hides skills already global or present in a local checkout, then submits only visible skill checkboxes as the complete project assignment. Saving an unrelated MCP change can drop an explicit skill assignment. Removing the global assignment later, or using a different machine/checkout, exposes the lost project choice.

[`assign()`](../apps/agentgate/src/skills.ts#L355) and `setSkillProjects()` use raw project IDs even though lookup elsewhere uses `canonicalProject()`. Assigning to `owner/repo` when `Owner/Repo` exists creates a second project record; this was reproduced.

**Change:**

- Preserve explicit stored assignments when saving a project. Derived “Every session” and “In repository” information must not silently rewrite them.
- Keep local repository availability/conflicts visible without using one checkout's contents to disable a synchronized assignment for all machines.
- Share one assignment picker and interpretation between Skills and Projects, showing explicit selection alongside derived availability.
- Canonicalize and deduplicate project IDs before comparing or mutating assignments. Share validation with `saveProject()` and checkout registration; surface existing case-variant duplicates for deliberate consolidation.
- Clarify that `*` skills are truly every-session skills, while `inheritDefaults` currently controls MCP defaults. Label that toggle accordingly.

**Acceptance:** Saving unrelated project settings preserves skill choices when a skill is global, repository-owned, or conflicting locally. Case variants resolve to one existing project. Tests include global removal, multiple checkouts, and different node-local repository contents.

## 9. Make worktree convergence independent and repo mirroring deliberate — P2

**Finding:** [`soon()`](../apps/agentgate/src/skills.ts#L207) runs only at 50 and 600 ms, while watchers cover `.git` and `.git/worktrees`, not recursively every registration file. This does not establish that a slow worktree is ready before its first session. The periodic repair is sequenced after credential/MCP maintenance, so those failures delay skill repair too. Watchers have no error handler, and partial setup can leave an already-created watcher unclosed.

[`mirror()`](../apps/agentgate/src/skills.ts#L285) automatically creates relative repository symlinks intended to appear as commit candidates. It recognizes existing mirrors by link shape, including links it did not create, and may remove dangling ones. That behavior is broader than projecting Agentgate-managed skills and deserves an explicit product choice.

**Change:**

- Give skill reconciliation an independent periodic task. Use bounded retries for incomplete worktree registrations, with events as a prompt for convergence.
- Manage watchers by path, close partial allocations on failure, handle emitted errors, and recreate watches after directory replacement.
- Describe first-session readiness accurately. Provide an explicit prepare/register operation that can be awaited before launch where integration permits it; a watcher cannot guarantee launch ordering.
- Retain tested Claude/Codex discovery behavior until it has been verified against the actual supported agent versions, including a worktree with its own empty skill folder.
- Recommended simplification: make repository mirroring a separate, explicit per-checkout operation/option. Track generated links if the daemon cleans them up; preserve repository-owned links. Keep creation of commit candidates visible to the user.

**Acceptance:** Delayed worktree registration, removal/recreation, watcher failure, and credential-maintenance failure converge correctly. Tests verify repeated passes leave foreign directories, links, and ignore files intact. Real agent checks establish which links are needed for the first session.

## 10. Normalize content metadata and remove redundant work — P2

**Finding:** [`skillSummaries()`](../apps/agentgate/src/skills.ts#L104) estimates decoded size from the length of the entire JSON record. A five-byte `SKILL.md` was reported as **78 bytes**. Preview/file sizes use base64 length times 0.75 without padding adjustment. Update compares ordered file-array JSON, so order changes can create false updates; editing retains a source hash that no longer describes the local content.

**Change:**

- Define encoded payload bytes and decoded file bytes separately. Make limit messages reflect that the current 3 MiB limit is encoded data, approximately 2.25 MiB of raw files.
- Compute decoded size from validated files and make it available without loading every bundle in status polling.
- Sort/normalize paths consistently and compute a content digest including executable bits. Distinguish current content identity from upstream provenance; editing must update content metadata.
- Skip writes for unchanged content/assignments so reinstalling the same skill does not create needless sync revisions.
- Build one compact catalog/assignment snapshot per reconciliation pass instead of repeatedly querying records and scanning all projects for each checkout. Keep the current lightweight status-summary approach.

**Acceptance:** Sizes match decoded bytes, reordered files do not trigger updates, executable-bit changes do, local edits have accurate metadata, and unchanged installs leave the sequence unchanged.

## Refactor shape and delivery order

Use small boundaries aligned with the actual failure modes:

| Responsibility | Proposed home | Purpose |
| --- | --- | --- |
| Bundle/request validation and DTOs | Existing protocol package plus store integration | One set of invariants for all ingestion paths |
| Install/edit/delete/assign/update operations | `apps/agentgate/src/skills.ts` | Short transactions, revision checks, reusable CLI/API operations |
| skills CLI/search adapter and fetched artifacts | `apps/agentgate/src/skill-import.ts` | External contracts, deadlines, cancellation, bounded resources |
| Materialization, links, worktrees, reconciliation health | `apps/agentgate/src/skill-links.ts` | Filesystem recovery and node-local behavior |
| HTTP validation and response/error mapping | Existing API module; extract `skill-api.ts` if useful after fixes | Thin handlers delegating to the same operations |
| Assignment controls | A shared desktop component/helper | Preserve explicit choices and explain local availability consistently |

Do not split solely to shorten files. Extract importer and filesystem code as their tests establish stable interfaces; retain the existing record-based storage and replica model. Ordinary replica conflicts still use the store's last-writer-wins behavior. The stale-write checks above protect asynchronous local operations without introducing a different distributed conflict model.

Suggested implementation batches:

1. **Boundary fixes:** checkout guard, bundle validation, failed-swap rollback, and stale-update protection, each with a focused regression test.
2. **Replication and compatibility:** byte-bounded sync pages, API/version checks, backup limits, and updated operations documentation.
3. **Installation correctness:** immutable previews, bounded/cancellable import adapter, exact CLI version, and meaningful conflict responses.
4. **App and convergence:** assignment preservation/canonicalization, reconciliation health display, independent repair scheduling, and watcher lifecycle.
5. **Simplification:** explicit repo-mirroring behavior, content/size metadata, no-op writes, and module extraction backed by the preceding tests.

For each batch, run relevant Bun tests and workspace type checking. Run the frontend build after protocol/UI changes, and native checks after bridge changes. Before declaring the complete flow ready, manually verify preview/install/edit/update/delete in the native app, first-session discovery in both agents, slow/new worktrees, and offline catch-up between two nodes with more than 16 MiB of records. These live checks complement the already-passing baseline; they were not part of this review.
