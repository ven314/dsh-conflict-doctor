/**
 * A deliberately tiny expression interpreter for patch-layer `!!js` values.
 *
 * Patch layers may write `!!js <expression>` instead of a literal. Evaluating
 * one means running user code inside an audit, which this project refuses to do
 * — see the class doc of `static.ts`. Not evaluating them is *safe* but it is
 * not *neutral*: the audit treats every `!!js` as if the key were absent, and it
 * says so in a coverage note.
 *
 * That default is wrong in a measurable way. On this Windows machine the
 * profile ships:
 *
 *     - id: bash-sandbox
 *       disabled: !!js process.platform === 'win32'
 *
 * so those rows ARE disabled, while the audit assumed they were enabled. A
 * baseline that is wrong about which rows exist corrupts every downstream
 * existence check.
 *
 * This module therefore evaluates a WHITELIST and returns `undefined` for
 * everything else. `undefined` means "not decidable", and callers must keep
 * treating that as "assume the default", never as false.
 *
 * Supported (all pure, no side effects, no I/O):
 *   - string / number / boolean / null literals
 *   - `process.platform`, `process.arch`, `process.version` comparisons
 *   - `===` `!==` `==` `!=` between those
 *   - `&&`, `||`, `!`
 *   - `??` and `||`/`&&` chains between literals (the common default idiom)
 *   - parentheses
 *
 * Explicitly NOT supported, and never will be: property access on arbitrary
 * objects, function calls, template literals, `eval`, `Function`, `require`,
 * `import`. Anything of that shape returns `undefined`.
 *
 * @module dsh-conflict-doctor/expr
 */
/** The result of a successful evaluation. */
export type Evaluated = string | number | boolean | null;
/**
 * The evaluation environment.
 *
 * Injectable so the interpreter can be reasoned about and tested with a fixed
 * platform, instead of whatever machine happens to run the audit.
 */
export interface ExprEnv {
    readonly platform: string;
    readonly arch: string;
    readonly version: string;
}
/** The real environment, for production use. */
export declare function currentEnv(): ExprEnv;
/**
 * Try to evaluate one `!!js` expression.
 *
 * @param source - the expression text (without the `!!js` prefix).
 * @param env - the environment; defaults to the current process.
 * @returns the value, or undefined when it is outside the whitelist.
 */
export declare function evaluateExpression(source: string, env?: ExprEnv): Evaluated | undefined;
/**
 * Coerce an evaluated condition to the boolean a `disabled:` key wants.
 *
 * Only a genuine boolean is meaningful here. A string or number result means the
 * expression produced a value where a condition was expected, which the audit
 * must not silently read as true.
 *
 * @param source - the expression text.
 * @param env - the environment.
 * @returns the boolean, or undefined when it cannot be decided.
 */
export declare function evaluateCondition(source: string, env?: ExprEnv): boolean | undefined;
