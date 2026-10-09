/**
 * Stable plugin entry for `@local/dsh-trae-vault`.
 *
 * This file is deliberately tiny and rarely changes. The Harness module loader
 * caches a module job per resolved URL, so a bundle replaced on disk keeps
 * executing the generation it first imported. That makes an ordinary entry file
 * a one-shot: every later edit would need another Host restart.
 *
 * The real implementation therefore lives in a generation file whose URL is
 * stamped with REVISION. Bumping the revision changes the import URL, which
 * forces a fresh module generation on the next activation without a restart.
 * Edit the generation file and raise REVISION together.
 *
 * The same cache is why the generation stamps its own relative imports (see
 * `impl.r<REVISION>.js`): an unstamped `./lib/foo.js` specifier resolves to one
 * URL for the life of the process, so raising REVISION would reload the
 * generation and then keep it wired to the *previous* `lib/` modules. That is a
 * measured failure, not a theoretical one: with the lib modules imported bare,
 * an edit to `lib/vault.trae2.js` stayed invisible — the running plugin kept
 * answering from the old one while the file on disk, and every test, disagreed.
 *
 * @module @local/dsh-trae-vault
 */

/**
 * Generation of the implementation below. Bump with every implementation edit,
 * including an edit to any `lib/` module: the generation is what stamps their
 * URLs, so it is the only thing that makes a lib edit take effect.
 *
 * The generation file repeats the number as a literal on its lib specifiers,
 * because a static specifier cannot interpolate. `test/activation.mjs` asserts
 * the two agree, which is what catches a forgotten restamp.
 */
export const REVISION = 35;

const implementation = await import(`./impl.r${REVISION}.js?v=${REVISION}`);

export const name = implementation.name;
export const inject = implementation.inject;
export const Config = implementation.Config;
export const DEFAULT_OPTIONS = implementation.DEFAULT_OPTIONS;

/**
 * Activate the plugin.
 * @param {object} ctx - the plugin context.
 * @param {unknown} config - the row config, validated or raw.
 */
export function apply(ctx, config) {
  return implementation.apply(ctx, config);
}