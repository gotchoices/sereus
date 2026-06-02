/*
Code-behind for the minimal solo-smoke page. The real chat UI lands in
reference-app-ns-chat; this only needs a button to drive the runtime smoke.
*/

import type { EventData, NavigatedData, Page, View } from '@nativescript/core';

import { MainViewModel } from './main-view-model';

export function onNavigatingTo(args: NavigatedData): void {
	const page = args.object as Page;
	page.bindingContext = new MainViewModel();
}

export function onRunSmoke(args: EventData): void {
	const page = (args.object as View).page;
	const vm = page.bindingContext as MainViewModel;
	void vm.runSmoke();
}
