/**
 * Tiny display helpers — relative time, byte sizes, peer-ID shortening.
 * Kept dependency-free; everything renders inside the SPA.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
	if (!iso) return '—';
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '—';
	const diff = now - t;
	// A past event stamped slightly ahead of this clock reads as now, not as future.
	if (diff < 0) return 'just now';
	return `${formatSpan(diff)} ago`;
}

/**
 * For a moment that may still lie ahead, such as an expiry: "in 3d" while it is
 * in the future, "3d ago" once it has passed.
 */
export function formatRelativeDeadline(iso: string | null | undefined, now: number = Date.now()): string {
	const t = iso ? Date.parse(iso) : NaN;
	if (Number.isFinite(t) && t > now) return `in ${formatSpan(t - now)}`;
	return formatRelativeTime(iso, now);
}

function formatSpan(ms: number): string {
	if (ms < MINUTE) return `${Math.floor(ms / SECOND)}s`;
	if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m`;
	if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
	return `${Math.floor(ms / DAY)}d`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes)) return '—';
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = bytes / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i += 1;
	}
	return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function formatUptime(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

export function shortPeerId(peerId: string | null | undefined): string {
	if (!peerId) return '—';
	if (peerId.length <= 12) return peerId;
	return `${peerId.slice(0, 6)}…${peerId.slice(-4)}`;
}
