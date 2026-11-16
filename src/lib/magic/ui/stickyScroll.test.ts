import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	createStickyBottomController,
	feedTailTrigger,
	isNearBottom
} from './stickyScroll.ts';

describe('UI sticky-bottom scroll controller for Pod Chat & Rules Log', () => {
	it('pins to bottom across tall appended messages and pauses only when scrolled up', () => {
		const el = { scrollTop: 0, scrollHeight: 500, clientHeight: 200 };
		const ctrl = createStickyBottomController(el, { trigger: '1:a', resetKey: 'chat' });

		ctrl.scrollToBottom();
		assert.equal(el.scrollTop, 300);
		assert.equal(ctrl.isPinned(), true);

		// Tall 120px message arrives before update() runs: distance is temporarily 120px (>24px),
		// yet controller remembers pinned=true from scroll position and snaps cleanly to bottom.
		el.scrollHeight = 620;
		ctrl.update({ trigger: '2:b', resetKey: 'chat' });
		assert.equal(el.scrollTop, 420);
		assert.equal(ctrl.isPinned(), true);

		// User scrolls up to read older history -> auto-scroll pauses.
		el.scrollTop = 180;
		ctrl.handleScroll();
		assert.equal(ctrl.isPinned(), false);

		el.scrollHeight = 700;
		ctrl.update({ trigger: '3:c', resetKey: 'chat' });
		assert.equal(el.scrollTop, 180);

		// Scrolling back within 24px re-enables bottom stickiness.
		el.scrollTop = 482;
		ctrl.handleScroll();
		assert.equal(ctrl.isPinned(), true);

		el.scrollHeight = 760;
		ctrl.update({ trigger: '4:d', resetKey: 'chat' });
		assert.equal(el.scrollTop, 560);
	});

	it('forces bottom scroll on user message submit (forceNonce) and retains pin across resize and resetKey', () => {
		const el = { scrollTop: 0, scrollHeight: 800, clientHeight: 250 };
		const ctrl = createStickyBottomController(el, {
			trigger: '10:m10',
			forceNonce: 0,
			resetKey: 'chat'
		});
		ctrl.scrollToBottom();
		assert.equal(el.scrollTop, 550);

		// User scrolls up to read earlier messages, then sends a message.
		el.scrollTop = 100;
		ctrl.handleScroll();
		assert.equal(ctrl.isPinned(), false);

		ctrl.update({ trigger: '10:m10', forceNonce: 1, resetKey: 'chat' });
		assert.equal(el.scrollTop, 550);
		assert.equal(ctrl.isPinned(), true);

		// Async server reply appends sent message -> stays pinned to new bottom.
		el.scrollHeight = 860;
		ctrl.update({ trigger: '11:m11', forceNonce: 1, resetKey: 'chat' });
		assert.equal(el.scrollTop, 610);

		// Panel shrink keeps bottom visible.
		el.clientHeight = 180;
		ctrl.handleResize();
		assert.equal(el.scrollTop, 680);

		// Tab switch (resetKey) re-pins even if previously scrolled up.
		el.scrollTop = 40;
		ctrl.handleScroll();
		ctrl.update({ trigger: '5:l5', forceNonce: 1, resetKey: 'log' });
		assert.equal(el.scrollTop, 680);
		assert.equal(ctrl.isPinned(), true);
	});

	it('detects tail id changes in feedTailTrigger and checks near-bottom tolerance', () => {
		const buf1 = [
			{ id: '1' },
			{ id: '2' }
		];
		const buf2 = [
			{ id: '2' },
			{ id: '3' }
		];
		assert.notEqual(feedTailTrigger(buf1), feedTailTrigger(buf2));
		assert.equal(feedTailTrigger([]), '0:');

		assert.equal(isNearBottom({ scrollTop: 280, scrollHeight: 500, clientHeight: 200 }), true);
		assert.equal(isNearBottom({ scrollTop: 270, scrollHeight: 500, clientHeight: 200 }), false);
	});

	it('wires both Pod Chat and Rules Log chronologically with stickyBottom in RightDock and ActivePodPanel', () => {
		const dockSrc = fs.readFileSync(
			path.resolve('src/lib/magic/ui/RightDock.svelte'),
			'utf8'
		);
		const lobbySrc = fs.readFileSync(
			path.resolve('src/lib/magic/ui/lobby/ActivePodPanel.svelte'),
			'utf8'
		);

		assert.equal(dockSrc.includes('[...gameState.log].reverse()'), false);
		assert.match(dockSrc, /\{#each gameState\.log as entry \(entry\.id\)\}/);
		assert.equal(dockSrc.match(/use:stickyBottom=/g)?.length, 2);
		assert.match(dockSrc, /chatForceNonce \+= 1/);

		assert.equal(lobbySrc.match(/use:stickyBottom=/g)?.length, 1);
		assert.match(lobbySrc, /lobbyChatForceNonce \+= 1/);
	});
});
