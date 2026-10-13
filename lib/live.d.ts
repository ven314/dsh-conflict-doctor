/**
 * Live capability-graph collector: projects the RUNNING Cordis process into a
 * plain snapshot. Reads only public service lookups plus two documented Loader
 * and Fiber fields; every unreadable fact becomes a note instead of a throw, so
 * an audit never takes the harness down.
 * @module dsh-conflict-doctor/live
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LiveSnapshot } from './types.js';
/**
 * Project the running process.
 *
 * @param ctx - the live context (`ctx.tools` is the only hard requirement).
 * @returns the live snapshot, with a note for every fact that could not be read.
 */
export declare function collectLive(ctx: Context): LiveSnapshot;
/** Re-exported for detectors that need the same membership test. */
export declare function hasService(snapshot: LiveSnapshot, name: string): boolean;
