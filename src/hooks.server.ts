import { svelteKitHandler } from "better-auth/svelte-kit"
import { building } from "$app/env"
import { auth } from "./auth"
import type { Handle } from "@sveltejs/kit/hooks"

export const handle: Handle = ({ event, resolve }) =>
	svelteKitHandler({ auth, event, resolve, building })
