import type { NativeScriptConfig } from '@nativescript/core';

export default {
	id: 'org.gotchoices.sereus.chat.ns',
	appPath: 'app',
	appResourcesPath: 'App_Resources',
	android: {
		v8Flags: '--expose_gc',
		markingMode: 'none',
		suppressCallJSMethodExceptions: false,
	},
} as NativeScriptConfig;
