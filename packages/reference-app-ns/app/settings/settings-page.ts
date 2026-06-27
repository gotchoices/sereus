/*
Code-behind for the Settings screen. Connect / disconnect, apply a seed, dial a
peer, and create a chat strand — all delegated to the page view model (which in
turn drives the shared CadreViewModel singleton).
*/

import { Frame } from '@nativescript/core';
import type { NavigatedData, Page } from '@nativescript/core';

import { SettingsViewModel } from './settings-view-model';
import { applySystemBarInsets } from '../../src/safe-area';

const viewModel = new SettingsViewModel();

export function onNavigatingTo(args: NavigatedData): void {
	const page = args.object as Page;
	page.bindingContext = viewModel;
	// Inset the ActionBar / form past the Android 15 edge-to-edge system bars.
	applySystemBarInsets();
}

/** Up/Back affordance — pop to Chat (hardware back does the same on Android). */
export function onBack(): void {
	Frame.topmost()?.goBack();
}

export function onConnect(): void {
	void viewModel.onConnect();
}

export function onDisconnect(): void {
	void viewModel.onDisconnect();
}

export function onApplySeed(): void {
	void viewModel.onApplySeed();
}

export function onDialPeer(): void {
	void viewModel.onDialPeer();
}

export function onCreateStrand(): void {
	void viewModel.onCreateStrand();
}

export function onModalOk(): void {
	viewModel.onModalOk();
}
