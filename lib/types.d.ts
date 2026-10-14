/**
 * Shared vocabulary for the conflict-doctor audit. Everything here is plain JSON
 * data: collectors produce snapshots, detectors are pure functions over
 * snapshots, and the renderer is a pure function over findings. That split is
 * what makes the diagnosis testable without booting a harness.
 * @module dsh-conflict-doctor/types
 */
/** How badly a finding hurts. */
export type Severity = 'critical' | 'warning' | 'info';
/** One concrete repair step the user can apply as-is. */
export interface Fix {
    /** `patch` = paste into cordis.patch.yml; `command` = run in the profile; `manual` = a decision only the user can make. */
    readonly kind: 'patch' | 'command' | 'manual';
    /** One-line summary of the repair. */
    readonly label: string;
    /** Why this repair resolves the finding. */
    readonly detail: string;
    /** Ready-to-paste patch fragment (for `kind: 'patch'`). */
    readonly snippet?: string;
}
/** One diagnosed conflict, with evidence and at least one repair. */
export interface Finding {
    /** Stable machine code, e.g. `live/pending-missing-service`. */
    readonly code: string;
    readonly severity: Severity;
    readonly title: string;
    /** Entry ids, row ids, packages, or tool names the finding is about. */
    readonly refs: readonly string[];
    /** What actually breaks, in user terms. */
    readonly impact: string;
    /** The facts that prove the finding — never a guess. */
    readonly evidence: readonly string[];
    readonly fixes: readonly Fix[];
}
/** Counts and coverage for one audit run. */
export interface AuditSummary {
    readonly critical: number;
    readonly warning: number;
    readonly info: number;
    /** Loader rows examined in the live tree (0 for a profile-only audit). */
    readonly liveEntries: number;
    /** Patch layers examined (0 for a live-only audit). */
    readonly patchLayers: number;
    /** Installed packages whose sources were scanned for declared tool ids. */
    readonly scannedPackages: number;
    /** Distinct tool ids discovered in those sources. */
    readonly declaredTools: number;
}
/** The complete result of one audit. */
export interface AuditReport {
    /**
     * Version of the JSON contract this report conforms to.
     *
     * Present so a consumer can DETECT a breaking change instead of misreading
     * one: `schema/audit-report.schema.json` is the authoritative shape, and this
     * number bumps only when an existing field changes meaning. New fields are
     * additive and do not bump it.
     */
    readonly schemaVersion: number;
    readonly generatedAt: string;
    /** Profile directory the audit read, or `(running profile)`. */
    readonly profilePath: string;
    readonly scope: AuditScope;
    readonly summary: AuditSummary;
    readonly findings: readonly Finding[];
    /** Non-fatal coverage gaps (missing files, unreadable packages). */
    readonly notes: readonly string[];
    /** Whether the version baseline describes the running host. */
    readonly versionAuthority?: VersionAuthority;
}
/** Which halves of the audit to run. */
export type AuditScope = 'live' | 'profile' | 'all';
/** Fiber lifecycle labels, mirroring the Cordis `FiberState` const enum. */
export type FiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null;
/** One Loader entry as observed in the running process. */
export interface LiveEntry {
    readonly entryId: string;
    readonly moduleName: string;
    readonly enabled: boolean;
    readonly group: boolean;
    readonly fiberPhase: FiberPhase;
    /** Plugin display name reported by Cordis, when the fiber has a runtime. */
    readonly pluginName?: string;
    /** Service names this entry's fiber declares in `inject`. */
    readonly inject: readonly string[];
    /**
     * Declared injects that currently resolve to no service. A settled fiber
     * waiting on exactly these stays PENDING and logs nothing — the silent
     * failure mode this tool exists to name.
     */
    readonly missingInject: readonly string[];
    /** Service names this entry's fiber subtree provides. */
    readonly provides: readonly string[];
    /** Startup error text, when the fiber failed. */
    readonly errorText?: string;
}
/** One live service and the entry that provides it. */
export interface LiveService {
    readonly service: string;
    readonly owner: string;
    readonly entryId?: string;
}
/** One service name declared by a plugin's loaded code (structural, from `provide` metadata). */
export interface LiveProvided {
    readonly service: string;
    readonly entryId: string;
    readonly moduleName: string;
}
/** The running process, projected for analysis. */
export interface LiveSnapshot {
    readonly entries: readonly LiveEntry[];
    readonly services: readonly LiveService[];
    /**
     * Services the loaded plugin modules declare they provide, independent of
     * whether a runtime instance exists. `undefined` means the fact could not be
     * read at all — which is NOT the same as "nobody provides this".
     */
    readonly declaredProvides?: readonly LiveProvided[];
    /** Tool ids a loaded entry's module declares, keyed by tool id. `undefined` = unreadable. */
    readonly declaredTools?: Readonly<Record<string, readonly string[]>>;
    /**
     * Versions of the profile bundles AS THE RUNNING HOST SEES THEM, from the
     * plugin-manager service. This is authoritative and frequently disagrees with
     * what sits in `profiles/node_modules`: a packaged desktop app serves its
     * bundles from its own archive, so the on-disk copies can be a whole
     * generation behind. Comparing peer ranges against the disk copies instead of
     * these versions is how a version checker invents conflicts that do not exist.
     *
     * Mutable because the collector is synchronous while this fact is asynchronous.
     */
    bundleVersions?: Record<string, string>;
    /** Every tool id currently registered in the global registry. */
    readonly tools: readonly string[];
    /** Notes about what could not be read from the runtime. */
    readonly notes: readonly string[];
}
/** One applied patch layer, in application order. */
export interface PatchLayer {
    readonly index: number;
    /** Human label, e.g. `bundle dsh-base@0.2.0-rc.2` or `user patch`. */
    readonly label: string;
    readonly kind: 'bundle' | 'user';
    readonly file: string;
    readonly packageName?: string;
    readonly version?: string;
}
/** One row introduced by an `insert:` list. */
export interface PatchInsert {
    readonly rowId: string;
    readonly moduleName: string;
    readonly hasConfig: boolean;
    readonly configJson: string;
    readonly layerIndex: number;
}
/** One id-addressed row override (config replacement, disable, re-insert). */
export interface PatchOverride {
    readonly rowId: string;
    readonly moduleName?: string;
    readonly disabled: boolean;
    readonly hasConfig: boolean;
    readonly configJson: string;
    readonly layerIndex: number;
}
/** One installed package the profile resolves. */
export interface ResolvedPackage {
    readonly name: string;
    readonly version: string;
    readonly dir: string;
    /** `dependencies` + `peerDependencies` as declared ranges. */
    readonly ranges: Readonly<Record<string, string>>;
    readonly enginesNode?: string;
    /**
     * Which realm the package's plugin half lands in. `client` means it declares
     * `dsh.client` and runs in the page; comparison with Host packages is
     * meaningless for it.
     *
     * Absent means "no browser half declared", which in practice means host-side.
     * `host` is never assigned explicitly: the key's presence is the signal.
     */
    readonly halves?: 'client' | 'host';
    /**
     * The browser half's declared contract, when `dsh.client` is present.
     *
     * Read from real manifests rather than assumed: across the installed profile
     * the field only ever carries `platform` and `inject`, so those are what this
     * model records. `inject` here lists CLIENT-SIDE MODULE names (for example
     * `@deepseek-ai/dsh-client-ui-sidebar-right`), not service names — the page
     * half composes by module, and a name nothing provides leaves the half
     * silently inert, exactly like a host-side service nobody provides.
     */
    readonly client?: ClientHalf;
}
/** The `dsh.client` declaration of one package. */
export interface ClientHalf {
    /** Target platform string as declared, e.g. `web`. */
    readonly platform?: string;
    /** Client-side module names this half requires to be present. */
    readonly inject: readonly string[];
}
/** One name a plugin imports from a host package, at its import site. */
export interface ImportedSymbol {
    /** Package the plugin imports the name from. */
    readonly module: string;
    /** Exact file the import was found in. */
    readonly file: string;
    readonly symbol: string;
}
/** Source-level facts about one loaded package, gathered once per audit. */
export interface PackageSourceFacts {
    readonly name: string;
    /** Import sites not covered by the in-process export scan. */
    readonly uncheckedImports: readonly ImportedSymbol[];
    /**
     * Imports that could not be checked because the export surface was
     * incomplete. Never used to claim absence.
     */
    readonly unverifiable: readonly ImportedSymbol[];
    /** Symbol names resolved as present (coverage evidence). */
    readonly verified: number;
    readonly filesScanned: number;
}
/**
 * How trustworthy this snapshot's versions are as a description of the running
 * host.
 *
 * - `authoritative`         disk and running host agree; compare freely.
 * - `archive-authoritative` disk is stale BUT the running host's archive was
 *                           read, so compare against the archive instead. (W1)
 * - `stale-disk`            disk differs from a live host we could read versions
 *                           from but nothing else; version comparisons abstain.
 * - `unknown`               the running host could not be consulted at all.
 */
export type VersionAuthority = 'authoritative' | 'archive-authoritative' | 'stale-disk' | 'unknown';
/** The static snapshot for the StaticSnapshot interface. */
export interface StaticSnapshot {
    readonly profilePath: string;
    readonly layers: readonly PatchLayer[];
    readonly inserts: readonly PatchInsert[];
    readonly overrides: readonly PatchOverride[];
    /** Bundles whose declared patch file is absent. */
    readonly missingPatchFiles: readonly string[];
    /** Bundles the profile lists but that no `node_modules` root can resolve. */
    readonly unresolvedBundles: readonly string[];
    /** Packages reachable from this profile. */
    readonly packages: readonly ResolvedPackage[];
    /** Tool ids claimed by each package's compiled sources: tool → packages. */
    readonly declaredTools: Readonly<Record<string, readonly string[]>>;
    /** Service names each package appears to register: service → packages. */
    readonly declaredServices: Readonly<Record<string, readonly string[]>>;
    /** Host imports each package declares: package → module → symbol names. */
    readonly declaredImports: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
    /** Source-level import verification results, keyed by package name. */
    readonly sourceFacts: Readonly<Record<string, PackageSourceFacts>>;
    /** Version of the running DSH host, when resolvable from the layers. */
    readonly hostVersion?: string;
    /**
     * Whether the versions in this snapshot describe the host that is actually
     * running. A packaged app can serve its bundles from its own archive while
     * `profiles/node_modules` holds an older generation; when that happens the
     * snapshot is NOT authoritative about versions, and version-sensitive
     * findings must be suppressed rather than reported against the wrong host.
     *
     * `archive-authoritative` is the fourth verdict, and the point of W1: the disk
     * is demonstrably stale, but the RUNNING host's own archive was read
     * successfully, so its versions and export surfaces are a trustworthy
     * baseline. Detectors run against that baseline instead of abstaining.
     */
    readonly versionAuthority: VersionAuthority;
    /** Explains a non-authoritative verdict, for the report's coverage note. */
    readonly versionAuthorityReason?: string;
    /**
     * Bundle name → version as the RUNNING host reports them, when an archive was
     * read. Absent means the host could not be consulted.
     */
    readonly hostBundleVersions?: Readonly<Record<string, string>>;
    /** Where those versions came from, for the coverage note. */
    readonly hostOrigin?: string;
    readonly notes: readonly string[];
}
