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
/** The real environment, for production use. */
export function currentEnv() {
    return { platform: process.platform, arch: process.arch, version: process.version };
}
/** Multi-character operators, longest first so `!==` is not read as `!` `==`. */
const OPERATORS = ['===', '!==', '??', '&&', '||', '==', '!=', '!', '(', ')'];
/**
 * Tokenise an expression, or return undefined on anything unrecognised.
 *
 * Returning undefined rather than throwing keeps the caller simple: every
 * unsupported construct has exactly one meaning, "not decidable".
 *
 * @param source - the raw expression text after `!!js`.
 * @returns tokens, or undefined when the text contains something unsupported.
 */
function tokenize(source) {
    const tokens = [];
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === undefined)
            break;
        if (/\s/.test(ch)) {
            i += 1;
            continue;
        }
        // String literal: single or double quoted, no escapes beyond the quote.
        // An escape sequence would mean this is real code, not a literal.
        if (ch === "'" || ch === '"') {
            const end = source.indexOf(ch, i + 1);
            if (end === -1)
                return undefined;
            const body = source.slice(i + 1, end);
            if (body.includes('\\'))
                return undefined;
            tokens.push({ kind: 'string', value: body });
            i = end + 1;
            continue;
        }
        if (/[0-9]/.test(ch)) {
            const match = /^[0-9]+(?:\.[0-9]+)?/.exec(source.slice(i));
            if (match === null)
                return undefined;
            tokens.push({ kind: 'number', value: Number(match[0]) });
            i += match[0].length;
            continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
            const match = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(source.slice(i));
            if (match === null)
                return undefined;
            tokens.push({ kind: 'ident', value: match[0] });
            i += match[0].length;
            continue;
        }
        const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
        if (op === undefined)
            return undefined;
        tokens.push({ kind: 'op', value: op });
        i += op.length;
    }
    return tokens;
}
/* ----------------------------------------------------------------- parsing */
/**
 * Resolve a bare identifier to a value.
 *
 * @param name - identifier text.
 * @param env - the environment.
 * @returns the value, or undefined when the identifier is not whitelisted.
 */
function resolveIdent(name, env) {
    switch (name) {
        case 'process.platform':
            return env.platform;
        case 'process.arch':
            return env.arch;
        case 'process.version':
            return env.version;
        case 'true':
            return true;
        case 'false':
            return false;
        case 'null':
            return null;
        case 'undefined':
            // Returning undefined here would be indistinguishable from "undecidable",
            // so `undefined` is simply not supported as a value.
            return undefined;
        default:
            // Covers every other property chain (`ctx.webStartup.host`,
            // `process.env.X`, `dshHomePath(...)`) — all outside the whitelist.
            return undefined;
    }
}
/** Strict equality, matching JS `===` for the value types we allow. */
function strictEquals(left, right) {
    return left === right;
}
/**
 * Truthiness for the value types the whitelist allows.
 *
 * Kept in one place because it is used by `!`, `&&`, and `||`, and three
 * hand-rolled versions of the same predicate are how the `!` inversion bug
 * survived.
 *
 * @param value - an evaluated value.
 * @returns JS truthiness.
 */
function isTruthy(value) {
    return value !== false && value !== null && value !== '' && value !== 0;
}
/** Loose equality, limited to the cases that appear in defaults. */
function looseEquals(left, right) {
    // eslint-disable-next-line eqeqeq
    return left == right;
}
/**
 * Evaluate a token stream with a recursive-descent parser.
 *
 * Precedence, lowest first: `??` / `||` / `&&` (left-assoc), equality,
 * unary `!`, primary.
 *
 * @param tokens - token list.
 * @param env - the environment.
 * @returns the value, or undefined when anything is unsupported.
 */
function evaluateTokens(tokens, env) {
    let pos = 0;
    const peek = () => tokens[pos];
    const eat = (value) => {
        const token = peek();
        if (token?.kind === 'op' && token.value === value) {
            pos += 1;
            return true;
        }
        return false;
    };
    /** `??`, `||`, `&&` — the default-value idioms. */
    const parseLogical = () => {
        let left = parseEquality();
        if (left === undefined)
            return undefined;
        for (;;) {
            if (eat('??')) {
                // `??` yields the right side only when the left is null/undefined.
                const right = parseEquality();
                if (right === undefined)
                    return undefined;
                left = left === null ? right : left;
                continue;
            }
            if (eat('||')) {
                const right = parseEquality();
                if (right === undefined)
                    return undefined;
                left = isTruthy(left) ? left : right;
                continue;
            }
            if (eat('&&')) {
                const right = parseEquality();
                if (right === undefined)
                    return undefined;
                left = isTruthy(left) ? right : left;
                continue;
            }
            return left;
        }
    };
    const parseEquality = () => {
        const left = parseUnary();
        if (left === undefined)
            return undefined;
        const token = peek();
        if (token?.kind !== 'op')
            return left;
        if (token.value === '===' || token.value === '!==') {
            pos += 1;
            const right = parseUnary();
            if (right === undefined)
                return undefined;
            const equal = strictEquals(left, right);
            return token.value === '===' ? equal : !equal;
        }
        if (token.value === '==' || token.value === '!=') {
            pos += 1;
            const right = parseUnary();
            if (right === undefined)
                return undefined;
            const equal = looseEquals(left, right);
            return token.value === '==' ? equal : !equal;
        }
        return left;
    };
    const parseUnary = () => {
        if (eat('!')) {
            const operand = parseUnary();
            if (operand === undefined)
                return undefined;
            // `!x` is false when x is truthy. Inverting this check produced `!false`
            // -> false, i.e. the operand echoed back unchanged, and it survived the
            // first review because `!true` happens to give the right answer.
            return isTruthy(operand) ? false : true;
        }
        return parsePrimary();
    };
    const parsePrimary = () => {
        const token = peek();
        if (token === undefined)
            return undefined;
        if (token.kind === 'string' || token.kind === 'number') {
            pos += 1;
            return token.value;
        }
        if (token.kind === 'ident') {
            pos += 1;
            return resolveIdent(token.value, env);
        }
        if (token.kind === 'op' && token.value === '(') {
            pos += 1;
            const inner = parseLogical();
            if (inner === undefined)
                return undefined;
            if (!eat(')'))
                return undefined;
            return inner;
        }
        return undefined;
    };
    const value = parseLogical();
    // Trailing tokens mean the expression was not fully understood, so the whole
    // thing is treated as undecidable rather than partially evaluated.
    if (value === undefined || pos !== tokens.length)
        return undefined;
    return value;
}
/**
 * Try to evaluate one `!!js` expression.
 *
 * @param source - the expression text (without the `!!js` prefix).
 * @param env - the environment; defaults to the current process.
 * @returns the value, or undefined when it is outside the whitelist.
 */
export function evaluateExpression(source, env = currentEnv()) {
    const trimmed = source.trim();
    if (trimmed.length === 0 || trimmed.length > 512)
        return undefined;
    // Reject the shapes that mean "this is real code" before tokenising, so the
    // refusal is explicit rather than an accident of the grammar.
    if (/=>|\bfunction\b|\bnew\b|\bawait\b|\bimport\b|\brequire\b|`|\$\{/.test(trimmed))
        return undefined;
    const tokens = tokenize(trimmed);
    if (tokens === undefined || tokens.length === 0)
        return undefined;
    return evaluateTokens(tokens, env);
}
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
export function evaluateCondition(source, env = currentEnv()) {
    const value = evaluateExpression(source, env);
    return typeof value === 'boolean' ? value : undefined;
}
