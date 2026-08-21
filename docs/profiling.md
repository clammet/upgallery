# Upload CPU profiling

This captures the useful views of a large upload without asking Chrome to
load the completed trace:

- macOS CPU samples of the local backend processes (Convex, the storage API,
  the storage worker);
- a Chrome performance trace of the browser;
- a text summary of that trace.

No extra profiling packages are required.

## Record an upload

1. Start the full development environment:

   ```sh
   pnpm dev
   ```

2. In a second terminal, launch a dedicated Chrome profiling window:

   ```sh
   pnpm profile:chrome -- 60
   ```

   Chrome records for 60 seconds and saves the trace directly under
   `.profiles/`. Do not open the DevTools Performance panel.

   Chrome keeps the start of the recording and stops adding events when its
   buffer fills, so a capture that is too long loses its tail, not its head.
   A busy upload fills the buffer in roughly a minute; if the summary reports
   a shorter span than you asked for, record a shorter session rather than a
   longer one.

3. In a third terminal, start the matching backend CPU samples:

   ```sh
   pnpm profile:upload
   ```

   The default capture is 60 seconds. For a longer capture, pass the number of
   seconds, for example `pnpm profile:upload -- 120`. The script samples the
   Convex backend and, when it can find them, the storage API and storage
   worker processes; those two are where the upload's server-side CPU goes
   (hashing, location-data stripping, thumbnails, previews, metadata).

4. During the five-second countdown, switch to the dedicated Chrome window and
   upload the same representative set of files.

5. Wait for both commands to report that their files were saved. Chrome remains
   open, but no trace is loaded or parsed in the UI.

The backend samples are written to `.profiles/<process>-upload-<timestamp>.txt`.
The browser trace is written to `.profiles/chrome-upload-<timestamp>.json`.
The `.profiles/` directory is ignored by Git.

The profiling Chrome window uses `.profiles/chrome-profile/` so it cannot
interfere with the normal Chrome profile. The first run may require signing in.
If so, sign in, let that capture finish, close the profiling Chrome window, and
run the command again for the real capture. Close the profiling window before
each later recording so Chrome starts a fresh tracing process.

## Summarise the trace

```sh
pnpm profile:analyze -- .profiles/chrome-upload-<timestamp>.json
```

The script streams the trace (hundreds of megabytes is fine) and prints:

- the busiest trace events on the renderer main thread;
- which JavaScript callbacks the main thread spent its time in;
- a per-second timeline of busy time, script time, layout/paint time, GC,
  compositor layer updates and completed upload requests;
- how many times each React component rendered (development builds only;
  React's performance track emits one user-timing measure per render);
- request counts by URL;
- the hottest functions in the embedded CPU profile, with a warning when the
  profile's call tree was truncated.

A main thread busy for close to 1000ms in every second is saturated; upload
callbacks then queue behind render work and throughput drops.

## What to share

Share these files together:

- the backend `.txt` samples;
- the Chrome `.json` trace (or the `profile:analyze` output, which is small).

Also note roughly when the upload began and ended if the trace contains idle
time.
