# Upload CPU profiling

This captures the two useful views of a large upload:

- a macOS CPU sample of the local Convex backend;
- a Chrome DevTools Performance trace of the browser.

No extra profiling packages are required.

## Record an upload

1. Start the full development environment:

   ```sh
   pnpm dev
   ```

2. Open the gallery in Chrome, open **Developer Tools**, and select the
   **Performance** panel. Leave CPU and network throttling disabled.

3. In a second terminal, run:

   ```sh
   pnpm profile:upload
   ```

   The default capture is 60 seconds. For a longer capture, pass the number of
   seconds, for example `pnpm profile:upload -- 120`.

4. During the five-second countdown, switch to Chrome, click **Record**, and
   upload the same representative set of 500 files.

5. When the command finishes, stop the Chrome recording. Use **Save profile**
   in the Performance panel and save it under `.profiles/`.

The backend sample is written to `.profiles/convex-upload-<timestamp>.txt`.
The `.profiles/` directory is ignored by Git.

## What to share

Share these two files together:

- the Convex `.txt` sample;
- the Chrome Performance `.json` or `.json.gz` trace.

Also note roughly when the upload began and ended if the trace contains idle
time. These files are enough to identify the hottest backend stacks, browser
main-thread work, excessive rendering, and request timing.
