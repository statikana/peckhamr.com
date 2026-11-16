import type { Action } from 'svelte/action';

export interface ScrollableElementLike {
	scrollTop: number;
	readonly scrollHeight: number;
	readonly clientHeight: number;
}

export interface StickyBottomOptions {
	/** Reactive signature changing whenever new items are appended (even at fixed cap). */
	trigger: string | number;
	/** Monotonically bumped on user send/action to force pinning back to bottom. */
	forceNonce?: number;
	/** Identity key for tab/view switches; changing it re-pins and jumps to bottom. */
	resetKey?: string | number;
	/** Distance from bottom (px) still considered pinned to bottom. */
	threshold?: number;
}

export const DEFAULT_STICKY_THRESHOLD_PX = 24;

export function feedTailTrigger<T extends { id: string | number }>(items: readonly T[]): string {
	return `${items.length}:${items.length > 0 ? items[items.length - 1].id : ''}`;
}

export function isNearBottom(
	el: ScrollableElementLike,
	threshold = DEFAULT_STICKY_THRESHOLD_PX
): boolean {
	const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
	return maxScroll - el.scrollTop <= threshold;
}

export function createStickyBottomController(
	el: ScrollableElementLike,
	initial: StickyBottomOptions
) {
	let threshold = initial.threshold ?? DEFAULT_STICKY_THRESHOLD_PX;
	let pinned = true;
	let lastForceNonce = initial.forceNonce ?? 0;
	let lastResetKey = initial.resetKey;
	let programmaticTarget: number | null = null;

	function scrollToBottom(): void {
		const target = Math.max(0, el.scrollHeight - el.clientHeight);
		programmaticTarget = target;
		el.scrollTop = target;
		pinned = true;
	}

	function handleScroll(): void {
		if (programmaticTarget !== null) {
			const settled = Math.abs(el.scrollTop - programmaticTarget) <= 2;
			programmaticTarget = null;
			if (settled) {
				pinned = isNearBottom(el, threshold);
				return;
			}
		}
		pinned = isNearBottom(el, threshold);
	}

	function handleResize(): void {
		if (pinned) scrollToBottom();
	}

	function update(next: StickyBottomOptions): void {
		threshold = next.threshold ?? DEFAULT_STICKY_THRESHOLD_PX;
		const nextForce = next.forceNonce ?? 0;
		const forced = nextForce !== lastForceNonce || next.resetKey !== lastResetKey;
		lastForceNonce = nextForce;
		lastResetKey = next.resetKey;
		if (forced || pinned) {
			scrollToBottom();
		}
	}

	return {
		isPinned: () => pinned,
		scrollToBottom,
		handleScroll,
		handleResize,
		update
	};
}

export const stickyBottom: Action<HTMLElement, StickyBottomOptions> = (node, initial) => {
	const controller = createStickyBottomController(node, initial);
	const onScroll = () => controller.handleScroll();
	node.addEventListener('scroll', onScroll, { passive: true });

	const resizeObserver =
		typeof ResizeObserver !== 'undefined'
			? new ResizeObserver(() => controller.handleResize())
			: null;
	resizeObserver?.observe(node);

	controller.scrollToBottom();
	const rafId =
		typeof requestAnimationFrame !== 'undefined'
			? requestAnimationFrame(() => controller.handleResize())
			: null;

	return {
		update(next) {
			controller.update(next);
		},
		destroy() {
			if (rafId !== null && typeof cancelAnimationFrame !== 'undefined') {
				cancelAnimationFrame(rafId);
			}
			resizeObserver?.disconnect();
			node.removeEventListener('scroll', onScroll);
		}
	};
};
