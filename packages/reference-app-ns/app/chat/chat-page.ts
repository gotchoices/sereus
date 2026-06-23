/*
Code-behind for the Chat screen. Binds the shared ChatViewModel singleton, runs
its poll loop while the page is visible, and sends on tap / return key.
*/

import { Frame } from '@nativescript/core';
import type { EventData, ListView, NavigatedData, Page, View } from '@nativescript/core';

import { getChatVm } from '../../src/chat-vm';

const viewModel = getChatVm();

export function onNavigatingTo(args: NavigatedData): void {
	const page = args.object as Page;
	page.bindingContext = viewModel;
	// Start (or restart) polling — picks up a strand created while away.
	viewModel.start();
}

export function onNavigatingFrom(): void {
	viewModel.stop();
}

export function onUnloaded(): void {
	viewModel.stop();
}

export function onSettings(): void {
	Frame.topmost()?.navigate('settings/settings-page');
}

export function onSend(args: EventData): void {
	const page = (args.object as View).page;
	void viewModel
		.send()
		.then(() => scrollToEnd(page))
		.catch((err) => console.warn('[chat] send failed:', err));
}

function scrollToEnd(page: Page | undefined): void {
	const list = page?.getViewById('messageList') as ListView | undefined;
	const count = viewModel.messages.length;
	if (list && count > 0) {
		list.scrollToIndex(count - 1);
	}
}
