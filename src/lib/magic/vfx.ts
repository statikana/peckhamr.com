import type { VfxEvent } from './types.ts';

export interface VfxParticle {
	x: number;
	y: number;
	vx: number;
	vy: number;
	radius: number;
	color: string;
	alpha: number;
	decay: number;
	gravity: number;
}

export interface FloatingBanner {
	id: string;
	x: number;
	y: number;
	vy: number;
	text: string;
	color: string;
	alpha: number;
	scale: number;
}

export interface ArrowLine {
	id: string;
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	kind: 'attack' | 'block' | 'target' | 'active_cursor' | 'attachment';
	label?: string;
}

export function getElementCenterByGameId(id: string | undefined): { x: number; y: number } | null {
	if (!id || typeof document === 'undefined') return null;
	const el = document.querySelector(`[data-game-id="${CSS.escape(id)}"]`);
	if (!el) return null;
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return null;
	return {
		x: rect.left + rect.width / 2,
		y: rect.top + rect.height / 2
	};
}

export function computeBezierPath(x1: number, y1: number, x2: number, y2: number): string {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const dist = Math.hypot(dx, dy);
	const arcLift = Math.min(48, dist * 0.12);
	const sideBow = Math.abs(dx) < 32 ? -Math.min(32, Math.max(14, dist * 0.22)) : 0;
	const cx1 = x1 + dx * 0.35 + sideBow;
	const cy1 = y1 + dy * 0.35 - arcLift;
	// Setting P2 = (P1 + P3) / 2 guarantees B''(1) = 0 (zero curvature at the tip)
	// so the shaft enters the SVG marker arrowhead 100% collinear with its tangent.
	const cx2 = (cx1 + x2) * 0.5;
	const cy2 = (cy1 + y2) * 0.5;
	return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`;
}

export class ArenaVfxController {
	particles: VfxParticle[] = [];
	banners: FloatingBanner[] = [];
	seenEventIds = new Set<string>();
	screenShake = 0;

	processEvents(events: VfxEvent[]): boolean {
		let triggeredShake = false;
		const W = typeof window !== 'undefined' ? window.innerWidth : 1280;
		const H = typeof window !== 'undefined' ? window.innerHeight : 720;

		let phaseBannerOffset = 0;
		for (const ev of events) {
			if (this.seenEventIds.has(ev.id)) continue;
			this.seenEventIds.add(ev.id);

			const targetPos =
				getElementCenterByGameId(ev.targetId) ||
				getElementCenterByGameId(ev.sourceId) || {
					x: W * 0.5,
					y: H * 0.45
				};

			switch (ev.kind) {
				case 'phase_change': {
					if (ev.label && ev.label.startsWith('Turn ')) {
						this.addBanner(
							W * 0.46,
							H * 0.24 + phaseBannerOffset,
							ev.label,
							'#ffd866'
						);
						phaseBannerOffset += 28;
					}
					break;
				}
				case 'spell_cast':
				case 'commander_cast': {
					const isCmd = ev.kind === 'commander_cast';
					this.spawnBurst(
						targetPos.x,
						targetPos.y,
						isCmd ? 48 : 28,
						isCmd ? ['#ffd866', '#ab9df2', '#78dce8'] : ['#78dce8', '#ab9df2', '#fcfcfa']
					);
					if (ev.label) {
						this.addBanner(
							targetPos.x,
							targetPos.y - 20,
							isCmd ? `COMMANDER: ${ev.label}` : `CAST: ${ev.label}`,
							isCmd ? '#ffd866' : '#78dce8'
						);
					}
					break;
				}
				case 'stack_resolve': {
					this.spawnBurst(targetPos.x, targetPos.y, 24, ['#a9dc76', '#ffd866', '#78dce8']);
					break;
				}
				case 'damage': {
					this.spawnBurst(targetPos.x, targetPos.y, 32, ['#ff6188', '#fc9867', '#ffd866']);
					if (ev.amount) {
						this.addBanner(
							targetPos.x,
							targetPos.y - 12,
							ev.label || `-${ev.amount}`,
							'#ff6188'
						);
						if (ev.amount >= 5) {
							this.screenShake = Math.min(14, ev.amount * 1.4);
							triggeredShake = true;
						}
					}
					break;
				}
				case 'heal': {
					this.spawnBurst(targetPos.x, targetPos.y, 24, ['#a9dc76', '#ffd866']);
					if (ev.amount) {
						this.addBanner(
							targetPos.x,
							targetPos.y - 12,
							ev.label || `+${ev.amount}`,
							'#a9dc76'
						);
					}
					break;
				}
				case 'destroy':
				case 'exile': {
					this.spawnBurst(
						targetPos.x,
						targetPos.y,
						40,
						ev.kind === 'exile' ? ['#ab9df2', '#78dce8', '#ffffff'] : ['#ff6188', '#fc9867', '#524e53']
					);
					if (ev.label) {
						this.addBanner(
							targetPos.x,
							targetPos.y,
							ev.kind === 'exile' ? `Exiled: ${ev.label}` : `Destroyed: ${ev.label}`,
							ev.kind === 'exile' ? '#ab9df2' : '#fc9867'
						);
					}
					break;
				}
				case 'counter_spell': {
					this.spawnBurst(targetPos.x, targetPos.y, 42, ['#78dce8', '#ab9df2', '#ffffff']);
					this.addBanner(targetPos.x, targetPos.y, ev.label || 'COUNTERED!', '#78dce8');
					break;
				}
				case 'proliferate': {
					this.spawnBurst(W * 0.5, H * 0.5, 45, ['#78dce8', '#a9dc76', '#ab9df2']);
					this.addBanner(W * 0.5, H * 0.45, 'PROLIFERATE (+1 Counter)', '#78dce8');
					break;
				}
				case 'victory': {
					this.spawnBurst(W * 0.35, H * 0.4, 65, ['#ffd866', '#ff6188', '#78dce8', '#a9dc76']);
					this.spawnBurst(W * 0.65, H * 0.4, 65, ['#ffd866', '#ab9df2', '#fc9867', '#a9dc76']);
					this.addBanner(W * 0.5, H * 0.35, ev.label || 'VICTORY!', '#ffd866');
					break;
				}
			}
		}

		return triggeredShake;
	}

	spawnBurst(x: number, y: number, count: number, palette: string[]): void {
		for (let i = 0; i < count; i++) {
			const angle = Math.random() * Math.PI * 2;
			const speed = 1.4 + Math.random() * 6.5;
			this.particles.push({
				x,
				y,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed - 1.2,
				radius: 2 + Math.random() * 4.2,
				color: palette[i % palette.length],
				alpha: 1,
				decay: 0.016 + Math.random() * 0.018,
				gravity: 0.08
			});
		}
	}

	addBanner(x: number, y: number, text: string, color: string): void {
		this.banners.push({
			id: `${Date.now()}_${Math.random()}`,
			x,
			y,
			vy: -1.35,
			text,
			color,
			alpha: 1,
			scale: 1
		});
	}

	stepAndDraw(ctx: CanvasRenderingContext2D, width: number, height: number): void {
		ctx.clearRect(0, 0, width, height);

		for (let i = this.particles.length - 1; i >= 0; i--) {
			const p = this.particles[i];
			p.x += p.vx;
			p.y += p.vy;
			p.vy += p.gravity;
			p.alpha -= p.decay;

			if (p.alpha <= 0) {
				this.particles.splice(i, 1);
				continue;
			}

			ctx.save();
			ctx.globalAlpha = Math.max(0, p.alpha);
			ctx.fillStyle = p.color;
			ctx.shadowColor = p.color;
			ctx.shadowBlur = 10;
			ctx.beginPath();
			ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}

		for (let i = this.banners.length - 1; i >= 0; i--) {
			const b = this.banners[i];
			b.y += b.vy;
			b.alpha -= 0.014;
			if (b.alpha <= 0) {
				this.banners.splice(i, 1);
				continue;
			}

			ctx.save();
			ctx.globalAlpha = Math.max(0, b.alpha);
			ctx.font = 'bold 18px "JetBrains Mono", monospace';
			ctx.textAlign = 'center';
			ctx.fillStyle = '#111013';
			ctx.fillText(b.text, b.x + 2, b.y + 2);
			ctx.fillStyle = b.color;
			ctx.shadowColor = b.color;
			ctx.shadowBlur = 12;
			ctx.fillText(b.text, b.x, b.y);
			ctx.restore();
		}
	}
}
