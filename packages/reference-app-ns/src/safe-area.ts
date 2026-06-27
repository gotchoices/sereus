/*
Android 15 (API 35) forces edge-to-edge: the activity window spans the full
screen and the system bars are transparent overlays. @nativescript/core 8.9 does
not apply the resulting insets, so the ActionBar draws under the status bar and
the Chat composer / Settings buttons draw under the gesture/navigation bar.

Fix it once at the window level: pad the activity content view (android.R.id.content,
the parent of the whole NativeScript view tree) by the system-bar insets, so every
page's ActionBar clears the status bar and its bottom row clears the nav bar. The
content background is tinted to the bar colour so the inset strips blend with the
ActionBar/composer instead of showing through as bare window background.

Edge-to-edge also means the window does NOT resize when the soft keyboard opens;
the IME height arrives as another inset dispatched to this same listener. We fold
it into the bottom padding (max of nav-bar and IME) so the Chat composer rises
above the keyboard instead of being covered by it.

No-op on iOS, where the safe area is applied natively.
*/

import { Application, isAndroid } from '@nativescript/core';

// Matches .action-bar / .composer in app.css so the inset strips are seamless.
const BAR_BG = '#1A1A2E';

/** Inset the activity content by the system bars (status + navigation). */
export function applySystemBarInsets(): void {
	if (!isAndroid) {
		return;
	}
	const activity: android.app.Activity | undefined =
		Application.android?.foregroundActivity ?? Application.android?.startActivity;
	const content = activity?.findViewById(android.R.id.content) as android.view.View | null;
	if (!content) {
		return;
	}
	content.setBackgroundColor(android.graphics.Color.parseColor(BAR_BG));
	content.setOnApplyWindowInsetsListener(
		new android.view.View.OnApplyWindowInsetsListener({
			onApplyWindowInsets(view: android.view.View, insets: android.view.WindowInsets) {
				// API 30+ exposes the typed inset query. Edge-to-edge is only forced
				// on API 35; on older levels the decor already insets content, so the
				// dispatched insets are zero and no padding is applied here.
				if (android.os.Build.VERSION.SDK_INT >= 30) {
					const bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
					const ime = insets.getInsets(android.view.WindowInsets.Type.ime());
					// When the keyboard is up, ime.bottom covers (and exceeds) the nav
					// bar, so the composer clears it; when hidden, ime.bottom is 0 and
					// we fall back to the nav-bar inset.
					const bottom = Math.max(bars.bottom, ime.bottom);
					view.setPadding(bars.left, bars.top, bars.right, bottom);
				}
				return insets;
			},
		}),
	);
	content.requestApplyInsets();
}
