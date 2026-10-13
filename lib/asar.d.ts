/** One node of the decoded tree. */
export interface AsarNode {
    /** Present on file nodes. May exceed Number.MAX_SAFE_INTEGER as a string. */
    readonly size?: number | string;
    /**
     * Byte offset of the content from the start of the ARCHIVE.
     *
     * Older Electron wrote a JSON number; modern builds write a STRING to carry
     * offsets past 2^53 exactly. Both forms occur in the wild, so both are read.
     */
    readonly offset?: number | string;
    /** Present on directory nodes. */
    readonly files?: Readonly<Record<string, AsarNode>>;
    /** Present on some modern builds; informational only. */
    readonly integrity?: Readonly<{
        algorithm?: string;
        hash?: string;
    }>;
}
/** An opened archive handle. Close it with {@link closeAsar}. */
export interface AsarArchive {
    /** Absolute path that was opened. */
    readonly path: string;
    /** Decoded root; its own `files` map is the archive root. */
    readonly root: AsarNode;
    /** File descriptor held open for reads. */
    readonly fd: number;
    /**
     * Additive base for every content offset.
     *
     * Content offsets in the tree are relative to the END of the effective header
     * (the 16-byte pickle prefix plus the whole JSON tree), NOT to the start of
     * the file. Verified empirically against a real 121 MB Electron archive by
     * SHA-256: for `package.json` the tree said 117911453 while the bytes actually
     * begin at 121303517, a difference of exactly `16 + treeLen`.
     *
     * Note that `16 + treeLen` is NOT the u32 `headerSize` field, which reports
     * 3392056 against a true value of 3392064 — eight bytes off, enough to land
     * every read inside a neighbouring file's bytes.
     */
    readonly contentBase: number;
}
/**
 * Decode the pickled header of an asar file.
 *
 * @param path - archive to open.
 * @returns the decoded root node and an open descriptor.
 * @throws when the file is too small, malformed, or not JSON at all — the
 *   caller turns this into a coverage note rather than propagating it.
 */
export declare function openAsar(path: string): AsarArchive;
/** Release the descriptor. Safe to call twice. */
export declare function closeAsar(archive: AsarArchive): void;
/**
 * Resolve one path inside the archive.
 *
 * The input is normalised before lookup, so both `../node_modules/evil` inside
 * the archive and a leading `./` behave like any other walk. Nothing here can
 * escape the archive root: the result is a node from the decoded tree, never a
 * filesystem path.
 *
 * @param archive - an open archive.
 * @param target - slash-separated path inside the archive.
 * @returns the node, or undefined when absent.
 */
export declare function findNode(archive: AsarArchive, target: string): AsarNode | undefined;
/**
 * Read one file's bytes.
 *
 * @param archive - an open archive.
 * @param target - path inside the archive.
 * @returns the content, or undefined when the path is missing or not a file.
 */
export declare function readAsarFile(archive: AsarArchive, target: string): Buffer | undefined;
/** Read one file as UTF-8 text. */
export declare function readAsarText(archive: AsarArchive, target: string): string | undefined;
/** Whether a path exists in the archive. */
export declare function hasAsarPath(archive: AsarArchive, target: string): boolean;
/**
 * List immediate children of one directory.
 *
 * @param archive - an open archive.
 * @param target - directory path; pass `''` for the root.
 * @returns `[name, node]` pairs in insertion order.
 */
export declare function listAsarDir(archive: AsarArchive, target: string): Array<[string, AsarNode]>;
/** Whether a node is a directory. */
export declare function isAsarDir(node: AsarNode | undefined): boolean;
