/**
 * Refuses a Vitest run started from a Windows working directory whose drive letter is lowercase
 * (`c:\projects\sereus`), the form VS Code gives its terminals. Vitest 4.1 then loads a second copy
 * of its own runner, and every test file of a run with two or more files fails at its first
 * `describe` with "Vitest failed to find the runner" or "Cannot read properties of undefined
 * (reading 'config')". Changing the working directory later, in a global setup or through the
 * config's `root`, does not help, so the run has to start from the uppercase form. See
 * docs/contributing/testing.md → "Windows: start from an uppercase drive letter".
 *
 * NOTE: drop this once a Vitest release runs a lowercase-drive working directory with two files;
 * re-check on each Vitest upgrade.
 */
export function assertUppercaseDriveLetter(cwd: string = process.cwd(), platform: NodeJS.Platform = process.platform): void {
	if (platform !== 'win32' || !/^[a-z]:/.test(cwd)) return;
	const fixed = cwd[0].toUpperCase() + cwd.slice(1);
	throw new Error(
		`Vitest was started from "${cwd}", whose drive letter is lowercase. On Windows that makes every ` +
		`test file fail with "Vitest failed to find the runner". Start again from "${fixed}" ` +
		`(in Git Bash, any \`cd /${cwd[0]}/…\` gives the uppercase form; in PowerShell, \`Set-Location '${fixed}'\`).`,
	);
}
