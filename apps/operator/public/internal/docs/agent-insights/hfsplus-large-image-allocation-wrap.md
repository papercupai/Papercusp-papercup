# HFS+ allocator can corrupt DMG catalogs above 4 GiB
URL: /internal/docs/agent-insights/hfsplus-large-image-allocation-wrap

A uint32 multiplication wraps the allocator's zero-fill offset. File round trips can pass despite metadata corruption; qualify the actual tool with a sparse boundary probe.

A copied Server DMG failed in hfsplus addall after successful app signing and updater creation (EI-25395743635811411). The producer discarded utility stdout/stderr, so the only initial observation was a generic addall failure. The retained image had 695850 free 4096-byte blocks and an all-zero catalog header; free space exhaustion was not supported by that measurement.

The actual planetbeing/libdmg-hfsplus allocator computes curBlock \* volumeHeader->blockSize from two uint32\_t operands before its zero-fill WRITE. At physical offsets above 4 GiB that product wraps. A controlled sparse 5 GiB image with forced allocation1072169 at block4096 wrote into the catalog area96636928 instead of4391604224. The normal file write and read use size\_t and can still round trip correctly, hiding metadata corruption.

Reuse the maintained tool at upstream7ac55ec64c96f7800d9818ce64c79670e7f02b67 with hfsplus-64bit-allocation.patch: widen curBlock to uint64\_t before multiplication. prepare-hfsplus-tool.sh verifies the pinned archive hash, applies the patch with zero fuzz, builds only the existing hfsplus target into an exact recipe cache, and qualifies the actual resulting binary. It preserves the shared installed utility.

The preflight uses a disposable sparse image and compares the invariant14-byte catalog node descriptor, then validates the boundary payload. Adding a record legitimately changes B-tree counters; comparing the whole catalog block would falsely reject a correct tool. The original installed binary fails this probe; repaired binary b9bc341ca87feee98d35ad8fe93a5758c86e540d821fd5a5db49366db93ea2c8 passes. make\_dmg runs qualification before copying the app or allocating the full image, saves phase logs for mkfs/addall/chmod/convert, and refuses executable-mode repair failures. The registered signing suite checks early refusal, phase evidence retention, and legitimate counter updates versus corruption.

This establishes the allocator defect and recurrence guard. A candidate's final DMG, signatures, identity/security/privacy, native runtime, boot, and physical GO still require their own evidence; tool qualification is not release acceptance. Preserve the original failed image and stage when diagnosing.
