# Papercusp architecture and design presentation

Open [index.html](index.html) in a desktop browser to present the three-pass architecture talk. The proposed 30 minute session includes 28 minutes 20 seconds of speaking allocations and 1 minute 40 seconds for questions; the appendix supports longer discussion. [deck.pdf](deck.pdf) is the static fallback and [presenter-notes.md](presenter-notes.md) contains the complete script, timing and setup instructions.

The presentation follows the existing architecture and Cupboard maps: first the whole system and design reasons, then independent concept contracts, then a work-item trace and a reusable-policy trace. It describes a development-source snapshot from 21 October 2026. The pages’ released and coming-soon distinctions are retained.

## Presenting

- Use **← / →**, **Page Up / Page Down** or **Space** to navigate.
- **N** toggles speaker notes on the current screen. These are visible to the audience if you share that screen; use the separate notes document for private notes.
- **O** opens an overview with links to every slide. **Home** returns to the start; **End** returns to the core closing slide.
- **M** opens the local architecture map. The toolbar opens either architecture or Cupboard. Click a block, Ctrl+scroll or use the map controls to zoom. Close the dialog to resume; focus the deck before using slide shortcuts.
- The map snapshots retain the existing public-site interaction engine and disable narration. The core deck uses fixed map views so it remains readable without a live-page tour.
- Full screen is optional. Use the PDF if the browser or projector is unsuitable. Network access and a running operator are unnecessary for the core talk.

## Optional live discussion

Keep the operator and two or three current source contracts ready for questions. Use prepared read-only records: one work item with a checkpoint and one completed item with evidence. The illustrated traces in the deck are explanatory scenarios, not a recording of that live workspace. Never start a new fleet, publish a package or make a destructive call merely to complete the talk.

## Editing and rebuilding

[slides.json](slides.json) is the editable content source. It contains titles, concept cards, speaker notes, proposed timing and source keys. [build.mjs](build.mjs) generates the deck and notes. It reuses the existing site maps; it does not introduce another application or map engine.

From the canonical repository root, with this directory’s file locks held:

```bash
node docs/presentations/papercusp-architecture-2026-10-21/build.mjs
node docs/presentations/papercusp-architecture-2026-10-21/verify.mjs
```

The build uses the installed Playwright package. Map refreshes read the existing public-site checkout under `~/.papercusp-workspaces/clones/papercusp-public-site`. Set `PAPERCUSP_PRESENTATION_SITE_SOURCE` to another checkout to refresh from it. Without that checkout, the checked-in local SVG and HTML map snapshots are retained and the editorial deck still rebuilds. Verification generates the PDF, screenshots and browser evidence.

## References and verification

- [Architecture page](https://papercusp.com/architecture/)
- [Cupboard page](https://papercusp.com/cupboard/)
- Existing repository runbooks: `papercusp-30-minute-demo-script-and-faq.md` and `papercusp-runtime-demo-example-files.md`
- [manifest.json](manifest.json): content inventory, snapshot provenance and proposed timing
- [verification.json](verification.json): actual browser checks and their limits

The PDF and automated browser walkthrough establish rendering and navigation for the checked environments. Spoken timings remain proposed until a human rehearses. The presentation does not certify the availability, performance or correctness of every subsystem shown on the source pages.
