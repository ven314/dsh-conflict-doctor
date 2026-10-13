/**
 * Shared vocabulary for the conflict-doctor audit. Everything here is plain JSON
 * data: collectors produce snapshots, detectors are pure functions over
 * snapshots, and the renderer is a pure function over findings. That split is
 * what makes the diagnosis testable without booting a harness.
 * @module dsh-conflict-doctor/types
 */
export {};
