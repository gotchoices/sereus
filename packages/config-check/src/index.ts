/**
 * @serfab/config-check — strict checking of a parsed config tree, with environment-variable
 * overrides written over it first. Dependency-free and runtime-neutral, so every Sereus package
 * that reads a config file can share one set of rules and one message format.
 */

export * from './checkers.js';
export * from './env.js';
export { nearestKey } from './nearest-key.js';
export { type ValidateOptions, validateTree } from './validate.js';
