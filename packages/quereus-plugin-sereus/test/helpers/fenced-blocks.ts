import { marked } from 'marked';

export interface FencedBlock {
	/** Text of the nearest heading above the block, at any level. */
	heading: string;
	/** The fence's info string (`sql`, `sql schema chat`, …); empty when it has none. */
	info: string;
	text: string;
}

/** Every code block in `markdown`, in document order. */
export function fencedBlocks(markdown: string): FencedBlock[] {
	let heading = '(before the first heading)';
	const blocks: FencedBlock[] = [];
	marked.walkTokens(marked.lexer(markdown), token => {
		if (token.type === 'heading') {
			heading = token.text;
		} else if (token.type === 'code') {
			blocks.push({ heading, info: token.lang ?? '', text: token.text });
		}
	});
	return blocks;
}
