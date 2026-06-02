/**
 * @ungap/structured-clone ships no type declarations (v1.3.x). Declare the
 * single default export we use — a spec-compliant structuredClone.
 */
declare module '@ungap/structured-clone' {
	export default function structuredClone<T>(
		value: T,
		options?: { lossy?: boolean; json?: boolean },
	): T;
}
