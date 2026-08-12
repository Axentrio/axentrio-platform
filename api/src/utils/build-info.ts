/**
 * Which commit this process is actually running.
 *
 * ## Why this exists
 *
 * Railway builds asynchronously and lags the GitHub Actions run that triggered it, so a green CI
 * badge is not a statement about what is serving traffic. On 2026-08-12 two rounds of live testing
 * were spent against a build that predated the fix under test - each round costing a full test
 * cycle, and neither detectable from outside the box. Nothing in the system could answer "which
 * commit is this".
 *
 * ## Why a FILE and not an environment variable
 *
 * The obvious version stamps `GIT_COMMIT_SHA` onto the Railway service just before deploying. It
 * is wrong, and wrong in the one case the marker exists for.
 *
 * A service variable is read when a CONTAINER starts, not when an image is built. So if the stamp
 * lands and the build then fails - which `railway up --detach` reports as success - the old
 * container keeps running and keeps its old value, which is fine. But the next restart of that
 * SAME old image, for any reason at all, starts with the NEW variable. The service then reports a
 * commit it is not running, with total confidence, in exactly the stale-build scenario this was
 * built to detect. A marker that is silent when it does not know is useful; a marker that lies is
 * worse than nothing, because it ends the investigation.
 *
 * Written into the image instead, the sha is physically part of the build. It cannot drift from
 * the code beside it, because it IS beside it.
 *
 * ## Why it fails soft
 *
 * The file is written by the deploy, so it is legitimately absent in local development, in tests,
 * and in any container built by hand. `unknown` is the honest answer there. A health endpoint that
 * can fail over its own provenance is a health endpoint that reports the platform down when the
 * only thing wrong is that nobody told it its own name.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read once, at module load.
 *
 * The value cannot change while the process lives - a different commit is a different container -
 * so re-reading per request would buy nothing and put a synchronous file read on the path Railway
 * probes every 30 seconds.
 */
function readCommit(): string {
  try {
    // `api/public` is copied into the runtime image (`Dockerfile:63`) and is where `widget.js`
    // already lives, so this needs no change to the build.
    const raw = readFileSync(join(__dirname, '../../public/commit.txt'), 'utf8').trim();
    // A 40-character hex sha or nothing. Anything else means the file was written by something
    // other than the deploy, and echoing it back would dress up a guess as provenance.
    return /^[0-9a-f]{7,40}$/.test(raw) ? raw : 'unknown';
  } catch {
    return 'unknown';
  }
}

export const BUILD_COMMIT = readCommit();
