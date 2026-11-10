import type { Reroute } from '@sveltejs/kit/hooks';
import { rerouteUrl } from './lib/apps.ts';

export const reroute: Reroute = ({ url }) => rerouteUrl(url);
